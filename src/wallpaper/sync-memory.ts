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
import { parseSavedMapEntries, type BeatSaverMapEntry } from './beatsaver-search';

export interface RememberedSync {
  entry: BeatSaverMapEntry;
  /** The track's length as the player reported it, if it did (to tell apart e.g. a TV-size cut). */
  duration: number | null;
  differentEdit: boolean;
  durationConfirmed: boolean;
  /** listenSyncLearnedOffset once locked to the audio (null until the first lock). */
  learnedOffset: number | null;
  usedAt: number;
}

const STORAGE_KEY = 'chropaper.syncMemory';
const MAX_RECORDS = 400;
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

function load(): Store {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const store: Store = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue;
      const record = value as Partial<RememberedSync>;
      const entry = parseSavedMapEntries([record.entry])[0];
      if (entry === undefined) continue;
      store[key] = {
        entry,
        duration: typeof record.duration === 'number' ? record.duration : null,
        differentEdit: record.differentEdit === true,
        durationConfirmed: record.durationConfirmed === true,
        learnedOffset: typeof record.learnedOffset === 'number' && Number.isFinite(record.learnedOffset) ? record.learnedOffset : null,
        usedAt: typeof record.usedAt === 'number' ? record.usedAt : 0,
      };
    }
    return store;
  } catch {
    return {};
  }
}

function save(store: Store) {
  const keys = Object.keys(store);
  if (keys.length > MAX_RECORDS) {
    keys
      .sort((a, b) => (store[a]?.usedAt ?? 0) - (store[b]?.usedAt ?? 0))
      .slice(0, keys.length - MAX_RECORDS)
      .forEach((key) => delete store[key]);
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // storage full or unavailable: the memory is only a shortcut
  }
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
  if (duration !== null && record.duration !== null && Math.abs(duration - record.duration) > DURATION_TOLERANCE_SECONDS) return null;
  if (!isCached(record.entry.hash) && Date.now() - record.usedAt > UNCACHED_MAX_AGE_MS) return null;
  return record;
}

/** Remembers the map now synced to this track. The learned offset carries over only for the same
 *  map (it's a property of that map's audio file). */
export function rememberSync(
  title: string,
  artist: string,
  record: Omit<RememberedSync, 'usedAt' | 'learnedOffset'> & { learnedOffset?: number | null },
) {
  const store = load();
  const key = trackKey(title, artist);
  const previous = store[key];
  const sameMap = previous?.entry.hash === record.entry.hash;
  store[key] = {
    ...record,
    duration: record.duration ?? (sameMap ? (previous?.duration ?? null) : null),
    learnedOffset: record.learnedOffset !== undefined ? record.learnedOffset : sameMap ? (previous?.learnedOffset ?? null) : null,
    usedAt: Date.now(),
  };
  save(store);
}

/** Updates the offset the track's map is locked at (after an audio lock or correction). */
export function rememberSyncOffset(title: string, artist: string, hash: string, learnedOffset: number) {
  const store = load();
  const record = store[trackKey(title, artist)];
  if (record === undefined || record.entry.hash !== hash) return;
  record.learnedOffset = learnedOffset;
  record.usedAt = Date.now();
  save(store);
}
