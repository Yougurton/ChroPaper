/**
 * Other names of the same song, for sync mode's BeatSaver search.
 *
 * Japanese songs are often called one thing by the player and another on BeatSaver: the player
 * reports "ラビットホール", the maps are all "Rabbit Hole" (DECO*27), and the other way round. The
 * iTunes catalog knows both — its search finds a song by either name, and each storefront returns
 * the song under its local name (the Japanese store says "ラビットホール", the US one "Rabbit Hole").
 * So: find the song in the Japanese store, look the same tracks up in the US store, and hand both
 * names back to try on BeatSaver.
 *
 * Only tracks whose artist matches the player's (under either store's name) count — the search
 * results also hold covers — and that are the song asked about: one of their names contains the
 * title searched for or the other way round, or failing that the length matches. The length alone
 * isn't required (a TV-size opening has the same names as the full song); it also puts the
 * closest tracks first.
 *
 * Also here: nameVariants, which digs the actual song out of video-style titles.
 */
import { cleanArtist, itunesRequest, type ItunesResult } from './cover-lookup';

export interface TrackName {
  title: string;
  artist: string;
}

const STORE_SEARCH = 'jp';
const STORE_LOOKUP = 'us';
const SEARCH_LIMIT = 10;
const MAX_TRACKS = 3;
const DURATION_TOLERANCE_SECONDS = 4;
const cache = new Map<string, TrackName[]>();

function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word !== '');
}

function artistOverlaps(mediaArtist: string, names: (string | undefined)[]): boolean {
  const wanted = new Set(words(mediaArtist));
  if (wanted.size === 0) return false;
  return names.some((name) => name !== undefined && words(name).some((word) => wanted.has(word)));
}

/** Requests already made this session (the same title is often looked up for several variants). */
const requests = new Map<string, Promise<ItunesResult[]>>();
function cachedRequest(url: string): Promise<ItunesResult[]> {
  let request = requests.get(url);
  if (request === undefined) {
    request = itunesRequest(url);
    requests.set(url, request);
    request.catch(() => requests.delete(url)); // a failure may not repeat: don't keep it
  }
  return request;
}

/** One Apple search for `term`, and the names of the tracks in it that are the song asked about. */
async function namesFromSearch(
  term: string,
  title: string,
  cleanedArtist: string,
  durationSeconds: number | null,
): Promise<TrackName[]> {
  const names: TrackName[] = [];
  const found = await cachedRequest(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${STORE_SEARCH}&entity=song&limit=${String(SEARCH_LIMIT)}`,
  );
  const lengthFits = (result: ItunesResult) =>
    durationSeconds !== null &&
    typeof result.trackTimeMillis === 'number' &&
    Math.abs(result.trackTimeMillis / 1000 - durationSeconds) <= DURATION_TOLERANCE_SECONDS;
  const candidates = found
    .filter((result) => typeof result.trackId === 'number')
    .sort((a, b) => Number(lengthFits(b)) - Number(lengthFits(a)));
  if (candidates.length > 0) {
    const ids = candidates.map((result) => String(result.trackId));
    const localized = await cachedRequest(`https://itunes.apple.com/lookup?id=${ids.join(',')}&country=${STORE_LOOKUP}&entity=song`);
    const byId = new Map(localized.map((result) => [result.trackId, result]));
    const seen = new Set([`${words(title).join(' ')}|${words(cleanedArtist).join(' ')}`]);
    const wantedTitle = words(title).join(' ');
    const related = (name: string | undefined) => {
      const candidate = words(name ?? '').join(' ');
      return candidate !== '' && (` ${candidate} `.includes(` ${wantedTitle} `) || ` ${wantedTitle} `.includes(` ${candidate} `));
    };
    const byArtist = candidates.filter((result) => {
      const other = byId.get(result.trackId);
      return (
        artistOverlaps(cleanedArtist, [result.artistName, other?.artistName]) &&
        (related(result.trackName) || related(other?.trackName) || lengthFits(result))
      );
    });
    // No track by that artist: the most relevant one titled exactly like the query and of the
    // right length still counts — the "artist" is often just a singer credit or a channel
    // ("テトリス / 重音テトSV" is 柊マグネタイト's song, sung by Kasane Teto).
    const exactTitle = candidates.find(
      (result) => lengthFits(result) && words(result.trackName ?? '').join(' ') === wantedTitle,
    );
    const accepted = byArtist.length > 0 ? byArtist.slice(0, MAX_TRACKS) : exactTitle === undefined ? [] : [exactTitle];
    for (const result of accepted) {
      for (const name of [result, byId.get(result.trackId)]) {
        if (name?.trackName === undefined || name.artistName === undefined) continue;
        const id = `${words(name.trackName).join(' ')}|${words(name.artistName).join(' ')}`;
        if (seen.has(id)) continue;
        seen.add(id);
        names.push({ title: name.trackName, artist: name.artistName });
      }
    }
  }
  return names;
}

