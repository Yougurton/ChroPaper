/**
 * Sync mode's memory of tracks it has synced before: which BeatSaver map went with the track, and
 * the offset the map ended up locked at against the audio.
 *
 * With that, a track heard again starts straight from the remembered map — from the map cache when
 * it's still there, so with no request to any server at all (no BeatSaver search, no Apple lookup)
 * — and at the remembered offset, so there's no big jump at the start while the audio alignment
 * finds its footing again. The alignment still runs as always; it just starts close.
 *
 * Kept in localStorage (a few hundred small records), least recently used dropped first.
 */
import {
  parseSavedMapEntries,
  parseSavedMapVersions,
  type BeatSaverMapEntry,
  type MapVersion,
} from './beatsaver-search';

export interface RememberedSync {
  /** The map the search picked for the track. */
  entry: BeatSaverMapEntry;
  /** The track's length as the player reported it, if it did (to tell apart e.g. a TV-size cut). */
  duration: number | null;
  differentEdit: boolean;
  durationConfirmed: boolean;
  /** listenSyncLearnedOffset once locked to the audio, per map (by hash) — it's a property of that
   *  map's audio file, so each version of the song has its own. */
  offsets: Record<string, number>;
  /** Every map the search found of the song, best first — the player's "Other versions" list. */
  versions: MapVersion[];
  usedAt: number;
  /** SEARCH_VERSION of the search that picked the map. */
  version?: number;
}

/** Bumped whenever the BeatSaver search itself changes in a way that can pick a different map:
 *  records from an older search are dropped, and the track is searched afresh once — otherwise a
 *  map an older, less careful search got wrong would come back from memory forever.
 *  2: remixes/covers ranked below the song, other-length songs by the same artist not taken.
 *  3: "Artist- Title" split, other songs merely featuring the artist not taken.
 *  4: a version in brackets ("Simulation (VIP)") matched against the map's subtitle.
 *  5: the same with the artist in the title; the best different edit over all searches.
 *  6: version brackets kept in the title's name variants, every variant searched.
 *  7: the other versions of the song remembered too (for the "Other versions" list). */
const SEARCH_VERSION = 7;

const STORAGE_KEY = 'chropaper.syncMemory';
const MAX_RECORDS = 400;
const MAX_OFFSETS_PER_TRACK = 12;
const DURATION_TOLERANCE_SECONDS = 8;
/** A remembered map that's no longer in the map cache is still used for this long (downloaded by
 *  its hash — one request instead of a whole search); after that the track is searched afresh, in
 *  case a better map has been published since. */
const UNCACHED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Store = Record<string, RememberedSync>;

function trackKey(title: string, artist: string): string {
  const clean = (text: string) =>
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  return `${clean(title)}|${clean(artist)}`;
}

function readJson(key: string): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Saves a store of records, dropping the least recently used ones beyond MAX_RECORDS. */
function writeJson(key: string, store: Record<string, { usedAt: number }>) {
  const keys = Object.keys(store);
  if (keys.length > MAX_RECORDS) {
    keys
      .sort((a, b) => (store[a]?.usedAt ?? 0) - (store[b]?.usedAt ?? 0))
      .slice(0, keys.length - MAX_RECORDS)
      .forEach((name) => delete store[name]);
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(store));
  } catch {
    // storage full or unavailable: the memory is only a shortcut
  }
}

function parseOffsets(raw: unknown): Record<string, number> {
  const offsets: Record<string, number> = {};
  if (raw === null || typeof raw !== 'object') return offsets;
  for (const [hash, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) offsets[hash] = value;
  }
  return offsets;
}

function load(): Store {
  const store: Store = {};
  for (const [key, value] of Object.entries(readJson(STORAGE_KEY))) {
    if (value === null || typeof value !== 'object') continue;
    const record = value as Partial<RememberedSync>;
    const entry = parseSavedMapEntries([record.entry])[0];
    if (entry === undefined || record.version !== SEARCH_VERSION) continue;
    store[key] = {
      entry,
      duration: typeof record.duration === 'number' ? record.duration : null,
      differentEdit: record.differentEdit === true,
      durationConfirmed: record.durationConfirmed === true,
      offsets: parseOffsets(record.offsets),
      versions: Array.isArray(record.versions) ? parseSavedMapVersions(record.versions) : [],
      usedAt: typeof record.usedAt === 'number' ? record.usedAt : 0,
      version: SEARCH_VERSION,
    };
  }
  return store;
}

function durationsDiffer(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) > DURATION_TOLERANCE_SECONDS;
}

/** The remembered map for this track, if there is one that still fits: same length (when both are
 *  known), and either still in the map cache or not too old. */
export function recallSync(
  title: string,
  artist: string,
  duration: number | null,
  isCached: (hash: string) => boolean,
): RememberedSync | null {
  const record = load()[trackKey(title, artist)];
  if (record === undefined) return null;
  if (durationsDiffer(duration, record.duration)) return null;
  if (!isCached(record.entry.hash) && Date.now() - record.usedAt > UNCACHED_MAX_AGE_MS) return null;
  return record;
}

/** The versions of the song remembered for this track (empty when it hasn't been searched). */
export function recallVersions(title: string, artist: string, duration: number | null): MapVersion[] {
  const record = load()[trackKey(title, artist)];
  return record === undefined || durationsDiffer(duration, record.duration) ? [] : record.versions;
}

