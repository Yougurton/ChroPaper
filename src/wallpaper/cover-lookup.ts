/**
 * Online cover lookup for the screensaver ("listen") mode, for when the player's own thumbnail
 * can't be trusted.
 *
 * Wallpaper Engine takes the cover from the system's media session, and some players (Apple Music
 * on Windows was the one reported) update the title right away but hand over the new artwork late
 * or not at all — the panel then shows the previous song's cover next to the new title. When that
 * happens main.ts asks here instead: the iTunes Search API (no key needed) finds the song by
 * artist + title and returns its artwork.
 *
 * Requested as JSONP: Apple rejects fetches with the `Origin: null` a page loaded from a local
 * file sends (and doesn't reliably send CORS headers otherwise); a <script> request has no Origin.
 */

export interface ItunesResult {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  trackTimeMillis?: number;
  collectionName?: string;
  artworkUrl100?: string;
}

const LOOKUP_TIMEOUT_MS = 6000;
const cache = new Map<string, string | null>();

function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Some players put "Artist — Album" into the artist field (Apple Music does); only the artist
 *  part is useful for a search. */
export function cleanArtist(artist: string) {
  return artist.split(/\s+[—–]\s+/)[0]?.trim() ?? artist.trim();
}

function jsonp(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const name = `__chropaperCover${String(Date.now())}${String(Math.floor(Math.random() * 1e6))}`;
    const script = document.createElement('script');
    const globals = window as unknown as Record<string, unknown>;
    const cleanup = () => {
      window.clearTimeout(timer);
      delete globals[name];
      script.remove();
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, LOOKUP_TIMEOUT_MS);
    globals[name] = (data: unknown) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('script failed to load'));
    };
    script.src = `${url}&callback=${name}`;
    document.head.appendChild(script);
  });
}

/** One iTunes Search/Lookup API request (JSONP, see below) — the `results` array, or [] if the
 *  response had none. Rejects on a network failure or timeout. */
export async function itunesRequest(url: string): Promise<ItunesResult[]> {
  return search(url);
}

async function search(url: string): Promise<ItunesResult[]> {
  // JSONP straight away: Apple's API doesn't reliably send CORS headers (to a page loaded from a
  // local file it refuses outright), and a blocked fetch prints an error to the log every time
  // even when the fallback then works.
  const data = await jsonp(url);
  const results = (data as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? (results as ItunesResult[]) : [];
}

/** Resolves to a cover image URL for the song, or null if nothing convincing was found. */
export async function lookupCover(title: string, artist: string): Promise<string | null> {
  const cleanedArtist = cleanArtist(artist);
  const key = `${normalize(title)}|${normalize(cleanedArtist)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const term = encodeURIComponent(`${cleanedArtist} ${title}`.trim());
  let cover: string | null = null;
  try {
    const results = await search(`https://itunes.apple.com/search?term=${term}&entity=song&limit=10`);
    const wantedTitle = normalize(title);
    const wantedArtist = normalize(cleanedArtist);
    const scored = results
      .filter((result) => typeof result.artworkUrl100 === 'string')
      .map((result) => {
        const resultTitle = normalize(result.trackName ?? '');
        const resultArtist = normalize(result.artistName ?? '');
        let score = 0;
        if (resultTitle === wantedTitle) score += 2;
        else if (resultTitle.includes(wantedTitle) || wantedTitle.includes(resultTitle)) score += 1;
        if (wantedArtist !== '' && (resultArtist.includes(wantedArtist) || wantedArtist.includes(resultArtist))) score += 2;
        return { result, score };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    // Needs at least the title *and* the artist to roughly match — a wrong cover is worse than the
    // wallpaper's own placeholder.
    if (best !== undefined && best.score >= 3) {
      cover = (best.result.artworkUrl100 ?? '').replace(/\/\d+x\d+bb\./, '/600x600bb.');
    }
  } catch (error) {
    console.warn('[wallpaper] online cover lookup failed', error);
    return null; // not cached: may work next time (network back, etc.)
  }
  cache.set(key, cover);
  return cover;
}