/** The song's names in the other store(s), not counting the one the player already reported. */
export async function alternateTrackNames(title: string, artist: string, durationSeconds: number | null): Promise<TrackName[]> {
  const cleanedArtist = cleanArtist(artist);
  const key = `${title}|${cleanedArtist}|${durationSeconds === null ? '' : String(Math.round(durationSeconds))}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let names: TrackName[] = [];
  try {
    // Without "feat." credits: they make Apple's search prefer odd versions of the song.
    const withoutCredits = (text: string) => text.replace(/\s*\b(?:feat|ft)\b\.?.*$/iu, '');
    // Title + artist first; if that finds nothing usable (the "artist" may be a channel or a singer
    // credit Apple doesn't list, which empties the results), the title alone.
    for (const term of [`${withoutCredits(title)} ${withoutCredits(cleanedArtist)}`.trim(), withoutCredits(title).trim()]) {
      names = await namesFromSearch(term, title, cleanedArtist, durationSeconds);
      if (names.length > 0) break;
    }
  } catch (error) {
    console.warn('[wallpaper] sync: looking up other names of the song failed', error);
    return []; // not cached: may work next time
  }
  cache.set(key, names);
  return names;
}

// ----- video-style titles ------------------------------------------------------------------------

// Quoted song titles: 「アイドル」, 『...』, "...", “...”.
const QUOTED = /「([^」]+)」|『([^』]+)』|"([^"]+)"|“([^”]+)”/gu;
// Bracketed extras: 【推しの子】, [MV], (Official Video), （TV size）.
const BRACKETED = /【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）|〔[^〕]*〕/gu;
// Segment separators in "Artist - Title | Channel"-style titles.
const SEPARATORS = /\s+[-–—~〜]\s+|\s*[|｜/／]\s*|(?<!\d)\s*[:：]\s*(?!\d)/u;
const HASHTAG = /#([^\s#]+)/gu;
// Singing voices (Vocaloid, UTAU, Synthesizer V, CeVIO…) that titles credit next to the song.
const SINGER =
  /初音ミク|重音テト|鏡音(?:リン|レン)|巡音ルカ|\bmeiko\b|\bkaito\b|\bgumi\b|\bia\b|可不|\bkafu\b|星界|裏命|知声|結月ゆかり|紲星あかり|音街ウナ|歌愛ユキ|小春六花|夏色花梨|ずんだもん|vocaloid|utau|cevio|synthesizer ?v|\bsv\b|hatsune miku|kasane teto|kagamine|megurine/iu;
// Hashtags that describe the video, not who made the song.
const JUNK_HASHTAG = /^(?:shorts?|anime|アニメ|music|mv|pv|jpop|j-pop|vocaloid|ボカロ|cover|歌ってみた|op|ed|lyrics?|fyp|viral)$/iu;
// Words that describe the video rather than name the song.
const NOISE =
  /ノンクレジット|クレジットなし|オープニング|エンディング|主題歌|挿入歌|テーマ(?:ソング)?|公式|(?:tv ?)?アニメ|映像|歌ってみた|\btv\b|non[- ]?credit(?:ed)?|creditless|official|music ?video|lyrics?(?: video)?|full ver(?:sion)?\.?|tv ?(?:size|ver(?:sion)?\.?)|opening(?: theme)?|ending(?: theme)?|romaji|kanji|歌詞|(?:eng(?:lish)?|rus|esp) ?subs?|subbed|legendado|перевод|\b(?:op|ed)\s*\d+\b|\b(?:mv|pv|op|ed|amv|hd|hq|4k)\d*\b/giu;

/** A part of the title that is nothing but singing voices ("重音テトSV", "feat. 初音ミク & GUMI") —
 *  not one that merely credits one ("ラビットホール feat. 初音ミク" is the song). */
function isSingerCredit(text: string): boolean {
  if (!SINGER.test(text)) return false;
  const rest = text.replace(new RegExp(SINGER.source, 'giu'), ' ').replace(/\b(?:feat|ft|cv)\b\.?|[&,、×+]|\bx\b/giu, ' ');
  return words(rest).length === 0;
}

function tidy(text: string): string {
  return text.replace(NOISE, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–—|｜:：]+|[\s\-–—|｜:：]+$/gu, '').trim();
}

/**
 * The song's likely (title, artist) inside a video-style title such as
 * "【推しの子】ノンクレジットオープニング｜YOASOBI「アイドル」" — besides the player's own
 * (title, artist), which is always first. What's tried, in order:
 * - a quoted title (「アイドル」), with whatever stands right before the quotes as the artist
 *   ("YOASOBI「アイドル」"), else the player's artist — the last quote first;
 * - "Artist - Title" (and, as a fallback, the reverse), once bracketed extras and words about the
 *   video itself ("non-credit opening", "Official MV", "TV size", 公式…) are removed;
 * - the title with just those extras removed.
 * A hashtag ("#結束バンド") or a bracket that isn't about the video ("[吉田夜世]") stands in for
 * the artist wherever the title itself doesn't name one.
 */
export function nameVariants(title: string, artist: string): TrackName[] {
  const cleanedArtist = cleanArtist(artist);
  const normalized = title.normalize('NFKC');
  // Hashtags ("#結束バンド") are often the artist, the channel being the label or the show's own;
  // they're taken out of the title and used as the artist where the title doesn't name one.
  const hashtags = [...normalized.matchAll(HASHTAG)]
    .map((match) => match[1] ?? '')
    .filter((tag) => tag !== '' && !JUNK_HASHTAG.test(tag));
  const source = normalized.replace(HASHTAG, ' ');
  // A bracket that isn't just about the video ("[吉田夜世]" — unlike "【MV】" or "(Lyrics)") often
  // holds the artist too.
  const bracketed = [...source.matchAll(BRACKETED)]
    .map((match) => tidy(match[0].slice(1, -1)))
    // (not a credit like "(feat. Hatsune Miku)" — that's who sings, not whose song it is)
    .filter((text) => text !== '' && !/^(?:feat|ft|cv)\b/iu.test(text) && !isSingerCredit(text));
  const namedArtist = hashtags[0] ?? bracketed.at(-1);
  const fallbackArtist = namedArtist ?? cleanedArtist;
  const variants: TrackName[] = [{ title, artist: cleanedArtist }];
  const add = (variantTitle: string, variantArtist: string) => {
    const t = tidy(variantTitle.replace(/\s*\b(?:feat|ft)\b\.?.*$/iu, '')); // credits belong to the artist
    const a = tidy(variantArtist) || fallbackArtist;
    if (t === '' || words(t).length === 0) return;
    const id = `${words(t).join(' ')}|${words(a).join(' ')}`;
    if (variants.some((v) => `${words(v.title).join(' ')}|${words(v.artist).join(' ')}` === id)) return;
    variants.push({ title: t, artist: a });
  };

  // Last quote first: a title like TVアニメ「チェンソーマン」…米津玄師「KICK BACK」 names the show
  // before the song.
  for (const match of [...source.matchAll(QUOTED)].reverse()) {
    const quoted = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    const before = source.slice(0, match.index).replace(BRACKETED, ' ').split(SEPARATORS).pop() ?? '';
    add(quoted, before);
  }
  const unbracketed = source.replace(QUOTED, ' ').replace(BRACKETED, ' ');
  const segments = unbracketed
    .split(SEPARATORS)
    .map(tidy)
    .filter((segment) => segment !== '');
  // An artist named by a hashtag or bracket goes with each part of the title first
  // ("オーバーライド - 重音テトSV[吉田夜世]": "オーバーライド" by 吉田夜世).
  if (namedArtist !== undefined && segments.length >= 2) for (const segment of segments) add(segment, namedArtist);
  if (segments.length >= 2) {
    const [first = '', second = ''] = segments.slice(0, 2);
    // "Title / Artist" and "Artist - Title" both occur; the side sharing words with the player's
    // artist (often the channel name) is the artist. Without a hint, "Artist - Title" first.
    // A side naming a singing voice ("テトリス / 重音テトSV") is the singer, not the songwriter the
    // maps are usually credited to: the other side is the title, and the channel is tried as the
    // artist first.
    const artistWords = new Set(words(cleanedArtist));
    const firstIsArtist = words(first).some((word) => artistWords.has(word));
    const secondIsArtist = words(second).some((word) => artistWords.has(word));
    const firstIsSinger = isSingerCredit(first);
    const secondIsSinger = isSingerCredit(second);
    if (secondIsSinger && !firstIsSinger) {
      add(first, cleanedArtist);
      add(first, second);
      add(second, first);
    } else if (firstIsSinger && !secondIsSinger) {
      add(second, cleanedArtist);
      add(second, first);
      add(first, second);
    } else if (secondIsArtist && !firstIsArtist) {
      add(first, second);
      add(second, first);
    } else {
      add(second, first);
      add(first, second);
    }
    // Longer titles ("Platinum Disco - Nisemonogatari OP 3 | 白金ディスコ - 偽物語"): every part is a
    // possible song title on its own, often the same song in two languages.
    if (segments.length > 2) for (const segment of segments) add(segment, fallbackArtist);
  }
  if (!QUOTED.test(source) && segments.length < 2) add(source.replace(BRACKETED, ' '), fallbackArtist);
  QUOTED.lastIndex = 0; // (a /g regex keeps its position between test() calls)
  return variants.slice(0, 8);
}
