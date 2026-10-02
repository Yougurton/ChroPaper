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

/** The singers a track title credits: "マイマイマイ (买买买) [feat. 初音ミク]" → "初音ミク". */
function featuredIn(trackName: string | undefined): string | undefined {
  return /\b(?:feat|ft)\b\.?\s*([^)\]]+)/iu.exec(trackName ?? '')?.[1];
}

/** A track title without its extras ("(买买买)", "[feat. 初音ミク]", "(TV Size)"). */
function bareTitle(trackName: string | undefined): string {
  return words((trackName ?? '').replace(/\([^)]*\)|\[[^\]]*\]|（[^）]*）|\s*\b(?:feat|ft)\b\.?.*$/giu, ' ')).join(' ');
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
    // Compared without the extras in brackets and "feat." credits: "INTERNET ANGEL (feat. Aiobahn
    // +81)" isn't a song called "Aiobahn +81".
    const related = (name: string | undefined) => {
      const candidate = bareTitle(name);
      return candidate !== '' && (` ${candidate} `.includes(` ${wantedTitle} `) || ` ${wantedTitle} `.includes(` ${candidate} `));
    };
    const titleRelated = (result: ItunesResult) => related(result.trackName) || related(byId.get(result.trackId)?.trackName);
    const byArtistAny = candidates.filter((result) => {
      const other = byId.get(result.trackId);
      const titleRelated = related(result.trackName) || related(other?.trackName);
      if (artistOverlaps(cleanedArtist, [result.artistName, other?.artistName])) return titleRelated || lengthFits(result);
      // A player/channel crediting the singer ("初音ミク - マイマイマイ") matches the song's
      // "feat. 初音ミク" too — but only with the title matching: a singer sings far too many songs
      // for the length alone to pick the right one.
      return artistOverlaps(cleanedArtist, [featuredIn(result.trackName), featuredIn(other?.trackName)]) && titleRelated;
    });
    // The length alone only decides when no track's title fits: a prolific artist has other songs
    // of about the same length ("モニタリング" by DECO*27 also brought up ヴァンパイア, 3 minutes
    // too, and with it the wrong map).
    const byArtistRelated = byArtistAny.filter(titleRelated);
    const byArtist = byArtistRelated.length > 0 ? byArtistRelated : byArtistAny;
    // No track by that artist: the most relevant one titled exactly like the query and of the
    // right length still counts — the "artist" is often just a singer credit or a channel
    // ("テトリス / 重音テトSV" is 柊マグネタイト's song, sung by Kasane Teto).
    const exactTitle = candidates.find(
      (result) =>
        lengthFits(result) &&
        (words(result.trackName ?? '').join(' ') === wantedTitle || bareTitle(result.trackName) === bareTitle(title)),
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
// Names found are also kept across sessions (localStorage): Apple's API doesn't always answer
// (timeouts, rate limits), and a lookup that once worked shouldn't have to work again for the song
// to find its best map. "No other names" is only kept for a day, in case that was a fluke.
const NAMES_STORAGE_KEY = 'chropaper.altNames';
const MAX_STORED_NAMES = 300;
const EMPTY_NAMES_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 1500;

type StoredNames = Record<string, { names: TrackName[]; at: number }>;

function loadStoredNames(): StoredNames {
  try {
    const raw = window.localStorage.getItem(NAMES_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as StoredNames) : {};
  } catch {
    return {};
  }
}

function storedNames(key: string): TrackName[] | undefined {
  const record = loadStoredNames()[key];
  if (record === undefined || !Array.isArray(record.names) || typeof record.at !== 'number') return undefined;
  if (record.names.length === 0 && Date.now() - record.at > EMPTY_NAMES_MAX_AGE_MS) return undefined;
  const names = record.names.filter(
    (name): name is TrackName => typeof name === 'object' && typeof name.title === 'string' && typeof name.artist === 'string',
  );
  return names;
}

function storeNames(key: string, names: TrackName[]) {
  try {
    const store = loadStoredNames();
    store[key] = { names, at: Date.now() };
    const keys = Object.keys(store);
    if (keys.length > MAX_STORED_NAMES) {
      keys
        .sort((a, b) => (store[a]?.at ?? 0) - (store[b]?.at ?? 0))
        .slice(0, keys.length - MAX_STORED_NAMES)
        .forEach((old) => delete store[old]);
    }
    window.localStorage.setItem(NAMES_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // storage unavailable: the session cache still has them
  }
}

/** The song's names in other languages (see namesFromSearch) — [] when there are none, null when
 *  Apple couldn't be asked (twice), so the caller knows the search wasn't complete. */
export async function alternateTrackNames(title: string, artist: string, durationSeconds: number | null): Promise<TrackName[] | null> {
  const cleanedArtist = cleanArtist(artist);
  const key = `${title}|${cleanedArtist}|${durationSeconds === null ? '' : String(Math.round(durationSeconds))}`;
  const cached = cache.get(key) ?? storedNames(key);
  if (cached !== undefined) return cached;

  // Without "feat." credits: they make Apple's search prefer odd versions of the song.
  const withoutCredits = (text: string) => text.replace(/\s*\b(?:feat|ft)\b\.?.*$/iu, '');
  const lookUp = async () => {
    let names: TrackName[] = [];
    // Title + artist first; if that finds nothing usable (the "artist" may be a channel or a singer
    // credit Apple doesn't list, which empties the results), the title alone.
    for (const term of [`${withoutCredits(title)} ${withoutCredits(cleanedArtist)}`.trim(), withoutCredits(title).trim()]) {
      names = await namesFromSearch(term, title, cleanedArtist, durationSeconds);
      if (names.length > 0) break;
    }
    return names;
  };
  let names: TrackName[];
  try {
    names = await lookUp();
  } catch (error) {
    console.warn('[wallpaper] sync: looking up other names of the song failed, trying once more', error);
    await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAY_MS));
    try {
      names = await lookUp();
    } catch (retryError) {
      console.warn('[wallpaper] sync: looking up other names of the song failed again', retryError);
      return null; // not cached: may work next time
    }
  }
  cache.set(key, names);
  storeNames(key, names);
  return names;
}

