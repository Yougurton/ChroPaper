import { Result, TaggedError } from 'better-result';
import { z } from 'zod';

const cacheDirectoryName = 'maps-v1';
const cacheMetadataFilename = 'metadata.json';
const cacheArchiveFilename = 'map.zip';

const cacheMetadataSchema = z.object({
  version: z.literal(1),
  key: z.string().min(1),
  hash: z.hash('sha1'),
});

export interface CachedMapArchive {
  key: string;
  hash: string;
  archive: ArrayBuffer;
}

export class MapArchiveCacheError extends TaggedError('MapArchiveCacheError')<{
  message: string;
  cause: unknown;
}>() {}

export interface MapArchiveCache {
  get(hash: string): Promise<Result<CachedMapArchive | null, MapArchiveCacheError>>;
  set(map: CachedMapArchive): Promise<Result<void, MapArchiveCacheError>>;
  usage(): Promise<Result<number, MapArchiveCacheError>>;
  clear(): Promise<Result<void, MapArchiveCacheError>>;
}

function isMissingEntry(error: MapArchiveCacheError) {
  return error.cause instanceof DOMException && error.cause.name === 'NotFoundError';
}

export class OpfsMapArchiveCache implements MapArchiveCache {
  constructor(private readonly storage: Pick<StorageManager, 'getDirectory'>) {}

  async get(hash: string) {
    const result = await Result.tryPromise({
      try: async () => {
        const root = await this.storage.getDirectory();
        const maps = await root.getDirectoryHandle(cacheDirectoryName);
        const directory = await maps.getDirectoryHandle(hash.toLowerCase());
        const metadataHandle = await directory.getFileHandle(cacheMetadataFilename);
        const archiveHandle = await directory.getFileHandle(cacheArchiveFilename);
        const metadataFile = await metadataHandle.getFile();
        const metadataJson = await metadataFile.text();
        const metadata = cacheMetadataSchema.parse(JSON.parse(metadataJson));
        if (metadata.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('cached map hash does not match');
        const archiveFile = await archiveHandle.getFile();
        return {
          key: metadata.key,
          hash: metadata.hash,
          archive: await archiveFile.arrayBuffer(),
        };
      },
      catch: (cause) => new MapArchiveCacheError({ message: `cached map ${hash} could not be read`, cause }),
    });
    return result.isErr() && isMissingEntry(result.error) ? Result.ok(null) : result;
  }

  async set(map: CachedMapArchive) {
    return Result.tryPromise({
      try: async () => {
        const root = await this.storage.getDirectory();
        const maps = await root.getDirectoryHandle(cacheDirectoryName, { create: true });
        const directory = await maps.getDirectoryHandle(map.hash.toLowerCase(), { create: true });
        const archiveHandle = await directory.getFileHandle(cacheArchiveFilename, { create: true });
        const archive = await archiveHandle.createWritable();
        await archive.write(map.archive);
        await archive.close();
        const metadataHandle = await directory.getFileHandle(cacheMetadataFilename, { create: true });
        const metadata = await metadataHandle.createWritable();
        await metadata.write(JSON.stringify({ version: 1, key: map.key, hash: map.hash }));
        await metadata.close();
      },
      catch: (cause) => new MapArchiveCacheError({ message: `map ${map.hash} could not be cached`, cause }),
    });
  }

  async usage() {
    const directory = await Result.tryPromise({
      try: async () => {
        const root = await this.storage.getDirectory();
        return root.getDirectoryHandle(cacheDirectoryName);
      },
      catch: (cause) => new MapArchiveCacheError({ message: 'map cache could not be opened', cause }),
    });
    if (directory.isErr()) return isMissingEntry(directory.error) ? Result.ok(0) : Result.err(directory.error);
    return Result.tryPromise({
      try: async () => {
        let bytes = 0;
        for await (const [name, entry] of directory.value) {
          if (entry.kind !== 'directory') continue;
          const map = await directory.value.getDirectoryHandle(name);
          const archiveHandle = await map.getFileHandle(cacheArchiveFilename);
          const archive = await archiveHandle.getFile();
          bytes += archive.size;
        }
        return bytes;
      },
      catch: (cause) => new MapArchiveCacheError({ message: 'map cache size could not be read', cause }),
    });
  }

  async clear() {
    const result = await Result.tryPromise({
      try: async () => {
        const root = await this.storage.getDirectory();
        await root.removeEntry(cacheDirectoryName, { recursive: true });
      },
      catch: (cause) => new MapArchiveCacheError({ message: 'map cache could not be cleared', cause }),
    });
    return result.isErr() && isMissingEntry(result.error) ? Result.ok(undefined) : result;
  }
}

/** Default upper bound for the map cache (the "map cache size" setting, 256 MB – 20 GB, changes it
 *  at runtime — see IndexedDbMapArchiveCache.setLimit). Maps are 3–15 MB each, so 1 GB keeps
 *  roughly 100–200 of the most recently synced ones — those tracks then sync again without
 *  touching BeatSaver; the rest get evicted oldest-played-first. */
export const MAP_CACHE_LIMIT_BYTES = 1024 * 1024 * 1024;

const idbName = 'chropaper-map-cache';
const idbVersion = 3;
const idbArchiveStore = 'archives';
const idbEntryStore = 'entries';

interface MapCacheEntry {
  hash: string;
  key: string;
  bytes: number;
  lastUsed: number;
}

function idbRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function idbDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * The map cache the wallpaper actually uses: IndexedDB instead of ChroViewer's OPFS cache, because
 * Wallpaper Engine loads the wallpaper from a local file, and Chromium refuses the origin-private
 * file system to file:// pages (SecurityError) unless it's started with special flags — so the OPFS
 * cache could silently never store anything. IndexedDB works on file:// pages and survives restarts
 * as long as the browser profile does.
 *
 * Least-recently-played maps are evicted once the total goes over MAP_CACHE_LIMIT_BYTES. Archives
 * and their bookkeeping live in separate stores so eviction never has to load the archives.
 */
export class IndexedDbMapArchiveCache implements MapArchiveCache {
  private database: Promise<IDBDatabase> | null = null;
  private trimming: Promise<void> = Promise.resolve();
  /** Hashes currently in the cache — kept in memory so sync mode can ask synchronously. Filled by
   *  loadIndex(). */
  private readonly known = new Set<string>();

