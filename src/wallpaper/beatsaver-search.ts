import { z } from 'zod';

import { env } from '../env';
import { isGLSCapableEnvironment, isKnownEnvironmentId } from '../renderer/environment/environment-catalog';
import { fetchBeatSaverHash } from '../sources/beatsaver/provider';
import { requestJson } from '../sources/http';
import { browserMapArchiveCache } from '../sources/map-archive-cache';
import type { MapSourceFile } from '../sources/source-types';
import { hasOnlyKana, toRomaji } from './kana';

/**
 * BeatSaver side of sync mode: finds the map for the track playing on the PC (searchBeatSaverForTrack)
 * and downloads it (loadBeatSaverMap), through the map cache.
 */

export interface BeatSaverMapEntry {
  hash: string;
  mapId: string;
  title: string;
  author: string;
  mapper: string;
  coverUrl: string | null;
  environmentSupported: boolean;
  usesChroma: boolean;
  usesNoodleExtensions: boolean;
  mightUseGLS: boolean;
}

interface ApiDiff {
  environment?: string;
  chroma?: boolean;
  ne?: boolean;
  vivify?: boolean;
  events?: number;
  seconds?: number;
}

/** The difficulty with the most lighting events (later ones win ties, i.e. usually the hardest) —
 *  what the map's lightshow is judged by. Plain "last difficulty" was wrong for maps like [JSaB
 *  Pack] Cheat Codes, whose last difficulties are "Lawless" ones with no lighting at all. */
function lightshowDiff<T extends ApiDiff>(diffs: readonly T[] | undefined): T | undefined {
  let best: T | undefined;
  for (const diff of diffs ?? []) {
    if (best === undefined || (diff.events ?? 0) >= (best.events ?? 0)) best = diff;
  }
  return best;
}

const mapPageSchema = z.object({
  docs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      curatedAt: z.string().nullish(),
      automapper: z.boolean().nullish(),
      uploader: z.object({ verifiedMapper: z.boolean().nullish() }).nullish(),
      stats: z.object({ score: z.number().optional(), upvotes: z.number().optional() }).optional(),
      metadata: z.object({
        songName: z.string(),
        songSubName: z.string(),
        songAuthorName: z.string(),
        levelAuthorName: z.string(),
        duration: z.number().optional(),
      }),
      versions: z.array(
        z.object({
          hash: z.hash('sha1'),
          coverURL: z.string().optional(),
          diffs: z
            .array(z.object({
                environment: z.string().optional(),
                chroma: z.boolean().optional(),
                ne: z.boolean().optional(),
                vivify: z.boolean().optional(),
                events: z.number().optional(),
                seconds: z.number().optional(),
              }))
            .optional(),
        }),
      ),
    }),
  ),
});

type MapDoc = z.infer<typeof mapPageSchema>['docs'][number];

/** Whether the viewer can show this map: a known environment and no Vivify (custom shaders/prefabs
 *  ChroViewer can't run) — the same rule parse-map-package.ts applies once it's downloaded. */
function isSupportedDoc(doc: MapDoc): boolean {
  const lastDiff = lightshowDiff(doc.versions.at(0)?.diffs);
  const lastEnvironment = lastDiff?.environment;
  return (lastEnvironment === undefined || isKnownEnvironmentId(lastEnvironment)) && lastDiff?.vivify !== true;
}

/** Lighting events per second below which a map counts as having no lightshow (one stray event
 *  in a 2:20 song isn't one); never fewer than 10 events. */
const MIN_LIGHT_EVENTS_PER_SECOND = 0.1;

/** Whether the map has a lightshow to show — as far as BeatSaver's stats tell: they count classic
 *  events only, so a map on a GLS-capable environment with none may still have a v3 lightshow and
 *  gets the benefit of the doubt (it's checked again once downloaded). */
function hasLightshowDoc(doc: MapDoc): boolean {
  const diffs = doc.versions.at(0)?.diffs ?? [];
  const seconds = Math.max(doc.metadata.duration ?? 0, 30);
  const minEvents = Math.max(10, seconds * MIN_LIGHT_EVENTS_PER_SECOND);
  return diffs.some(
    (diff) => (diff.events ?? 0) >= minEvents || (diff.environment !== undefined && isGLSCapableEnvironment(diff.environment)),
  );
}