// ----- video-style titles ------------------------------------------------------------------------

// Quoted song titles: 「アイドル」, 『...』, "...", “...”.
const QUOTED = /「([^」]+)」|『([^』]+)』|"([^"]+)"|“([^”]+)”/gu;
// Bracketed extras: 【推しの子】, [MV], (Official Video), （TV size）.
const BRACKETED = /【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）|〔[^〕]*〕/gu;
// A bracket naming the song's version ("(VIP)", "[Remix]", "(Live)") stays with the title: the
// search tells the versions apart by it (see titleMatchLevel in beatsaver-search.ts).
const VERSION_TAG = /\b(?:vip|remix|rmx|edit|bootleg|flip|rework|cover|nightcore|sped ?up|slowed|instrumental|acoustic|live|remaster(?:ed)?)\b|リミックス|アレンジ|カバー/iu;
const keepVersionBrackets = (text: string) => text.replace(BRACKETED, (bracket) => (VERSION_TAG.test(bracket) ? ` ${bracket} ` : ' '));
const SQUARE_BRACKETED = /【[^】]*】|\[[^\]]*\]|〔[^〕]*〕/gu;
// Segment separators in "Artist - Title | Channel"-style titles.
// (Also "P丸様。- 天天天国地獄国": a dash with a space only after it, right after the artist.)
const SEPARATORS = /\s+[-–—~〜]\s+|(?<=[^\s\-–—])[-–—]\s+(?=\S)|\s*[|｜/／]\s*|(?<!\d)\s*[:：]\s*(?!\d)/u;
const HASHTAG = /#([^\s#]+)/gu;
// Singing voices (Vocaloid, UTAU, Synthesizer V, CeVIO…) that titles credit next to the song.
const SINGER =
  /初音ミク|重音テト|鏡音(?:リン|レン)|巡音ルカ|\bmeiko\b|\bkaito\b|\bgumi\b|\bia\b|可不|\bkafu\b|星界|裏命|知声|結月ゆかり|紲星あかり|音街ウナ|歌愛ユキ|小春六花|夏色花梨|ずんだもん|vocaloid|utau|cevio|synthesizer ?v|\bsv\b|hatsune miku|kasane teto|kagamine|megurine/iu;
// Hashtags that describe the video, not who made the song.
const JUNK_HASHTAG = /^(?:shorts?|anime|アニメ|music|mv|pv|jpop|j-pop|vocaloid|ボカロ|cover|歌ってみた|op|ed|lyrics?|fyp|viral)$/iu;
// Words that describe the video rather than name the song.
const NOISE =
  /ノンクレジット|クレジットなし|オープニング|エンディング|主題歌|挿入歌|テーマ(?:ソング)?|公式|(?:tv ?)?アニメ|映像|歌ってみた|踊ってみた|ダンス(?:ビデオ|動画|ver\.?|バージョン)|dance ?(?:video|ver(?:sion)?\.?)|\btv\b|non[- ]?credit(?:ed)?|creditless|official|music ?video|lyrics?(?: video)?|full ver(?:sion)?\.?|tv ?(?:size|ver(?:sion)?\.?)|opening(?: theme)?|ending(?: theme)?|romaji|kanji|歌詞|(?:eng(?:lish)?|rus|esp) ?subs?|subbed|legendado|перевод|\b(?:op|ed)\s*\d+\b|\b(?:mv|pv|op|ed|amv|hd|hq|4k)\d*\b/giu;

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
  // A bracket that isn't just about the video ("[吉田夜世]" — unlike "【MV】" or "[Lyrics]") often
  // holds the artist too. Not round ones: "マイマイマイ (买买买)" gives the song's name in another
  // language, "(Official Video)" is about the video — neither is who made the song.
  const bracketed = [...source.matchAll(SQUARE_BRACKETED)]
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
    // Just the artist again ("Aiobahn +81" by Aiobahn +81): not a song title.
    const artistWords = new Set(words(a));
    if (words(t).every((word) => artistWords.has(word))) return;
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
  const unbracketed = keepVersionBrackets(source.replace(QUOTED, ' '));
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