  constructor(
    private readonly factory: IDBFactory,
    private limitBytes = MAP_CACHE_LIMIT_BYTES,
  ) {}

  /** The current size limit, in bytes. */
  get limit() {
    return this.limitBytes;
  }

  /** The "map cache size" setting. A smaller limit evicts least-recently-played maps right away. */
  setLimit(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes === this.limitBytes) return;
    const shrunk = bytes < this.limitBytes;
    this.limitBytes = bytes;
    if (shrunk) {
      this.trimming = this.trimming.then(() => this.trim('')).catch((error: unknown) => {
        console.warn('[wallpaper] map cache: eviction failed', error);
      });
    }
  }

  private open() {
    this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(idbName, idbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(idbArchiveStore)) db.createObjectStore(idbArchiveStore);
        if (!db.objectStoreNames.contains(idbEntryStore)) db.createObjectStore(idbEntryStore, { keyPath: 'hash' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    }).catch((error: unknown) => {
      this.database = null; // let a later call try again
      throw error;
    });
    return this.database;
  }

  async get(hash: string) {
    const id = hash.toLowerCase();
    return Result.tryPromise({
      try: async () => {
        const db = await this.open();
        const transaction = db.transaction([idbArchiveStore, idbEntryStore], 'readwrite');
        const done = idbDone(transaction);
        const entries = transaction.objectStore(idbEntryStore);
        const [entry, archive] = await Promise.all([
          idbRequest(entries.get(id) as IDBRequest<MapCacheEntry | undefined>),
          idbRequest(transaction.objectStore(idbArchiveStore).get(id) as IDBRequest<ArrayBuffer | undefined>),
        ]);
        if (entry === undefined || !(archive instanceof ArrayBuffer)) {
          this.forget(id);
          transaction.abort();
          await done.catch(() => undefined);
          return null;
        }
        entries.put({ ...entry, lastUsed: Date.now() } satisfies MapCacheEntry);
        await done;
        return { key: entry.key, hash: entry.hash, archive };
      },
      catch: (cause) => new MapArchiveCacheError({ message: `cached map ${hash} could not be read`, cause }),
    });
  }

  async set(map: CachedMapArchive) {
    const id = map.hash.toLowerCase();
    const result = await Result.tryPromise({
      try: async () => {
        const db = await this.open();
        const transaction = db.transaction([idbArchiveStore, idbEntryStore], 'readwrite');
        const done = idbDone(transaction);
        transaction.objectStore(idbArchiveStore).put(map.archive, id);
        transaction.objectStore(idbEntryStore).put({
          hash: id,
          key: map.key,
          bytes: map.archive.byteLength,
          lastUsed: Date.now(),
        } satisfies MapCacheEntry);
        await done;
        this.known.add(id);
      },
      catch: (cause) => new MapArchiveCacheError({ message: `map ${map.hash} could not be cached`, cause }),
    });
    // Evicting is housekeeping — the caller already has its map, so it doesn't wait for this.
    this.trimming = this.trimming.then(() => this.trim(id)).catch((error: unknown) => {
      console.warn('[wallpaper] map cache: eviction failed', error);
    });
    return result;
  }