function beatSaverEntryFromDoc(doc: MapDoc): BeatSaverMapEntry | null {
  const version = doc.versions.at(0);
  if (version === undefined) return null;
  const title = [doc.metadata.songName, doc.metadata.songSubName].filter((part) => part.length > 0).join(' ');
  const lastDiff = lightshowDiff(version.diffs);
  const lastEnvironment = lastDiff?.environment;
  return {
    hash: version.hash.toLowerCase(),
    mapId: doc.id,
    title: title.length > 0 ? title : doc.name,
    author: doc.metadata.songAuthorName,
    mapper: doc.metadata.levelAuthorName,
    coverUrl: version.coverURL ?? null,
    environmentSupported: isSupportedDoc(doc),
    usesChroma: lastDiff?.chroma ?? false,
    usesNoodleExtensions: lastDiff?.ne ?? false,
    mightUseGLS: lastEnvironment !== undefined && isGLSCapableEnvironment(lastEnvironment),
  };
}

/** A "V3/Noodle" map (see the "Also V3/Noodle maps" sync setting): its environment supports V3
 *  (GLS) lighting, or it uses Noodle Extensions. */
function isRichEnvironmentDoc(doc: MapDoc) {
  const diffs = doc.versions.at(0)?.diffs;
  const environment = lightshowDiff(diffs)?.environment;
  return (environment !== undefined && isGLSCapableEnvironment(environment)) || (diffs?.some((diff) => diff.ne === true) ?? false);
}

const savedMapEntrySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{40}$/),
  mapId: z.string(),
  title: z.string(),
  author: z.string(),
  mapper: z.string(),
  coverUrl: z.string().nullable(),
  environmentSupported: z.boolean(),
  usesChroma: z.boolean(),
  usesNoodleExtensions: z.boolean(),
  mightUseGLS: z.boolean(),
});