/** Remembers what the search found for this track. Offsets learned before are kept (they belong to
 *  the maps, not to the search). */
export function rememberSync(
  title: string,
  artist: string,
  record: Pick<RememberedSync, 'entry' | 'duration' | 'differentEdit' | 'durationConfirmed' | 'versions'>,
) {
  const store = load();
  const key = trackKey(title, artist);
  const previous = store[key];
  store[key] = {
    ...record,
    duration: record.duration ?? (previous?.entry.hash === record.entry.hash ? previous.duration : null),
    offsets: previous?.offsets ?? {},
    usedAt: Date.now(),
    version: SEARCH_VERSION,
  };
  writeJson(STORAGE_KEY, store);
}

/** Marks the track's record as just used (so it's not the first to go when the memory is full). */
export function touchSync(title: string, artist: string) {
  const store = load();
  const record = store[trackKey(title, artist)];
  if (record === undefined) return;
  record.usedAt = Date.now();
  writeJson(STORAGE_KEY, store);
}

/** Updates the offset a map of the track is locked at (after an audio lock or correction). */
export function rememberSyncOffset(title: string, artist: string, hash: string, learnedOffset: number) {
  const store = load();
  const record = store[trackKey(title, artist)];
  if (record === undefined) return;
  delete record.offsets[hash]; // (re-added last: the oldest ones are dropped first)
  record.offsets[hash] = learnedOffset;
  const hashes = Object.keys(record.offsets);
  for (const old of hashes.slice(0, Math.max(0, hashes.length - MAX_OFFSETS_PER_TRACK))) delete record.offsets[old];
  record.usedAt = Date.now();
  writeJson(STORAGE_KEY, store);
}

/** Forgets the map remembered for this track (it was the wrong one: the ⏏ button left it). */
export function forgetSync(title: string, artist: string) {
  const store = load();
  const key = trackKey(title, artist);
  if (store[key] === undefined) return;
  delete store[key];
  writeJson(STORAGE_KEY, store);
}

/**
 * The listener's own choice among the versions of a song, kept apart from the search's memory above
 * (it outlives a newer search): the version picked by hand in the player's "Other versions" list
 * (pinned), and the last version that was played to the end when it wasn't the search's pick
 * (completed). The next time the track plays: the pinned version, else the completed one, else the
 * search's pick.
 */
export interface VersionChoice {
  pinned: MapVersion | null;
  completed: MapVersion | null;
  /** The track's length when the choice was made, if the player reported one. */
  duration: number | null;
  usedAt: number;
}

const CHOICES_KEY = 'chropaper.syncChoices';

function loadChoices(): Record<string, VersionChoice> {
  const store: Record<string, VersionChoice> = {};
  for (const [key, value] of Object.entries(readJson(CHOICES_KEY))) {
    if (value === null || typeof value !== 'object') continue;
    const record = value as Partial<VersionChoice>;
    const pinned = parseSavedMapVersions([record.pinned])[0] ?? null;
    const completed = parseSavedMapVersions([record.completed])[0] ?? null;
    if (pinned === null && completed === null) continue;
    store[key] = {
      pinned,
      completed,
      duration: typeof record.duration === 'number' ? record.duration : null,
      usedAt: typeof record.usedAt === 'number' ? record.usedAt : 0,
    };
  }
  return store;
}

function updateChoice(
  title: string,
  artist: string,
  duration: number | null,
  change: (choice: VersionChoice) => void,
) {
  const store = loadChoices();
  const key = trackKey(title, artist);
  const choice = store[key] ?? { pinned: null, completed: null, duration: null, usedAt: 0 };
  change(choice);
  choice.duration = duration ?? choice.duration;
  choice.usedAt = Date.now();
  if (choice.pinned === null && choice.completed === null) delete store[key];
  else store[key] = choice;
  writeJson(CHOICES_KEY, store);
}

/** The listener's choice for this track, unless it was made for a track of another length. */
export function recallChoice(title: string, artist: string, duration: number | null): VersionChoice | null {
  const choice = loadChoices()[trackKey(title, artist)];
  if (choice === undefined || durationsDiffer(duration, choice.duration)) return null;
  return choice;
}

/** Pins a version for this track (null unpins). */
export function pinVersion(title: string, artist: string, version: MapVersion | null, duration: number | null) {
  updateChoice(title, artist, duration, (choice) => {
    choice.pinned = version;
  });
}

/** A version was played to the end: it becomes the track's main one — unless it's the search's own
 *  pick anyway (null), which then simply stays the default. */
export function rememberCompleted(title: string, artist: string, version: MapVersion | null, duration: number | null) {
  updateChoice(title, artist, duration, (choice) => {
    choice.completed = version;
  });
}

/** Drops a version from the track's choice (the ⏏ button left it: most likely the wrong map). */
export function forgetChoice(title: string, artist: string, hash: string) {
  if (recallChoice(title, artist, null) === null) return;
  updateChoice(title, artist, null, (choice) => {
    if (choice.pinned?.hash === hash) choice.pinned = null;
    if (choice.completed?.hash === hash) choice.completed = null;
  });
}