  private async entries() {
    const db = await this.open();
    const transaction = db.transaction(idbEntryStore, 'readonly');
    return idbRequest(transaction.objectStore(idbEntryStore).getAll() as IDBRequest<MapCacheEntry[]>);
  }

  /** Drops least-recently-played maps until the cache fits the limit (never the one just added). */
  private async trim(keep: string) {
    const entries = await this.entries();
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (total <= this.limitBytes) return;
    const victims: string[] = [];
    for (const entry of entries.sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= this.limitBytes) break;
      if (entry.hash === keep) continue;
      victims.push(entry.hash);
      total -= entry.bytes;
    }
    if (victims.length === 0) return;
    const db = await this.open();
    const transaction = db.transaction([idbArchiveStore, idbEntryStore], 'readwrite');
    const done = idbDone(transaction);
    for (const hash of victims) {
      transaction.objectStore(idbArchiveStore).delete(hash);
      transaction.objectStore(idbEntryStore).delete(hash);
    }
    await done;
    for (const hash of victims) this.forget(hash);
    console.log(`[wallpaper] map cache: evicted ${String(victims.length)} least recently played map(s)`);
  }

  private forget(hash: string) {
    this.known.delete(hash);
  }

  /** Whether a map is in the cache right now (after loadIndex() has run; false before that). */
  isCached(hash: string) {
    return this.known.has(hash.toLowerCase());
  }

  /** Reads which maps are cached into memory (see isCached). */
  async loadIndex() {
    const entries = await this.entries();
    this.known.clear();
    for (const entry of entries) this.known.add(entry.hash);
  }

  async stats() {
    return Result.tryPromise({
      try: async () => {
        const entries = await this.entries();
        return { count: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
      },
      catch: (cause) => new MapArchiveCacheError({ message: 'map cache size could not be read', cause }),
    });
  }

  async usage() {
    const stats = await this.stats();
    return stats.isErr() ? Result.err(stats.error) : Result.ok(stats.value.bytes);
  }

  async clear() {
    return Result.tryPromise({
      try: async () => {
        const db = await this.open();
        const transaction = db.transaction([idbArchiveStore, idbEntryStore], 'readwrite');
        const done = idbDone(transaction);
        transaction.objectStore(idbArchiveStore).clear();
        transaction.objectStore(idbEntryStore).clear();
        await done;
        this.known.clear();
      },
      catch: (cause) => new MapArchiveCacheError({ message: 'map cache could not be cleared', cause }),
    });
  }
}

const indexedDbFactory = typeof indexedDB === 'undefined' ? null : indexedDB;

export const browserMapArchiveCache = indexedDbFactory === null ? null : new IndexedDbMapArchiveCache(indexedDbFactory);

/** Startup housekeeping: asks the browser not to evict the cache under storage pressure, removes
 *  the old OPFS cache if an earlier build managed to write one, and logs the cache size — which is
 *  how to check in Wallpaper Engine's devtools that the cache really survives a restart. */
let initPromise: Promise<void> | null = null;

/** Runs the startup housekeeping below once; later calls get the same promise — so anything that
 *  needs isCached() to be accurate (sync mode's memory) can wait for it. */
export function initMapArchiveCache() {
  initPromise ??= runMapArchiveCacheInit();
  return initPromise;
}

async function runMapArchiveCacheInit() {
  if (browserMapArchiveCache === null) {
    console.warn('[wallpaper] map cache: IndexedDB unavailable — maps are downloaded every time');
    return;
  }
  let persistent = false;
  try {
    persistent = (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    // not supported here — the cache still works, it's just "best effort" storage
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(cacheDirectoryName, { recursive: true });
    console.log('[wallpaper] map cache: removed the old OPFS cache');
  } catch {
    // nothing there, or OPFS unavailable (the usual case for file:// pages)
  }
  try {
    await browserMapArchiveCache.loadIndex();
  } catch (error) {
    console.warn('[wallpaper] map cache: could not be read', error);
  }
  const stats = await browserMapArchiveCache.stats();
  if (stats.isErr()) {
    console.warn('[wallpaper] map cache: could not be opened', stats.error);
    return;
  }
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);
  console.log(
    `[wallpaper] map cache: ${String(stats.value.count)} maps, ${mb(stats.value.bytes)} MB of ${mb(browserMapArchiveCache.limit)} MB, ` +
      `persistent storage: ${persistent ? 'yes' : 'no'}`,
  );
}