/** Map entries saved by sync-memory.ts — anything malformed is dropped. */
export function parseSavedMapEntries(raw: readonly unknown[]): BeatSaverMapEntry[] {
  const entries: BeatSaverMapEntry[] = [];
  for (const item of raw) {
    const parsed = savedMapEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

/** One map of the song, as listed under "Other versions" in the player. */
export interface MapVersion extends BeatSaverMapEntry {
  /** The map's length in seconds (BeatSaver's metadata), null if it doesn't say. */
  duration: number | null;
  /** Its length is off the player's: a map of another edit of the song (see differentEdit). */
  differentEdit: boolean;
  /** Why the search wouldn't pick it on its own: an environment the viewer can't show (it plays
   *  in the default one), or a V3/Noodle map while those are turned off in the settings. */
  excluded: 'unsupported' | 'rich' | null;
}

const savedMapVersionSchema = savedMapEntrySchema.extend({
  duration: z.number().nullable(),
  differentEdit: z.boolean(),
  excluded: z.enum(['unsupported', 'rich']).nullable(),
});

/** Map versions saved by sync-memory.ts — anything malformed is dropped. */
export function parseSavedMapVersions(raw: readonly unknown[]): MapVersion[] {
  const versions: MapVersion[] = [];
  for (const item of raw) {
    const parsed = savedMapVersionSchema.safeParse(item);
    if (parsed.success) versions.push(parsed.data);
  }
  return versions;
}

/** How many maps of a song the player's "Other versions" list shows at most. */
export const MAX_MAP_VERSIONS = 10;

export interface BeatSaverSearchResult {
  entry: BeatSaverMapEntry;
  /** Whether the match was confirmed by duration — false when the media player hadn't reported
   *  one, so the pick rests on the title match alone (see searchBeatSaverForTrack). */
  durationConfirmed: boolean;
  /** The map is of the same song but a different edit (its length is far off the player's) —
   *  e.g. a radio edit mapped while the album version is playing. The reported position then says
   *  nothing about where in the map we are; sync has to find that from the audio alone. */
  differentEdit: boolean;
}

export interface BeatSaverSearchOutcome {
  /** The map to sync to — null when nothing playable turned up. */
  best: BeatSaverSearchResult | null;
  /** Every map found of the song, best first (up to MAX_MAP_VERSIONS): the one picked, the others
   *  that would do, other edits, and those the search wouldn't pick on its own (an unsupported
   *  environment, V3/Noodle turned off) — for the player's "Other versions" list. */
  versions: MapVersion[];
  /** False when part of the search couldn't be done (the song's other names couldn't be looked
   *  up): a better map may have been missed, so the result shouldn't be remembered for good. */
  complete: boolean;
}

/** "How good is this map" — the tie-breaker among candidates that already passed the song-identity
 *  checks in searchBeatSaverForTrack (0-80). Raw lighting-event density turned out to be a weak
 *  signal on its own (a quickly-lit map can easily out-count a carefully lit one: for "Spoken For",
 *  SaltedQuackers' 4.5k events beat Zelazowa's curated 3.2k), so it's only one part of it:
 *  - lighting-event density of the difficulty that will be shown: up to 15. BeatSaver only counts
 *    classic events, so a GLS map (v3 light event box groups — e.g. Alice's "1-800" on Collider,
 *    ~8.6k box groups and 0 classic events) would score 0 here despite having the richest show of
 *    all; on a GLS-capable environment with no classic events the density is unknown rather than
 *    zero, and gets full credit.
 *  - Chroma / GLS-capable environment: 10 each (both take deliberate lighting work)
 *  - curated: 15, verified mapper: 5 — BeatSaver's own quality signals
 *  - rating (0-1): up to 10, number of upvotes (log scale): up to ~18
 *  - automapped: -30 */
function scoreByLightshowRichness(doc: MapDoc): number {
  const diff = lightshowDiff(doc.versions.at(0)?.diffs);
  let score = 0;
  if (diff !== undefined) {
    const seconds = diff.seconds !== undefined && diff.seconds > 0 ? diff.seconds : (doc.metadata.duration ?? 0);
    const glsCapable = diff.environment !== undefined && isGLSCapableEnvironment(diff.environment);
    const eventsPerSecond = seconds > 0 ? (diff.events ?? 0) / seconds : 0;
    score += glsCapable && (diff.events ?? 0) === 0 ? 15 : Math.min(eventsPerSecond, 60) * 0.25;
    if (diff.chroma === true) score += 10;
    if (glsCapable) score += 10;
  }
  if (doc.curatedAt !== null && doc.curatedAt !== undefined) score += 15;
  if (doc.uploader?.verifiedMapper === true) score += 5;
  if (doc.automapper === true) score -= 30;
  score += (doc.stats?.score ?? 0) * 10;
  score += Math.min(Math.log10(1 + (doc.stats?.upvotes ?? 0)) * 6, 18);
  return score;
}

/** Lowercases and strips everything that commonly differs between a streaming service's title and
 *  a BeatSaver map's for the very same song: bracketed extras ("(Official Video)", "[Free DL]",
 *  "(Extended Mix)"), "feat./ft./prod." credits, punctuation and full-width forms. What's left is a
 *  space-separated run of words that can be compared word-by-word. */
function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, ' ')
    .replace(/\b(?:feat|ft|prod)\b\.?.*$/u, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Japanese written in Latin letters has competing spellings: Apple lists "seisyun complex"
 *  (Kunrei-shiki), BeatSaver maps say "Seishun Complex" (Hepburn). This rewrites the Kunrei and
 *  Nihon-shiki spellings into Hepburn ("sy" → "sh", "ty" → "ch", "zy" → "j", "si" → "shi", "ti" →
 *  "chi", "tu" → "tsu", "zi" → "ji"); applied to a normalized string, whole words only unchanged
 *  apart from that. Used for search queries. */
function toHepburn(normalized: string): string {
  return normalized
    .replace(/sy(?=[aueo])/g, 'sh')
    .replace(/ty(?=[aueo])/g, 'ch')
    .replace(/[zj]y(?=[aueo])/g, 'j')
    .replace(/si/g, 'shi')
    .replace(/ti/g, 'chi')
    .replace(/tu/g, 'tsu')
    .replace(/zi/g, 'ji');
}

/** A comparison key that also ignores how long vowels were written ("ō", "ou", "oo" → "o", "uu"
 *  → "u") on top of toHepburn — for comparing titles, never shown or searched for. Applied to both
 *  sides, so an English title still only equals itself. */
function romajiKey(normalized: string): string {
  return toHepburn(
    normalized
      .replace(/[āâ]/g, 'a')
      .replace(/[īî]/g, 'i')
      .replace(/[ūû]/g, 'u')
      .replace(/[ēê]/g, 'e')
      .replace(/[ōô]/g, 'o'),
  )
    .replace(/o[ou]/g, 'o')
    .replace(/uu/g, 'u');
}

/** Whether `inner`'s words appear, in order and as whole words, somewhere inside `outer`. */
function containsWords(outer: string, inner: string): boolean {
  if (outer === '' || inner === '') return false;
  return ` ${outer} `.includes(` ${inner} `);
}

/** 3 = same title; 2 = same song name, but the map adds a subtitle the player doesn't have (often
 *  a different version — "Cheat Codes" + "VIP"); 1 = one title merely contains the other ("Coast"
 *  vs "West Coast"); 0 = no match. Players that put the artist into the title ("Dxrk - RAVE") are
 *  handled by stripping artist words from the player's title before comparing. */
/** normalizeForMatch, but keeping the words inside brackets: "Simulation (VIP)" → "simulation vip",
 *  so it equals a map whose subtitle says "VIP" without brackets. (Still without "feat." credits.) */
function normalizeKeepingBrackets(text: string): string {
  return normalizeForMatch(text.replace(/[()[\]【】（）]/g, ' ').replace(/\b(?:feat|ft|prod)\b\.?[^()[\]【】（）]*/giu, ' '));
}

function titleMatchLevel(doc: MapDoc, mediaTitle: string, mediaArtist: string): 0 | 1 | 2 | 3 {
  // Compared as romajiKey()s, so "seisyun complex" equals "Seishun Complex".
  const media = romajiKey(normalizeForMatch(mediaTitle));
  if (media === '') return 0;
  const artistWords = new Set(
    romajiKey(normalizeForMatch(`${mediaArtist} ${doc.metadata.songAuthorName}`))
      .split(' ')
      .filter((word) => word !== ''),
  );
  const strippedWords = media.split(' ').filter((word) => !artistWords.has(word));
  const mediaStripped = strippedWords.length > 0 ? strippedWords.join(' ') : media;
  // A title in kana also matches its romanization, spaces aside ("マイマイマイ" = "Mai Mai Mai").
  const spaceless = (text: string) => text.replace(/ /g, '');
  const kanaReading = hasOnlyKana(media) ? spaceless(romajiKey(toRomaji(media))) : null;
  const same = (name: string) =>
    name !== '' && (name === media || name === mediaStripped || (kanaReading !== null && spaceless(name) === kanaReading));
  const songName = romajiKey(normalizeForMatch(doc.metadata.songName));
  const fullName = romajiKey(normalizeForMatch(`${doc.metadata.songName} ${doc.metadata.songSubName}`));
  // The version in brackets counts on both sides: "Simulation (VIP)" is exactly "Simulation" +
  // "VIP" (and exactly "Simulation (VIP)"), but only a song-name match for the original "Simulation".
  // (Artist words left out here too: "Virtual Riot - Simulation (VIP)".)
  const mediaWithVersion = romajiKey(normalizeKeepingBrackets(mediaTitle));
  const versionWords = mediaWithVersion.split(' ').filter((word) => word !== '' && !artistWords.has(word));
  const mediaWithVersionStripped = versionWords.length > 0 ? versionWords.join(' ') : mediaWithVersion;
  const fullWithVersion = romajiKey(normalizeKeepingBrackets(`${doc.metadata.songName} ${doc.metadata.songSubName}`));
  if (mediaWithVersion !== media && (fullWithVersion === mediaWithVersion || fullWithVersion === mediaWithVersionStripped)) return 3;
  if (same(fullName)) return 3;
  if (same(songName)) return 2;
  if ([songName, fullName].some((name) => containsWords(media, name) || containsWords(name, mediaStripped))) return 1;
  return 0;
}

/** An "artist" that is just a singing voice ("初音ミク") — a search for it finds thousands of maps. */
function isSingerOnly(normalizedArtist: string): boolean {
  return /^(?:初音ミク|重音テト(?:sv)?|鏡音(?:リン|レン)|巡音ルカ|gumi|ia|kaito|meiko|hatsune miku|kasane teto)$/u.test(normalizedArtist);
}

function artistMatches(doc: MapDoc, mediaArtist: string, mediaTitle: string): boolean {
  const mapArtistWords = new Set(normalizeForMatch(doc.metadata.songAuthorName).split(' ').filter((word) => word.length >= 2));
  if (mapArtistWords.size === 0) return false;
  // The title is checked too because SoundCloud-style uploads often report the uploader as the
  // artist and put the real artist into the title ("Dxrk - RAVE").
  const mediaWords = normalizeForMatch(`${mediaArtist} ${mediaTitle}`).split(' ');
  return mediaWords.some((word) => mapArtistWords.has(word));
}

/**
 * "Sync mode" for listen mode: looks up whatever's currently playing on the PC on BeatSaver's text
 * search (the same endpoint the website's own search box uses) and returns the best match, or null
 * if nothing plausible turned up.
 *
 * Relevance order alone isn't trustworthy — "RAVE Dxrk ダーク" ranks the same artist's "BONES"
 * first — and neither is "same artist + similar length": prolific artists have dozens of 3-4 minute
 * songs ("Coast Waterflame" landed on Waterflame's "ThunderZone v2", while no map of "Coast"
 * exists at all). So the title always has to match:
 * - the same title (see titleMatchLevel) is enough on its own;
 * - a title that only contains / is contained in the other also needs the artist to match
 *   (otherwise "Coast" would happily pick OneRepublic's "West Coast");
 * - with a known duration, it must additionally be within DURATION_TOLERANCE_SECONDS.
 * Among the survivors the exact title wins (a map adding "VIP"/"Remix" ranks below one that
 * doesn't), then an artist match, then the richer lightshow (see scoreByLightshowRichness), then
 * BeatSaver's own relevance order.
 *
 * If no map has the right length, a map of a different edit of the same song still counts, as long
 * as both the song name and the artist match ("Let's Groove" is mapped as the 3:56 single, Apple
 * Music plays the 5:39 album version). Such a result is marked differentEdit. Nothing at all
 * means "not found" rather than a guess.
 *
 * Besides the player's own title and artist, `nameVariants` can supply what a video-style title
 * actually names ("【推しの子】ノンクレジットオープニング｜YOASOBI「アイドル」" → "アイドル" by
 * YOASOBI), and when none of those find a map, `alternateNames` the song's names in another
 * language ("アイドル" ↔ "Idol", "ラビットホール" ↔ "Rabbit Hole"; see track-names.ts). All of them
 * go through the very same search and checks.
 */
export async function searchBeatSaverForTrack(
  mediaTitle: string,
  mediaArtist: string,
  expectedDurationSeconds: number | null,
  excludeRichEnvironments = false,
  names?: {
    nameVariants?: (title: string, artist: string) => { title: string; artist: string }[];
    /** null: the names couldn't be looked up (the outcome is then marked incomplete). */
    alternateNames?: (title: string, artist: string) => Promise<{ title: string; artist: string }[] | null>;
  },
): Promise<BeatSaverSearchOutcome> {
  // Cleaned queries — BeatSaver's text search does poorly with "(Official Music Video)"-style noise
  // and channel names like "ImagineDragonsVEVO". "Title artist" first; if nothing plausible comes
  // back, the title alone (the artist field is often just an uploader/channel name).
  const queriesFor = (title: string, artist: string) => {
    const cleanTitle = normalizeForMatch(title);
    const cleanArtist = normalizeForMatch(artist);
    const queries = [`${cleanTitle} ${cleanArtist}`.trim(), cleanTitle];
    // A Kunrei-shiki romanization ("seisyun complex") also as the Hepburn spelling maps use —
    // only when it has a spelling no English word would ("sy", "ty", "zy" before a vowel), so
    // ordinary titles don't get a mangled extra query.
    if (/[stzj]y[aueo]/.test(cleanTitle)) {
      queries.splice(1, 0, `${toHepburn(cleanTitle)} ${toHepburn(cleanArtist)}`.trim());
    }
    // A title in kana alone may be mapped only under its romanization, which BeatSaver's search
    // can't guess the spacing of ("マイマイマイ" is "Mai Mai Mai"): the artist's maps are searched
    // too, and titleMatchLevel compares the reading.
    if (hasOnlyKana(cleanTitle) && cleanArtist !== '' && !isSingerOnly(cleanArtist)) queries.push(cleanArtist);
    return queries.filter((query) => query !== '');
  };
  const durationLabel = expectedDurationSeconds === null ? 'unknown' : `${String(Math.round(expectedDurationSeconds))}s`;
  const describe = (doc: MapDoc) =>
    `${doc.id} "${doc.metadata.songName}" by ${doc.metadata.songAuthorName} (${String(doc.metadata.duration ?? '?')}s)`;
  let otherEdit: ScoredDoc | null = null;
  let best: ScoredDoc | null = null;
  const tried = new Set<string>();
  // Every acceptable map seen over all the searches, by map id (the best score and tier it got).
  const seen = new Map<string, Candidate>();
  /** Runs the searches for one name of the song, until one of them finds a match. `knownArtists`
   *  is what candidates' artists are checked against (defaults to `artist`). */
  const searchName = async (title: string, artist: string, knownArtists = artist, maxQueries = Infinity): Promise<ScoredDoc | null> => {
    for (const query of queriesFor(title, artist).slice(0, maxQueries)) {
      if (tried.has(query)) continue;
      tried.add(query);
      const found = await searchOnce(query, title, knownArtists, expectedDurationSeconds, excludeRichEnvironments);
      console.log(
        `[wallpaper] sync search "${query}" (duration ${durationLabel}) -> ${
          found.match !== null
            ? describe(found.match.doc)
            : found.otherEdit !== null
              ? `only a different edit: ${describe(found.otherEdit.doc)}`
              : 'no plausible match'
        }`,
      );
      // The best different edit over all the searches, not just the first one found — a later
      // search (another name of the song) may turn up a better map of it.
      if (found.otherEdit !== null && (otherEdit === null || found.otherEdit.score > otherEdit.score)) otherEdit = found.otherEdit;
      for (const candidate of found.candidates) {
        const known = seen.get(candidate.doc.id);
        if (known === undefined) seen.set(candidate.doc.id, candidate);
        else {
          known.score = Math.max(known.score, candidate.score);
          known.unpenalized = Math.max(known.unpenalized, candidate.unpenalized);
          known.tier = Math.min(known.tier, candidate.tier) as Candidate['tier'];
          known.differentEdit &&= candidate.differentEdit;
        }
      }
      if (found.match === null) continue;
      if (best === null || found.match.score > best.score) best = found.match;
      return found.match;
    }
    return null;
  };

  const variants = names?.nameVariants?.(mediaTitle, mediaArtist) ?? [{ title: mediaTitle, artist: mediaArtist }];
  if (variants.length > 1) {
    console.log(`[wallpaper] sync: the title may name ${variants.slice(1).map((name) => `"${name.title}" by ${name.artist}`).join(', ')}`);
  }
  let matchedVariant: { title: string; artist: string } | null = null;
  let complete = true;
  // After a match, the other names are still tried — once each (their first query): the first
  // search can miss the best map of the song ("Virtual Riot - Simulation (VIP)" with the channel
  // "Disciple" found only the plain map; "Simulation (VIP)" by Virtual Riot finds the V3 one too).
  for (const variant of variants) {
    const found = await searchName(variant.title, variant.artist, variant.artist, matchedVariant === null ? Infinity : 1);
    if (found !== null && matchedVariant === null) matchedVariant = variant;
  }
  if (names?.alternateNames !== undefined) {
    // The song's names in other languages are searched too — also when a map was already found:
    // the best map of a song may only be listed under its other name (the curated V3 lightshow of
    // Camellia's "Play-With-Fire / Hiasobi" is "ヒアソビ"), and the richer lightshow wins. Looked
    // up for the name that found a map, or else for the cleaned-up names when there are any (the
    // raw video title rarely finds anything).
    const lookups = matchedVariant !== null ? [matchedVariant] : variants.length > 1 ? variants.slice(1, 3) : variants;
    for (const variant of lookups) {
      const found = await names.alternateNames(variant.title, variant.artist);
      if (found === null) complete = false;
      const alternates = found ?? [];
      if (alternates.length > 0) {
        console.log(`[wallpaper] sync: also known as ${alternates.map((name) => `"${name.title}" by ${name.artist}`).join(', ')}`);
      }
      // The artist in both languages counts as a match ("かめりあ" is Camellia).
      const knownArtists = [variant.artist, ...alternates.map((name) => name.artist)].join(' ');
      for (const name of alternates) await searchName(name.title, name.artist, knownArtists);
    }
  }
  // (Assigned inside searchName, which TypeScript's narrowing doesn't follow.)
  const chosen = best as ScoredDoc | null;
  const chosenEdit = otherEdit as ScoredDoc | null;
  let result: BeatSaverSearchResult | null = null;
  let pickedId: string | null = null;
  if (chosen !== null) {
    if (matchedVariant !== null) console.log(`[wallpaper] sync: best match ${describe(chosen.doc)}`);
    const entry = beatSaverEntryFromDoc(chosen.doc);
    if (entry !== null) result = { entry, durationConfirmed: expectedDurationSeconds !== null, differentEdit: false };
    pickedId = chosen.doc.id;
  } else if (chosenEdit !== null) {
    console.log(`[wallpaper] sync: best different edit ${describe(chosenEdit.doc)}`);
    const entry = beatSaverEntryFromDoc(chosenEdit.doc);
    if (entry !== null) result = { entry, durationConfirmed: false, differentEdit: true };
    pickedId = chosenEdit.doc.id;
  }
  // Best first: the maps the search would pick (the picked one at the very top), then other edits,
  // then V3/Noodle maps turned off in the settings, then unsupported environments; by score within —
  // with remixes/covers ranked against the player's own title (a name of the song found elsewhere
  // may name the remix, and then didn't push it down).
  const listScore = (candidate: Candidate) => candidate.unpenalized - versionPenalty(candidate.doc, mediaTitle);
  const ranked = [...seen.values()].sort(
    (a, b) =>
      Number(b.doc.id === pickedId) - Number(a.doc.id === pickedId) || a.tier - b.tier || listScore(b) - listScore(a),
  );
  const versions: MapVersion[] = [];
  for (const candidate of ranked.slice(0, MAX_MAP_VERSIONS)) {
    const entry = beatSaverEntryFromDoc(candidate.doc);
    if (entry === null) continue;
    versions.push({
      ...entry,
      duration: candidate.doc.metadata.duration ?? null,
      differentEdit: candidate.differentEdit,
      excluded: candidate.tier === 3 ? 'unsupported' : candidate.tier === 2 ? 'rich' : null,
    });
  }
  if (versions.length > 1) console.log(`[wallpaper] sync: ${String(versions.length)} versions of the song found`);
  return { best: result, versions, complete };
}

interface ScoredDoc {
  doc: MapDoc;
  score: number;
}

/** A map of the song for the "Other versions" list. tier: 0 = would be picked (right length, or
 *  the length unknown), 1 = another edit, 2 = a V3/Noodle map turned off in the settings, 3 = an
 *  environment the viewer can't show. */
interface Candidate extends ScoredDoc {
  tier: 0 | 1 | 2 | 3;
  differentEdit: boolean;
  /** The score without the remix/cover penalty. */
  unpenalized: number;
}

const DURATION_TOLERANCE_SECONDS = 8;

// Words marking another version of a song: its name matches once brackets are ignored
// ("Monitoring (Best Friend Remix)"), but it's not what plays unless the player says so too.
const VERSION_WORDS = /\b(?:remix|rmx|cover|covered|nightcore|sped ?up|slowed|instrumental|inst|vip|mashup|bootleg|rework|flip|remaster(?:ed)?|acoustic|live|piano|orchestral|8 ?bit|chiptune)\b|アレンジ|リミックス|カバー|歌ってみた/giu;

/** Pushes other versions of the song (a remix, a cover…) below the song itself when the player's
 *  title doesn't name that version: bigger than the quality range, smaller than a title tier. */
function versionPenalty(doc: MapDoc, mediaTitle: string): number {
  const mapWords = new Set((`${doc.metadata.songName} ${doc.metadata.songSubName}`.normalize('NFKC').match(VERSION_WORDS) ?? []).map((word) => word.toLowerCase()));
  if (mapWords.size === 0) return 0;
  const mediaWords = new Set((mediaTitle.normalize('NFKC').match(VERSION_WORDS) ?? []).map((word) => word.toLowerCase()));
  return [...mapWords].some((word) => !mediaWords.has(word)) ? 100 : 0;
}

/** One search request plus the candidate filtering described on searchBeatSaverForTrack: the best
 *  match, and separately the best map of a different edit of the same song. */
async function searchOnce(
  query: string,
  mediaTitle: string,
  mediaArtist: string,
  expectedDurationSeconds: number | null,
  excludeRichEnvironments: boolean,
): Promise<{ match: ScoredDoc | null; otherEdit: ScoredDoc | null; candidates: Candidate[] }> {
  const result = await requestJson(
    `${env.VITE_BEATSAVER_API_URL}/search/text/0?q=${encodeURIComponent(query)}&order=Relevance&pageSize=20`,
    mapPageSchema,
    { source: 'beatsaver', label: `search for "${query}"`, operation: 'search-track' },
  );
  if (result.isErr()) return { match: null, otherEdit: null, candidates: [] };
  let best: { doc: MapDoc; score: number } | null = null;
  let bestOtherEdit: { doc: MapDoc; score: number } | null = null;
  const candidates: Candidate[] = [];
  for (const doc of result.value.docs) {
    const title = titleMatchLevel(doc, mediaTitle, mediaArtist);
    const artist = artistMatches(doc, mediaArtist, mediaTitle);
    if (title === 0 || (title === 1 && !artist)) continue;
    // Without a lightshow there's nothing to show at all.
    if (!hasLightshowDoc(doc)) continue;
    // Title tiers are spaced wider than the quality range (0-80), so a better map can pick
    // between maps of the same song, but never beats the exact version over e.g. a VIP/remix.
    const titleScore = title === 3 ? 260 : title === 2 ? 150 : 40;
    const unpenalized = titleScore + (artist ? 20 : 0) + scoreByLightshowRichness(doc);
    const score = unpenalized - versionPenalty(doc, mediaTitle);
    const duration = doc.metadata.duration;
    const otherLength =
      expectedDurationSeconds !== null &&
      (duration === undefined || Math.abs(duration - expectedDurationSeconds) > DURATION_TOLERANCE_SECONDS);
    // Another edit counts only with the song name *and* the artist matching — without the length
    // check, a looser match would too easily be a different song.
    if (otherLength && !(title >= 2 && artist)) continue;
    // Maps the viewer can't show are never synced to on their own; nor, with V3/Noodle maps turned
    // off in the settings, are those — they're only listed, to be picked by hand.
    if (!isSupportedDoc(doc)) {
      candidates.push({ doc, score, tier: 3, differentEdit: otherLength, unpenalized });
      continue;
    }
    if (excludeRichEnvironments && isRichEnvironmentDoc(doc)) {
      candidates.push({ doc, score, tier: 2, differentEdit: otherLength, unpenalized });
      continue;
    }
    candidates.push({ doc, score, tier: otherLength ? 1 : 0, differentEdit: otherLength, unpenalized });
    if (otherLength) {
      if (bestOtherEdit === null || score > bestOtherEdit.score) bestOtherEdit = { doc, score };
      continue;
    }
    if (best === null || score > best.score) best = { doc, score };
  }
  return { match: best, otherEdit: bestOtherEdit, candidates };
}

/** Downloads a map's files (or reads them from the map cache, where it's also saved). onProgress is
 *  0..1, or null for an unknown total. Resolves to null when it can't be loaded (network error,
 *  deleted map, etc). */
export async function loadBeatSaverMap(
  hash: string,
  onProgress?: (progress: number | null) => void,
): Promise<MapSourceFile[] | null> {
  const result = await fetchBeatSaverHash(hash, { cache: browserMapArchiveCache, onProgress });
  if (result.isErr()) {
    console.error(`[wallpaper] failed to fetch BeatSaver map ${hash}`, result.error);
    return null;
  }
  return result.value.files;
}
