import { effectiveNoteJumpSpeed, parseInfo } from '../core/beatmap/info';
import { parseDifficulty } from '../core/beatmap/parse';
import { createDifficulty, type BasicEvent, type Difficulty } from '../core/beatmap/types';
import { songBpmTimeToSeconds } from '../core/beatmap/bpm';
import { createAudioClock, createSilentClock, type SongClock } from '../core/clock/song-clock';
import type { InfoColorScheme } from '../core/beatmap/info';
import { DEFAULT_COLORS, type Rgb } from '../core/colors';
import {
  createBasicLightTimeline,
  GAME_LIGHT_HIGHLIGHT_ALPHA,
  GAME_LIGHT_NORMAL_ALPHA,
  resolveBasicLightAlpha,
  resolveBasicLightColor,
  sampleBasicLightTimeline,
} from '../core/lighting/basic-light';
import { buildMapRenderData } from '../core/placement/map-render-data';
import { DEFAULT_REPLAY_CAMERA_SETTINGS } from '../core/viewer-settings';
import { environmentCatalog, isGLSCapableEnvironment } from '../renderer/environment/environment-catalog';
import { MapView } from '../renderer/map-view';
import type { MirrorQuality } from '../renderer/quality';
import { RendererLifecycle } from '../renderer/renderer-lifecycle';
import { setMaxRenderFrameRate } from '../renderer/render-frame-pacing';
import { parseMapPackage, type MapPackageParser } from '../mapfile/parse-map-package';
import type { DifficultyRow } from '../mapfile/viewer-types';
import {
  initNowPlayingControls,
  setListenSyncStatus,
  setPanelPinned,
  setPhase,
  setProgress,
  setStatusPinned,
  setTrack,
  setUiScale,
  setVersions,
  type VersionRow,
  hideEpilepsyWarning,
  setFps,
  hideUiHint,
  showEpilepsyWarning,
  showToast,
  showUiHint,
} from './hud';
import { applyStaticTranslations, resolveAutoLanguage, setLanguage, t } from './i18n';
import { randomHarmoniousPalette, type LightPalette } from './listen-colors';
import { ListenLightshow } from './listen-lightshow';
import { buildSyncReference, referenceLoudness, SyncAligner, type SyncReference } from './audio-sync';
import { lookupCover } from './cover-lookup';
import { alternateTrackNames, nameVariants } from './track-names';
import {
  forgetChoice,
  forgetSync,
  pinVersion,
  recallChoice,
  recallSync,
  rememberCompleted,
  rememberSync,
  rememberSyncOffset,
  touchSync,
} from './sync-memory';
import { installDebugLog } from './debug-log';
import { browserMapArchiveCache, initMapArchiveCache } from '../sources/map-archive-cache';
import {
  loadBeatSaverMap,
  searchBeatSaverForTrack,
  type BeatSaverSearchOutcome,
  type BeatSaverSearchResult,
  type MapVersion,
} from './beatsaver-search';
import { DEFAULT_WALLPAPER_CONTROLS, listenForWallpaperControls, waitForInitialProperties } from './wallpaper-controls';

// Wallpaper Engine's audio-visualizer and media-integration APIs — undocumented in TypeScript's
// lib.dom.d.ts since they're WE-specific globals, not a web standard. Declared narrowly, only the
// bits "listen" mode actually uses. All optional: outside Wallpaper Engine (a plain browser
// preview) none of this exists, which every call site below checks for before using.
declare global {
  interface Window {
    wallpaperRegisterAudioListener?: (listener: (audioArray: number[]) => void) => void;
    wallpaperRegisterMediaStatusListener?: (listener: (event: { enabled: boolean }) => void) => void;
    wallpaperRegisterMediaPropertiesListener?: (
      listener: (event: { title?: string; artist?: string; genres?: string; albumTitle?: string }) => void,
    ) => void;
    wallpaperRegisterMediaThumbnailListener?: (listener: (event: { thumbnail?: string }) => void) => void;
    wallpaperRegisterMediaTimelineListener?: (
      listener: (event: { position?: number; duration?: number }) => void,
    ) => void;
    wallpaperRegisterMediaPlaybackListener?: (listener: (event: { state: number }) => void) => void;
    wallpaperMediaIntegration?: { PLAYBACK_PLAYING: number; PLAYBACK_PAUSED: number; PLAYBACK_STOPPED: number };
  }
}

// A cache size change from the settings takes effect after this long (see onCacheSizeChange).
const CACHE_SIZE_APPLY_DELAY_MS = 30_000;
// "Listen" mode (experimental): synthesizes a live lightshow from system audio instead of playing
// any map. LISTEN_FAKE_BPM is just an arbitrary internal clock for the event-timing system (there's
// no real song tempo to sync to here); the update interval controls how often new audio-derived
// events are pushed and the environment's light state rebuilt.
const LISTEN_FAKE_BPM = 120;
// 50 ms: the generator reacts to silences, section changes and hits within a frame or two, and a
// slower tick would add up to its whole interval of delay before that reaches the screen. The
// (comparatively costly) render-data rebuild only runs when something actually changed — see
// LISTEN_REBUILD_MAX_INTERVAL_MS.
const LISTEN_UPDATE_INTERVAL_MS = 50;
// How long to wait for Wallpaper Engine's first batch of properties before building the renderer
// with the defaults (it arrives almost at once inside Wallpaper Engine, never in a plain browser).
const INITIAL_PROPERTIES_TIMEOUT_MS = 1000;
// A live-show rebuild waits for more events (they're scheduled ~0.6 s ahead) unless one of the new
// ones is due within this many beats of the fake 120 BPM clock (0.4 beats = 200 ms).
const LISTEN_URGENT_BEATS = 0.4;
// How long a new track's cover may lag behind its title before it's treated as missing/stale.
const LISTEN_COVER_GRACE_MS = 1500;
// Rebuild at least this often even when no new events arrived (environment/color changes etc.).
const LISTEN_REBUILD_MAX_INTERVAL_MS = 500;
const LISTEN_EVENT_WINDOW_BEATS = 8;
// How long real audio silence has to persist before switching to the calm ambient show, even if
// the media API still claims a track is "open" (e.g. paused — the media API alone can't tell us
// that, only actually-measured silence in the audio stream can).
const LISTEN_SILENCE_TIMEOUT_MS = 5000;
// Without track info from the media API (the player doesn't support Media Integration, or it's
// off) the audio alone decides when music is playing. Sound has to last this long before the
// reactive show starts, so a notification sound or a click doesn't light the stage up.
const LISTEN_UNTITLED_START_MS = 1500;
// Gaps shorter than this don't break a stretch of sound (quiet moments inside a song).
const LISTEN_SOUND_STREAK_GAP_MS = 600;
// Calm idle show (see tickListenAmbient). All in beats of the internal LISTEN_FAKE_BPM clock
// (120 → 1 beat = 0.5 s).
const AMBIENT_FADE_IN_BEATS = 8; // lights ease in from whatever the reactive show left behind
const AMBIENT_SEGMENT_BEATS = 20; // one slow color drift (~10 s) before the next target color
const AMBIENT_RING_STEP_BEATS = 1; // a small ring nudge every half second — reads as one continuous turn
const AMBIENT_RING_ROTATION = 3; // peak degrees per nudge → ~6°/s at full speed
// The turn direction reverses now and then: speed eases down to zero and back up the other way over
// one "half period", picked at random from this range each time (in beats: 30-70 s).
const AMBIENT_RING_HALF_PERIOD_MIN_BEATS = 60;
const AMBIENT_RING_HALF_PERIOD_MAX_BEATS = 140;
// Rings slowly fan out into a spiral (angle offset between neighbouring rings) and close back up.
const AMBIENT_RING_FAN_MAX_DEGREES = 12;
const AMBIENT_RING_FAN_PERIOD_BEATS = 200; // ~100 s for a full open-close cycle
// ...and drift apart / together along the tunnel (ring zoom), on environments that have it.
const AMBIENT_ZOOM_MIN_STEP = 1;
const AMBIENT_ZOOM_MAX_STEP = 3.5;
const AMBIENT_ZOOM_PERIOD_BEATS = 260; // ~130 s, deliberately out of step with the fan
const AMBIENT_ZOOM_EVERY_BEATS = 4;
const AMBIENT_LASER_SPEED = 0.3; // "preciseSpeed" → ~6°/s, a slow sweep
// Ring events may only be dropped from the (fully settled) past, see trimListenEvents.
const AMBIENT_RING_KEEP_BEATS = 48;
// A real seek/track-change is caught and jumped to on every tick (no delay) once the gap is this
// big. Kept large so ordinary reporting noise is never mistaken for one.
const LISTEN_SLAVE_HARD_SEEK_SECONDS = 2.5;
// Below that, a much smaller gap is still checked for, but only every few seconds rather than on
// every tick — this is what lets sync recover on its own from a small residual error (rather than
// needing you to go hunting for a different manual-offset value each time) and what keeps a track
// whose own audio genuinely runs at a slightly different tempo than the map's stated BPM roughly in
// line for its whole length, without constantly re-seeking. A seek still briefly restarts the
// muted audio source under the hood, so this is a deliberate trade-off — a small, occasional
// correction in exchange for actually staying in sync, rather than never correcting at all.
const LISTEN_SLAVE_SOFT_RESYNC_SECONDS = 0.6;
const LISTEN_SLAVE_SOFT_RESYNC_INTERVAL_MS = 8000;
// How long to let the player's reported position settle after a detected seek before treating it
// as the reference again — see the timeline listener for why the first reading can't be trusted.
const LISTEN_SEEK_SETTLE_MS = 1200;
// How long to wait for the media player's own duration report before searching without one — see
// the wait loop in trySyncWithBeatSaverMap for why this exists at all. Players (browsers especially)
// can take a few seconds to send their first timeline update for a new track, and 1.5 s regularly
// timed out, silently dropping the duration check.
const DURATION_WAIT_TIMEOUT_MS = 4000;
// A duration *change* that arrives up to this long before the title change is still attributed to
// the new track — Wallpaper Engine's timeline and properties callbacks have no guaranteed order.
const DURATION_PRE_TITLE_GRACE_MS = 1500;
const DURATION_WAIT_POLL_MS = 100;
// A map can be ready (from the cache) before the player has reported any position for the new
// track: the last reading is still the previous track's, often near its end — starting there put
// the new map past its own end, where it was taken for finished and dropped. So the start waits
// this long for a reading of the new track, then assumes the track started at the title change.
const FRESH_POSITION_WAIT_MS = 2500;
// A map that "ended" within this long of starting didn't really play out (see reachedEnd).
const LISTEN_SYNC_MIN_PLAY_MS = 3000;
// For a track synced before (see sync-memory.ts): a shorter wait, the duration only confirms it.
const REMEMBERED_DURATION_WAIT_MS = 1500;
// A synced map counts as played to the end (see rememberCompleted) once its clock gets this far,
// after at least this long on screen (not just a jump to the end).
const LISTEN_SYNC_COMPLETED_FRACTION = 0.9;
const LISTEN_SYNC_COMPLETED_MIN_PLAY_MS = 30_000;
// How far apart (s) the player's and a map's lengths can be for the same edit of the song — the
// same tolerance the search uses.
const SYNC_DURATION_TOLERANCE_SECONDS = 8;
// How long a one-off sync message stays in the status pill (as long as hud.ts shows it).
const SYNC_MESSAGE_HOLD_MS = 5000;
// When a synced map runs out before the player reports the next track, it's held (frozen on its
// last frame) this long for the next title to show up, rather than dropping straight back to the
// generated show — which the next track's map would replace again a moment later.
const LISTEN_SYNC_END_GRACE_MS = 6000;
// The same when the player's track info disappears altogether while synced (the player's page is
// being reloaded, say): the map is held this long for the track to come back — the same title then
// syncs again from the start instead of being taken for the track that was already handled.
const LISTEN_SYNC_TITLE_LOST_GRACE_MS = 8000;
// How long a silent stretch has to last before the synced clock is paused (shorter than
// LISTEN_SILENCE_TIMEOUT_MS, which is for falling back to the generated show entirely when not
// synced at all — pausing in place is cheap enough to react to quickly).
const LISTEN_SYNC_PAUSE_TIMEOUT_MS = 1800;
// ...but only if the map's own audio isn't quiet at that point too (below this share of how loud
// the song usually gets): then it's a quiet moment in the song (a break, the fade-out at the end),
// not a paused player, and the map keeps running.
const LISTEN_SYNC_QUIET_RATIO = 0.15;
// ...and not while the player keeps reporting a position that moves forward (it's playing).
const LISTEN_POSITION_ADVANCING_MS = 3000;
// How long a stretch with no correction needed has to last before sync counts as settled when the
// audio can't lock it (see refreshSyncStatus).
const LISTEN_SYNC_CONFIDENT_AFTER_MS = 3000;
// Screensaver audio handling. These used to be Wallpaper Engine sliders (reaction speed and the
// media API latency compensation below); they're fixed now, at the values those sliders defaulted
// to. The generator's own tuning (light density, light offset)
// likewise stays at ListenLightshow's defaults.
// What counts as any sound at all (see the audio listener). Relative to how loud the music has been
// lately, since on some systems Wallpaper Engine captures the audio *after* the system volume: at a
// low volume a fixed threshold took real music for silence (and a synced map for paused). The
// floor only has to separate music from the zeros of real silence.
const LISTEN_SOUND_MIN_LEVEL = 0.002;
const LISTEN_SOUND_RELATIVE_LEVEL = 0.03;
// How fast "lately" forgets a louder level (half-life), e.g. after the volume was turned down.
const LISTEN_SOUND_LEVEL_HALF_LIFE_MS = 20_000;
// A frame with sound this recent still counts as sound now (frames arrive ~30 times a second).
const LISTEN_SOUND_FRAME_HOLD_MS = 150;
const LISTEN_DEFAULT_SMOOTHING = 1; // 0..1, higher reacts faster (1 = no smoothing at all)
// How stale the player's reported position already is when it reaches us (seconds).
const LISTEN_API_LATENCY_SECONDS = 1;
// Audio alignment (see audio-sync.ts): the synced map is lined up against the music actually
// playing, measured from Wallpaper Engine's live spectrum. Re-estimated this often:
const LISTEN_ALIGN_INTERVAL_MS = 4000;
// How far from the current clock to search: wide until the first lock (the reported position and
// the lead-in guess can be a couple of seconds off together), narrow afterwards.
const LISTEN_ALIGN_SEARCH_SECONDS = 3;
const LISTEN_ALIGN_LOCKED_SEARCH_SECONDS = 1;
// What counts as a trustworthy estimate: correlation at the best offset, how clearly it beats the
// next-best one (repetitive music has several near-equal candidates a beat apart), and two
// estimates in a row agreeing within this much.
const LISTEN_ALIGN_MIN_SCORE = 0.3;
// A different edit of the song (see differentEdit in searchBeatSaverForTrack) is searched across the
// whole map, where the margin can't be required (a repeated chorus matches twice), so the score
// has to be higher instead. After this many poor estimates in a row while locked, the edit has
// probably cut to a part the map doesn't line up with, and the whole map is searched again.
const LISTEN_ALIGN_WHOLE_MIN_SCORE = 0.4;
const LISTEN_ALIGN_LOST_AFTER_MISSES = 3;
// No lock at all this long after a map started (while the music plays): the reported position is
// probably off by more than the normal search range (some players — Apple Music in a browser —
// report positions that run on from earlier tracks), so the whole map is searched instead.
const LISTEN_ALIGN_WHOLE_AFTER_MS = 20_000;
const LISTEN_ALIGN_MIN_MARGIN = 0.03;
const LISTEN_ALIGN_AGREE_SECONDS = 0.05;
// Smaller corrections than this aren't worth a seek once locked.
const LISTEN_ALIGN_MIN_CORRECTION_SECONDS = 0.03;
// The sync status pill stays up until the audio lock; if none comes within this long (a remix
// that doesn't match the map's audio, audio capture off), it goes by the reported position alone.
const LISTEN_ALIGN_STATUS_TIMEOUT_MS = 60_000;

const parser: MapPackageParser = {
  parseInfo: (text) => Promise.resolve(parseInfo(text)),
  parseDifficulty: (text, songBpm, extras) => Promise.resolve(parseDifficulty(text, songBpm, extras)),
};

/** Number of authored lighting events — classic events plus v3/v4 light event box groups. */
function lightEventCount(difficulty: Difficulty | undefined): number {
  if (difficulty === undefined) return 0;
  return (
    difficulty.events.length +
    difficulty.lightColorEventBoxGroups.length +
    difficulty.lightRotationEventBoxGroups.length +
    difficulty.lightTranslationEventBoxGroups.length
  );
}

function pickBestRow(rows: DifficultyRow[]): DifficultyRow | undefined {
  const playable = rows.filter(
    (row) => row.difficulty !== undefined && row.infoDifficulty !== undefined && row.environmentId !== undefined,
  );
  // The wallpaper is all about the lightshow, so the difficulty with the most lighting events wins;
  // ties go to the later row (rows come in the map's own order, so usually the hardest). Plain "last
  // playable row" used to pick e.g. [JSaB Pack] Cheat Codes' "Lawless Expert+", which has no
  // lighting at all, while its Standard difficulties carry the whole ~35k-event show.
  let best: DifficultyRow | undefined;
  for (const row of playable) {
    if (best === undefined || lightEventCount(row.difficulty) >= lightEventCount(best.difficulty)) best = row;
  }
  return best;
}

/** Sync mode never shows a difficulty with fewer lighting events than this — a stray event or two
 *  isn't a lightshow (hasLightshowDoc in beatsaver-search.ts already filters most such maps out
 *  before download, going by BeatSaver's stats). */
const SYNC_MIN_LIGHT_EVENTS = 20;

/** Used only for "listen" mode's sync feature — the map's own note timing doubles as a rhythm
 *  reference there (see trySyncWithBeatSaverMap), and Expert+ tends to work poorly for that: it's
 *  usually dense enough that a lot of its notes are stream/pattern filler rather than clearly
 *  landing on strong beats, which was throwing the correction off. Hard and Expert notes tend to
 *  track the actual music much more closely, so they're tried first; Expert+ (or, failing that,
 *  whatever pickBestRow would choose) is still used as a fallback rather than refusing to sync a
 *  map that simply doesn't have an easier difficulty at all. */
function pickSyncRow(rows: DifficultyRow[], allowUnsupported = false): DifficultyRow | undefined {
  // Only difficulties the viewer can actually show (known environment, no Vivify) — unless the map
  // was picked by hand, and none can: then it's shown in the default environment.
  const complete = rows.filter(
    (row) => row.difficulty !== undefined && row.infoDifficulty !== undefined && row.environmentId !== undefined,
  );
  const supported = complete.filter((row) => row.environmentSupported !== false);
  const playable = supported.length > 0 || !allowUnsupported ? supported : complete;
  // Only consider difficulties that actually carry lighting, when any do — a difficulty with no
  // events (e.g. a "Lawless" characteristic) would sync perfectly and show nothing.
  const lit = playable.filter((row) => lightEventCount(row.difficulty) > 0);
  const candidates = lit.length > 0 ? lit : playable;
  for (const name of ['Hard', 'Expert', 'ExpertPlus']) {
    const match = candidates.find((row) => row.infoDifficulty?.difficulty === name);
    if (match !== undefined) return match;
  }
  return pickBestRow(candidates);
}

/** True if the mapper actually authored any lighting — some maps genuinely have none at all (just
 *  notes over the environment's default/static lighting), which isn't much of a "lightshow". */
function hasLightshowEvents(difficulty: Difficulty): boolean {
  return (
    difficulty.events.length > 0 ||
    difficulty.lightColorEventBoxGroups.length > 0 ||
    difficulty.lightRotationEventBoxGroups.length > 0 ||
    difficulty.lightTranslationEventBoxGroups.length > 0
  );
}

/** True if the map uses Chroma (custom RGB event colors and/or environment enhancements) — a
 *  positive signal, not a problem: these tend to have noticeably richer lightshows. */
function hasChromaFeatures(difficulty: Difficulty): boolean {
  const env = difficulty.chromaEnvironment;
  if (
    env.enhancements.length > 0 ||
    Object.keys(env.materials).length > 0 ||
    env.animations.length > 0 ||
    env.componentAnimations.length > 0
  ) {
    return true;
  }
  return difficulty.events.some(
    (event) =>
      event.customData !== undefined &&
      ('color' in event.customData || '_color' in event.customData || 'lightGradient' in event.customData),
  );
}

/** True if the map uses the v3 "Group Lighting System" (GLS) — the OST5-era lighting format that
 *  gives mappers per-segment/per-group control instead of just the classic on/off basic events.
 *  Also a positive signal: GLS maps tend to have noticeably more elaborate lightshows. Based
 *  purely on the actual parsed data (are any of the v3 event box group collections non-empty),
 *  not on which environment the map happens to use — a map's format doesn't strictly depend on
 *  its environment, so this is the accurate way to tell rather than guessing from an env id list. */
function usesGroupLightingSystem(difficulty: Difficulty): boolean {
  return (
    difficulty.lightColorEventBoxGroups.length > 0 ||
    difficulty.lightRotationEventBoxGroups.length > 0 ||
    difficulty.lightTranslationEventBoxGroups.length > 0
  );
}

/**
 * Measures how much silence the mapper padded onto the *start* of the map's audio file — the
 * standard second or two added in an audio editor so the player has time to get ready. That
 * padding is exactly what puts the map's timeline ahead of the streaming version of the same song:
 * musical content sitting at T seconds into the stream sits at T + leadIn seconds into the map's
 * file, so this is the constant sync needs (see trySyncWithBeatSaverMap).
 *
 * Only *digital* silence counts as padding. An editor's "insert silence" writes exact zeros, and
 * they stay (practically) zeros through the Ogg encode, while anything that belongs to the song
 * itself is also in the streaming version and must not be counted. This used to look for where the
 * music got loud instead (a threshold relative to the track's peak, walked back through a
 * fade-in), and that was systematically early-biased on real maps — the map ran *ahead* by however
 * much quiet intro the song itself has. Three reported maps showed all three ways it goes wrong:
 * a slow fade-in out of the padding (counted 0.4 s too much), a master that opens with ~2 s of
 * 16-bit dither noise after the mapper's zeros (2 s too much), and a song that opens with 1.5 s of
 * room noise and hum with no zero padding at all (1.5 s too much).
 *
 * Returns 0 when the file starts straight into sound (no padding), which is normal and needs no
 * correction. Scanned across all channels in short windows; the level test sits just below 16-bit
 * dither (≈ -90 dBFS), so dithered silence from a CD master counts as the song while an encoder's
 * rounding residue in the zeros doesn't.
 */
function detectLeadInSeconds(buffer: AudioBuffer): number {
  const WINDOW_SECONDS = 0.005;
  const MAX_SCAN_SECONDS = 15; // padding is a second or two in practice; past this, assume none
  const PADDING_PEAK = 3e-5; // ≈ -90 dBFS: below 16-bit dither, far above Vorbis residue in zeros
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const length = Math.min(buffer.length, Math.floor(buffer.sampleRate * MAX_SCAN_SECONDS));
  const windowSamples = Math.max(1, Math.floor(buffer.sampleRate * WINDOW_SECONDS));
  for (let start = 0; start < length; start += windowSamples) {
    const end = Math.min(start + windowSamples, length);
    for (const channel of channels) {
      for (let i = start; i < end; i++) {
        const sample = channel[i] ?? 0;
        if (sample > PADDING_PEAK || sample < -PADDING_PEAK) return start / buffer.sampleRate;
      }
    }
  }
  return 0; // silent for the whole scan: something unusual, don't shift anything
}

function setStatus(state: 'playing' | 'error' | 'listening-idle') {
  document.body.dataset.state = state;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Matches the CSS transition duration on #environment-fade in index.html — kept as one constant
// so the two can't drift out of sync with each other.
const ENVIRONMENT_FADE_MS = 400;

/** Fades the screen to black before an environment switch, so the swap itself (including whatever
 *  the new environment's own assets briefly look like while loading) happens hidden rather than as
 *  a hard, jarring cut. Resolves once fully black; the caller is expected to call
 *  fadeFromBlack() afterwards once the new environment is actually ready. Silently does nothing if
 *  the overlay element isn't there for some reason — a missing fade is a cosmetic downgrade, not a
 *  reason to fail the whole track switch. */
async function fadeToBlack() {
  const overlay = document.getElementById('environment-fade');
  if (overlay === null) return;
  overlay.style.opacity = '1';
  await sleep(ENVIRONMENT_FADE_MS);
}

/** See fadeToBlack. Deliberately not awaited by most callers — the reveal can happen while the
 *  rest of that track's setup (clock, HUD, etc.) finishes concurrently, since none of that is
 *  itself visible until the fade has cleared anyway. */
async function fadeFromBlack() {
  const overlay = document.getElementById('environment-fade');
  if (overlay === null) return;
  overlay.style.opacity = '0';
  await sleep(ENVIRONMENT_FADE_MS);
}

/** Environment load failures worth reporting. A load that was *cancelled* is not one: that just
 *  means a newer request replaced it (a settings change, the next track, the renderer being
 *  rebuilt) — expected, and the newer load reports on its own. */
function logEnvironmentError(context: string, error: { _tag?: string }) {
  if (error._tag === 'EnvironmentLoadAborted') return;
  console.error(`[wallpaper] ${context}`, error);
}

async function main() {
  installDebugLog();
  // Applied immediately, before any Wallpaper Engine property has necessarily arrived yet, so the
  // very first frame of static text (button labels, badges) isn't stuck in Russian regardless of
  // what the ui_language property eventually resolves to — the auto-detected language is a
  // reasonable default in its own right, not just a placeholder waiting to be overridden.
  setLanguage(resolveAutoLanguage());
  applyStaticTranslations();

  const appElement = document.querySelector<HTMLDivElement>('#app');
  if (appElement === null) throw new Error('missing #app element');
  const container: HTMLDivElement = appElement; // (non-null for the closures below too)

  function createCanvas(): HTMLCanvasElement {
    const existing = container.querySelector('canvas');
    // A fresh <canvas> element (rather than reusing the old one) sidesteps any ambiguity around
    // whether the previous WebGL context was fully released — each canvas gets its own context.
    existing?.remove();
    const canvas = document.createElement('canvas');
    canvas.id = 'wallpaper-canvas';
    container.appendChild(canvas);
    return canvas;
  }

  /** "1 ГБ", "512 МБ" — the cache limit for messages. */
  function formatCacheSize(bytes: number) {
    const megabytes = Math.round(bytes / 1024 / 1024);
    return megabytes >= 1024 && megabytes % 1024 === 0
      ? t('size_gb', { value: String(megabytes / 1024) })
      : megabytes >= 1024
        ? t('size_gb', { value: (megabytes / 1024).toFixed(1) })
        : t('size_mb', { value: String(megabytes) });
  }

  // "Map cache size" — see onCacheSizeChange.
  let cacheSizeInitialized = false;
  let cacheSizeTimer: number | null = null;
  // (If the saved settings have no value for it at all, the first change is still a real one.)
  window.setTimeout(() => {
    cacheSizeInitialized = true;
  }, 10_000);

  // FPS counter ("FPS counter" in the settings): frames actually rendered, averaged over half a
  // second so the number is readable rather than flickering.
  let fpsTimer: number | null = null;
  function setFpsCounterEnabled(enabled: boolean) {
    if (!enabled) {
      if (fpsTimer !== null) window.clearInterval(fpsTimer);
      fpsTimer = null;
      setFps(null);
      return;
    }
    if (fpsTimer !== null) return;
    let lastFrames = RendererLifecycle.renderedFrames;
    let lastTime = performance.now();
    setFps(0);
    fpsTimer = window.setInterval(() => {
      const now = performance.now();
      const frames = RendererLifecycle.renderedFrames;
      setFps(((frames - lastFrames) * 1000) / Math.max(now - lastTime, 1));
      lastFrames = frames;
      lastTime = now;
    }, 500);
  }

  // Graphics settings live here so they survive a mirror-quality change, which needs to tear
  // down and recreate the whole renderer (mirror reflection resolution is baked in at creation).
  const graphics = {
    mirrorQuality: DEFAULT_WALLPAPER_CONTROLS.mirrorQuality as MirrorQuality,
    screenDisplacement: DEFAULT_WALLPAPER_CONTROLS.screenDisplacement,
    showPlayerPlatform: DEFAULT_WALLPAPER_CONTROLS.showPlayerPlatform,
    showWalls: DEFAULT_WALLPAPER_CONTROLS.showWalls,
    renderScale: DEFAULT_WALLPAPER_CONTROLS.renderScale,
    cameraFov: DEFAULT_WALLPAPER_CONTROLS.cameraFov,
    cameraDistance: DEFAULT_WALLPAPER_CONTROLS.cameraDistance,
  };

  let lifecycle: RendererLifecycle;
  let view: MapView;
  // Whether the currently loaded track requires Noodle Extensions — the per-track half of
  // applyShowWalls's decision, alongside the graphics.showWalls checkbox. Updated wherever a track
  // actually gets loaded into the view (the sync path).
  let currentRequiresNoodleExtensions = false;
  let parallaxEnabled = DEFAULT_WALLPAPER_CONTROLS.parallaxEnabled;
  let parallaxIntensity = DEFAULT_WALLPAPER_CONTROLS.parallaxIntensity;
  let parallaxInvertX = DEFAULT_WALLPAPER_CONTROLS.parallaxInvertX;
  let parallaxInvertY = DEFAULT_WALLPAPER_CONTROLS.parallaxInvertY;
  let parallaxJelly = DEFAULT_WALLPAPER_CONTROLS.parallaxJelly;

  // "Listen" mode state (experimental — see the README section on it for the full explanation of
  // how this works and its limitations).
  let listenEnvironmentId = DEFAULT_WALLPAPER_CONTROLS.listenEnvironment;
  let listenUpdateTimer: number | null = null;
  let listenEvents: BasicEvent[] = [];
  let listenStartPerfTime = 0;
  let listenLastAudioActivityTime = 0;
  // When the current stretch of continuous sound began (see LISTEN_UNTITLED_START_MS).
  let listenSoundStreakStart = 0;
  let listenShowingAmbient = true;
  // Idle show state: the beat the currently scheduled color drift lands on (null = not running),
  // the palette it's heading to, and when the next ring nudge is due.
  let ambientSegmentEnd: number | null = null;
  let ambientPalette: LightPalette | null = null;
  let ambientBreathIn = false;
  let ambientNextRingBeat = 0;
  let ambientRingDirectionPhase = 0;
  let ambientRingHalfPeriod = AMBIENT_RING_HALF_PERIOD_MIN_BEATS;
  let ambientFanPhase = 0;
  let ambientZoomPhase = 0;
  let ambientNextZoomBeat = 0;
  // "Sync mode": look up whatever's playing on BeatSaver and show its own real lightshow instead
  // of the generated one, seeked to the estimated playback position.
  let listenSyncEnabled = false;
  // "Also V3/Noodle maps": with it off, sync skips maps on a V3 (GLS) capable environment or using
  // Noodle Extensions (heavier to render).
  let listenSyncRichMaps = true;
  // Screensaver "new track" randomization (see randomizeListenLook). listenActiveEnvironmentId is
  // what the generated show is on right now — the user's listen_environment until a random switch
  // replaces it; listenEnvironmentId itself always stays the user's own choice.
  let listenRandomEnvironment = false;
  let listenRandomColors = false;
  // "Light colors" (see onListenColorsChange): the user's own two colors when set to "My colors",
  // and whether random/own colors also replace a synced map's (only maps without Chroma/V3).
  let listenCustomColors: { left: Rgb; right: Rgb } | null = null;
  let listenColorsSynced = false;
  let listenActiveEnvironmentId = listenEnvironmentId;
  let listenPalette: LightPalette | null = null;
  let listenColorOverride: InfoColorScheme | undefined;
  // What the last render-data rebuild was made from (see tickListenMode): skips rebuilding on the
  // fast ticks where nothing changed.
  let listenRebuiltLength = -1;
  let listenRebuiltTail: BasicEvent | undefined;
  let listenRebuiltOverride: InfoColorScheme | undefined;
  let listenRebuiltAt = 0;
  // The events the last rebuild was made from — new ones not in here decide how urgent the next is.
  let listenBuiltEvents = new Set<BasicEvent>();
  let wallpaperPaused = false;
  // Both on by default (project.json); see the startup notices after listenForWallpaperControls.
  let epilepsyWarningEnabled = true;
  let uiHintEnabled = true;
  let startupNoticesDone = false;
  let listenLookToken = 0;
  let listenSyncActive = false;
  let listenLastSyncTitle = '';
  let listenLastDisplayedTitle = '';
  let listenLastDisplayedThumbnail: string | null = null;
  let listenSyncToken = 0;
  let mediaPosition: number | null = null;
  let mediaDuration: number | null = null;
  let listenSyncClock: SongClock | null = null;
  let listenSyncOffsetSeconds = 0;
  const listenApiLatencySeconds = LISTEN_API_LATENCY_SECONDS;
  let listenLastSeekDetectedAt = 0;
  let listenPendingHardSeek: number | null = null;
  let listenSyncPaused = false;
  let listenSyncConfident = false;
  let listenLastSyncCorrectionAt = 0;
  // The one constant that actually needs learning: how far the map's own audio sits from the
  // streaming version of the same song (different edits, different lead-in silence). Everything
  // else about where we are in the track comes live from the player's own reported position, so
  // this is set once when sync starts and then left alone for the rest of the track.
  let listenSyncLearnedOffset = 0;
  let listenLastSoftResyncCheckAt = 0;
  // Audio alignment state (see LISTEN_ALIGN_* and audio-sync.ts). The reference is the synced map's
  // own onset curve, built in the background once its audio is decoded. Once locked, the map clock
  // runs on its own and only the audio corrects it: the reported position is still used to catch
  // real seeks, but its reading-to-reading jitter no longer nudges the clock.
  let listenSyncReference: SyncReference | null = null;
  const listenAligner = new SyncAligner();
  let listenAudioLocked = false;
  // Whether the audio has placed the map at all since the last reset (a new track, a seek, a
  // pause). From then on only the audio moves the clock: losing the lock later just widens the
  // audio search, and the reported position no longer pulls the map back to its own estimate
  // (which is exactly what the audio corrected — see the soft resync in tickListenMode).
  let listenAudioFound = false;
  let listenAlignCandidate: number | null = null;
  let listenLastAlignAt = 0;
  // Since when the current lock attempt has been running (see LISTEN_ALIGN_STATUS_TIMEOUT_MS), and
  // whether the map's audio could be analysed at all.
  let listenAlignSince = 0;
  let listenAlignUnavailable = false;
  // The synced map is a different edit of the playing song: its timeline has no fixed relation to
  // the player's position, so only the audio places it (searched across the whole map).
  let listenSyncDifferentEdit = false;
  // The track the synced map is remembered under (see sync-memory.ts), while synced.
  let listenSyncMemory: { title: string; artist: string; hash: string } | null = null;
  // The versions of the song found for the current track — the player's "Other versions" list
  // (null: no search for this track, sync off). bestHash is the search's own pick.
  let listenVersions: { title: string; artist: string; versions: MapVersion[]; bestHash: string | null } | null = null;
  // The synced map as a version of the song (what "played to the end" remembers), while synced.
  let listenSyncPlayingVersion: MapVersion | null = null;
  let listenSyncCompletedMarked = false;
  // Handover (see holdSyncedMap): the previous track's map stays on screen, still running, while the next
  // track's map is being searched for — the generated show only comes back if that search fails.
  let listenSyncHandover = false;
  // The synced map's difficulty, for re-applying colors when a color setting changes.
  let listenSyncRow: DifficultyRow | null = null;
  let listenSyncHandoverSince = 0;
  let listenSyncStartedAt = 0;
  let listenSyncHandoverGraceMs = LISTEN_SYNC_END_GRACE_MS;
  // The track info went away (see LISTEN_SYNC_TITLE_LOST_GRACE_MS): the next title counts as new
  // even if it's the same one.
  let listenTitleLost = false;
  let listenSyncSearching = false;
  // Until when a one-off sync message ("not found", "download failed") keeps the status pill.
  let listenSyncMessageUntil = 0;
  let listenAlignMisses = 0;
  let listenAlignLost = false;
  let listenHandledSeekAt = 0;
  // The map's _songTimeOffset: song time = file time + this (see createClock's audio offset).
  let listenSyncSongTimeOffset = 0;
  let listenSyncCoverUrl: string | null = null;
  let mediaPositionUpdatedAt = 0;
  // When the player last reported a position further along than before (not a seek) — a sign it's
  // playing even when nothing is audible.
  let mediaPositionAdvancedAt = 0;
  // When the reported duration last actually changed value, and when the track title last changed —
  // together they decide whether mediaDuration belongs to the current track (see freshMediaDuration).
  let mediaDurationChangedAt = 0;
  let mediaTitleChangedAt = 0;
  // The music-reactive show: tempo/beat tracking + mapper-style patterns, all from Wallpaper
  // Engine's own audio spectrum (see listen-lightshow.ts). Fed every audio frame; asked for newly
  // due light events every tick.
  const listenShow = new ListenLightshow();
  listenShow.responsiveness = LISTEN_DEFAULT_SMOOTHING; // (was the same "reaction speed" slider)
  // Smooth color glides (sustained passages, layered style) move between the environment's own
  // left/right colors — whatever is on screen right now, including a randomized palette.
  listenShow.colorProvider = () => {
    const colors = view.currentColors;
    return { left: colors.environmentLeft, right: colors.environmentRight };
  };
  let listenLastLoggedStyle = '';
  // Recent loud level of the captured audio (a slowly sinking peak) and when the last frame with
  // sound in it arrived — see LISTEN_SOUND_*.
  let listenRecentPeak = 0;
  let listenRecentPeakAt = 0;
  let listenLastSoundFrameAt = 0;
  let mediaTitle = '';
  let mediaArtist = '';
  let mediaGenres = '';
  let mediaAlbum = '';
  // When the thumbnail last actually *changed* (repeats of the same image don't count) — used to
  // tell whether the cover on hand belongs to the current track (see listenCover()).
  let mediaThumbnailChangedAt = 0;
  // Per-track cover state for the screensaver panel, reset on every title change.
  let listenCoverTrackStart = 0;
  let listenCoverAlbumChanged = false;
  let listenCoverAlbumKey = '';
  let listenOnlineCover: string | null = null;
  let listenOnlineCoverRequested = false;
  let mediaThumbnail: string | null = null;
  let hasWarnedAboutMediaIntegration = false;
  let hasReceivedAnyAudioData = false;
  let hasWarnedAboutAudioData = false;
  /** Walls only ever show for maps that require Noodle Extensions — NE maps frequently use walls
   *  as decorative/animated scenery rather than obstacles to dodge, so hiding them there would
   *  remove content the mapper actually intended to be seen. For every other map they're gameplay
   *  obstacles that just read as clutter flying at a passive camera, so the graphics.showWalls
   *  checkbox has no effect on them at all — it only shows/hides walls within an NE map, never
   *  forces them on for a regular one. Called on every renderer (re)creation and whenever either
   *  input changes (the checkbox, or a new track finishing loading). */
  function applyShowWalls() {
    console.log(
      `[wallpaper] applyShowWalls (lightshow-walls build): showWalls=${graphics.showWalls} requiresNoodleExtensions=${currentRequiresNoodleExtensions} -> ${graphics.showWalls && currentRequiresNoodleExtensions}`,
    );
    view.setShowWalls(currentRequiresNoodleExtensions && graphics.showWalls);
  }

  function createRenderer() {
    const canvas = createCanvas();
    const nextLifecycle = new RendererLifecycle();
    nextLifecycle.attach(canvas);
    nextLifecycle.setRenderScale(graphics.renderScale);

    const nextView = new MapView(
      { mirrorQuality: graphics.mirrorQuality },
      () => undefined,
      () => null,
    );
    nextLifecycle.setView(nextView);
    nextView.setLightshowMode('full-lightshow');
    nextView.setScreenDisplacementEffects(graphics.screenDisplacement);
    nextView.setShowPlayerPlatform(graphics.showPlayerPlatform);
    // Mirrors applyShowWalls's own logic (see its doc comment) — inlined here rather than called
    // through it because this runs on nextView, before it's actually assigned to the outer `view`
    // that helper operates on.
    nextView.setShowWalls(currentRequiresNoodleExtensions && graphics.showWalls);
    nextView.setReplayCameraSettings({
      ...DEFAULT_REPLAY_CAMERA_SETTINGS,
      replayCameraFov: graphics.cameraFov,
      previewCameraDistance: graphics.cameraDistance,
    });
    nextView.setParallaxJelly(parallaxJelly);
    return { lifecycle: nextLifecycle, view: nextView };
  }

  // Start with the user's own settings rather than the defaults (see waitForInitialProperties).
  void initMapArchiveCache();
  const initialProperties = await waitForInitialProperties(INITIAL_PROPERTIES_TIMEOUT_MS);
  const initialMirrorQuality = initialProperties?.mirror_quality?.value;
  if (initialMirrorQuality === 'none' || initialMirrorQuality === 'low' || initialMirrorQuality === 'medium' || initialMirrorQuality === 'high') {
    graphics.mirrorQuality = initialMirrorQuality;
  }
  const initialRenderScale = initialProperties?.render_scale?.value;
  if (typeof initialRenderScale === 'number') graphics.renderScale = initialRenderScale / 100;

  ({ lifecycle, view } = createRenderer());

  // ===== The screensaver ("listen" mode) =====
  // Generates a live lightshow from system audio (Wallpaper Engine's audio-visualizer API) and
  // shows what's currently playing on the PC (Wallpaper Engine's media integration API). One
  // ticking loop runs the whole time and decides every cycle, from real audio silence *and* the
  // media title, between two shows:
  // - the music show (listen-lightshow.ts): tracks tempo and beats from the spectrum and lights the
  //   song the way hand-lit reference maps do — works fully offline;
  // - the calm idle show below, for when nothing is playing.
  // Both are built from classic Beat Saber light events scheduled on the timeline, so the renderer
  // animates fades/transitions smoothly on its own.

  /** The calm idle show — used whenever nothing is playing, or when actual sound has been silent
   *  for a while even though a track is technically still "open" (e.g. paused; the media API alone
   *  can't tell us that, only the audio API can).
   *
   *  Everything here moves continuously instead of in steps:
   *  - Lights are always on, dimmed, and drift between harmonious colors: every
   *    AMBIENT_SEGMENT_BEATS a new target color is scheduled *in the future* as a "transition" event
   *    (value 4, Chroma color, HSV lerp, ease-in-out), so the renderer interpolates towards it the
   *    whole time rather than jumping. Brightness breathes gently between segments.
   *  - Rings get a small rotation nudge every half second with a slow approach speed, which blends
   *    into one steady turn.
   *  - The rotating lasers get a single slow-speed event that keeps their current angle
   *    (lockRotation), so they just slow down into a gentle sweep instead of snapping.
   *  Entering it (song ended, silence) starts with a fade-in from whatever the reactive show left,
   *  so there's no cut either. */
  const AMBIENT_LIGHTS: readonly { type: number; side: 'left' | 'right'; dim: number; bright: number }[] = [
    { type: 0, side: 'left', dim: 0.25, bright: 0.55 }, // back lasers
    { type: 1, side: 'right', dim: 0.3, bright: 0.6 }, // ring lights
    { type: 2, side: 'left', dim: 0.35, bright: 0.7 }, // left rotating lasers
    { type: 3, side: 'right', dim: 0.35, bright: 0.7 }, // right rotating lasers
    { type: 4, side: 'left', dim: 0.2, bright: 0.45 }, // center
  ];

  function scheduleAmbientSegment(fromBeat: number, lengthBeats: number) {
    ambientPalette = randomHarmoniousPalette(ambientPalette);
    ambientBreathIn = !ambientBreathIn;
    const target = fromBeat + lengthBeats;
    for (const light of AMBIENT_LIGHTS) {
      const color = light.side === 'left' ? ambientPalette.left : ambientPalette.right;
      // Lasers breathe opposite to the rest, so something is always gently rising while
      // something else settles.
      const rising = light.type === 2 || light.type === 3 ? !ambientBreathIn : ambientBreathIn;
      listenEvents.push({
        jsonTime: target,
        songBpmTime: target,
        type: light.type,
        value: 4, // transition — the renderer eases from the previous event to this one
        floatValue: rising ? light.bright : light.dim,
        customData: { color: [color[0], color[1], color[2], 1], lerpType: 'HSV', easing: 'easeInOutSine' },
      });
    }
    ambientSegmentEnd = target;
  }

  /** An event that pins a light to exactly what it shows right now (color and brightness), so a
   *  transition scheduled after it starts from *now*. Without it a transition eases from the light's
   *  previous event — often long in the past — and is already mostly "done" the moment it's added,
   *  which is what made the idle show pop in instead of fading in. Flashes/fades mid-decay are
   *  captured at their current brightness too (they can't be eased out of directly). */
  function currentLightAnchor(type: number, beat: number): BasicEvent {
    const events = listenEvents.filter((event) => event.type === type).sort((a, b) => a.songBpmTime - b.songBpmTime);
    let last: BasicEvent | undefined;
    for (const event of events) if (event.songBpmTime <= beat) last = event;
    if (last === undefined) return { jsonTime: beat, songBpmTime: beat, type, value: 0, floatValue: 0 };
    // Off stays a real "off" (keeps an environment's dim off-glow exactly as it was).
    if (last.value === 0) return { ...last, jsonTime: beat, songBpmTime: beat };
    const sample = sampleBasicLightTimeline(createBasicLightTimeline(events), beat, {
      songBpm: LISTEN_FAKE_BPM,
      offIntensity: 0,
      lightOnStart: false,
      normalAlpha: GAME_LIGHT_NORMAL_ALPHA,
      highlightAlpha: GAME_LIGHT_HIGHLIGHT_ALPHA,
    });
    const color = resolveBasicLightColor(sample, view.currentColors, false, false);
    const alpha = Math.max(resolveBasicLightAlpha(sample), 0);
    return {
      jsonTime: beat,
      songBpmTime: beat,
      type,
      value: 4,
      floatValue: alpha / GAME_LIGHT_NORMAL_ALPHA,
      customData: { color: [color[0], color[1], color[2], 1] },
    };
  }

  function startListenAmbient(beat: number) {
    // Anchor every light where it is right now, then drop anything the music show had already
    // scheduled ahead (up to ~0.6 s) so it can't cut into the fade-in.
    const anchors = AMBIENT_LIGHTS.map((light) => currentLightAnchor(light.type, beat));
    listenEvents = listenEvents.filter((event) => event.songBpmTime <= beat);
    listenEvents.push(...anchors);
    // Slow the rotating lasers down without resetting where they're pointing (lockRotation). No
    // explicit direction: each laser then picks its own (from its own seed), so within a group some
    // turn one way and some the other — lasers slowly drift apart and cross over each other. A
    // single event rather than a stepped slow-down, since every event re-picks each laser's
    // direction (steps would make some of them flip back and forth). It's the only laser event per
    // idle stretch: with lockRotation it continues from the angle the history before it left, so
    // that history has to stay (see trimListenEvents).
    for (const laserType of [12, 13]) {
      listenEvents.push({
        jsonTime: beat,
        songBpmTime: beat,
        type: laserType,
        value: 1,
        floatValue: 1,
        customData: { preciseSpeed: AMBIENT_LASER_SPEED, lockRotation: true },
      });
    }
    ambientNextRingBeat = beat;
    ambientNextZoomBeat = beat;
    // Start from standstill (phase 0 or π → speed 0) in a random direction, so the rings ease into
    // motion instead of starting at full speed. The fan starts closed; the zoom starts at its widest
    // spacing, which is about where environments keep their rings by default (so no initial pull).
    ambientRingDirectionPhase = Math.random() < 0.5 ? 0 : Math.PI;
    ambientRingHalfPeriod = randomRingHalfPeriod();
    ambientFanPhase = 0;
    ambientZoomPhase = Math.PI;
    scheduleAmbientSegment(beat, AMBIENT_FADE_IN_BEATS);
  }

  /** Leaving the idle show: forget the color drift it had scheduled ahead of time, so the reactive
   *  show's own events take over from right now instead of being overridden by a future target. */
  function stopListenAmbient(beat: number) {
    if (ambientSegmentEnd === null) return;
    ambientSegmentEnd = null;
    // Pin every light where its color drift currently is before dropping the scheduled targets —
    // otherwise it would snap back to the drift's starting color.
    const anchors = AMBIENT_LIGHTS.map((light) => currentLightAnchor(light.type, beat));
    listenEvents = listenEvents.filter((event) => event.songBpmTime <= beat);
    listenEvents.push(...anchors);
    // Let the idle glow ease out over a second instead of lingering under the reactive show; the
    // reactive show's own hits (fades/flashes) play on top of this as usual.
    for (const light of AMBIENT_LIGHTS) {
      listenEvents.push({ jsonTime: beat + 2, songBpmTime: beat + 2, type: light.type, value: 4, floatValue: 0 });
    }
  }

  function tickListenAmbient(beat: number) {
    if (ambientSegmentEnd === null) startListenAmbient(beat);
    if (ambientSegmentEnd !== null && beat >= ambientSegmentEnd) {
      scheduleAmbientSegment(ambientSegmentEnd, AMBIENT_SEGMENT_BEATS);
    }
    while (beat >= ambientNextRingBeat) {
      // Speed follows a flattened sine: long stretches at a steady pace, easing through zero into
      // the opposite direction. The sign of `rotation` is the direction (direction: 0 = as given).
      const shaped = Math.tanh(2 * Math.sin(ambientRingDirectionPhase)) / Math.tanh(2);
      const fan = AMBIENT_RING_FAN_MAX_DEGREES * (0.5 - 0.5 * Math.cos(ambientFanPhase));
      listenEvents.push({
        jsonTime: ambientNextRingBeat,
        songBpmTime: ambientNextRingBeat,
        type: 8,
        value: 0,
        floatValue: 1,
        // Small rotation, slow approach: consecutive nudges overlap into one continuous turn.
        // Explicit direction/step keep it deterministic (no per-event randomness).
        customData: { rotation: AMBIENT_RING_ROTATION * shaped, step: fan, prop: 1, speed: 0.5, direction: 0 },
      });
      const halfTurnsBefore = Math.floor(ambientRingDirectionPhase / Math.PI);
      ambientRingDirectionPhase += Math.PI / ambientRingHalfPeriod;
      if (Math.floor(ambientRingDirectionPhase / Math.PI) !== halfTurnsBefore) ambientRingHalfPeriod = randomRingHalfPeriod();
      ambientFanPhase += (2 * Math.PI) / AMBIENT_RING_FAN_PERIOD_BEATS;
      ambientNextRingBeat += AMBIENT_RING_STEP_BEATS;
    }
    while (beat >= ambientNextZoomBeat) {
      const zoom = AMBIENT_ZOOM_MIN_STEP + (AMBIENT_ZOOM_MAX_STEP - AMBIENT_ZOOM_MIN_STEP) * (0.5 - 0.5 * Math.cos(ambientZoomPhase));
      listenEvents.push({
        jsonTime: ambientNextZoomBeat,
        songBpmTime: ambientNextZoomBeat,
        type: 9,
        value: 0,
        floatValue: 1,
        // Absolute spacing target + a slow approach → the rings glide apart and back together.
        customData: { step: zoom, speed: 0.4 },
      });
      ambientZoomPhase += (2 * Math.PI * AMBIENT_ZOOM_EVERY_BEATS) / AMBIENT_ZOOM_PERIOD_BEATS;
      ambientNextZoomBeat += AMBIENT_ZOOM_EVERY_BEATS;
    }
  }

  function randomRingHalfPeriod() {
    return (
      AMBIENT_RING_HALF_PERIOD_MIN_BEATS +
      Math.random() * (AMBIENT_RING_HALF_PERIOD_MAX_BEATS - AMBIENT_RING_HALF_PERIOD_MIN_BEATS)
    );
  }

  /** Combines the last known position report with how much real time has passed since, so we're
   *  not stuck with a stale number by the time a sync search+download actually finishes. Returns
   *  null if the current media player never sends timeline updates at all — not all of them do. */
  /** estimateCurrentPosition, but only from a reading of the track that's playing now: until the
   *  player reports one after the title change, the time since that change (see
   *  FRESH_POSITION_WAIT_MS). */
  function positionOfThisTrack(): number | null {
    if (mediaPosition === null) return null;
    if (mediaPositionUpdatedAt < mediaTitleChangedAt) return (performance.now() - mediaTitleChangedAt) / 1000;
    return estimateCurrentPosition();
  }

  function estimateCurrentPosition(): number | null {
    if (mediaPosition === null) return null;
    // listenApiLatencySeconds compensates for the position value already being stale by the time
    // it reaches us: we can only timestamp when the update *arrived*, not when the player actually
    // sampled it, so without this everything sits systematically behind by that delivery delay.
    // Your measurements put it around 1.0-1.7s on your machine, which is far too large to leave
    // uncorrected — but it also varied by ~0.7s between readings, so this can only remove the
    // consistent part of it (see the README for what that means for the rest).
    return mediaPosition + (performance.now() - mediaPositionUpdatedAt) / 1000 + listenApiLatencySeconds;
  }

  /**
   * "Sync mode": looks up the currently-playing track on BeatSaver, and if a map turns out to
   * exist for it, downloads it and shows its own real, authored lightshow — seeked to the
   * estimated position — instead of the generated one. Only ever changes what's on screen; never
   * plays the downloaded map's own audio (that would echo against whatever's actually already
   * audible from the PC's own player) — the beat clock driving the light events is just a plain
   * timer offset to line up with the estimated position, the actual sound stays exactly as it was.
   */
  /** Disposes whatever sync clock is currently running, if any — used whenever sync mode is about
   *  to be superseded (new track, toggled off, silence, leaving listen mode) so its AudioContext
   *  and decoded buffer don't leak. */
  function disposeListenSyncClock() {
    if (listenSyncClock !== null) {
      listenSyncClock.dispose();
      listenSyncClock = null;
    }
  }

  /** Leaves sync mode (if it was active) and hands the view back to whatever the generated show
   *  needs — most importantly, resets the environment back to the user's chosen listen_environment,
   *  since a synced map switches it to that map's *own* environment while it's showing. Forgetting
   *  this step was the actual cause of "stuck on the wrong environment and stops reacting to sound"
   *  after a synced map ended — the generated show doesn't know how to light up an environment
   *  it wasn't built for (worse still if that environment happens to be GLS/V3, which the classic
   *  event types this whole thing is built on don't address at all). Safe to call even when sync
   *  wasn't active. */
  /**
   * Keeps the synced map on screen instead of dropping back to the generated show: at a
   * track change while the next track's map is searched for (a found map then takes over through
   * its own fade, and only a failed search brings the generated show back — see tickListenMode),
   * or when the map runs out just before the player reports the next track (for up to
   * LISTEN_SYNC_END_GRACE_MS). Without this, the screensaver flashed up between two synced maps.
   * The map keeps running meanwhile (its lights don't freeze while the next one loads); one that ran
   * out simply stays on its last frame.
   */
  function holdSyncedMap(graceMs = LISTEN_SYNC_END_GRACE_MS) {
    if (!listenSyncActive || listenSyncHandover) return;
    listenSyncHandover = true;
    listenSyncHandoverSince = performance.now();
    listenSyncHandoverGraceMs = graceMs;
    listenSyncReference = null;
    resetAudioAlignment();
  }

  function exitSyncMode(options: { restoreEnvironment?: boolean } = {}) {
    if (!listenSyncActive) return;
    listenSyncActive = false;
    listenSyncHandover = false;
    listenSyncRow = null;
    listenRebuiltLength = -1; // the view shows the synced map — put the generated show back next tick
    disposeListenSyncClock();
    // The render loop samples the beat source every frame regardless of what mode we're in — if
    // it's still the one from trySyncWithBeatSaverMap (() => clock.currentBeat()) after the clock
    // above has just been disposed, every single frame from here on calls into a torn-down
    // AudioContext. Whatever that actually does under the hood (throw, return something frozen or
    // wrong), the practical effect was exactly what got reported: the scene visibly switches back
    // to the chosen environment, but nothing about it reacts to sound any more, because the light
    // sampling that depends on a valid beat value silently stops working while everything else
    // (camera, the environment itself) keeps rendering fine. Re-establishing the generated show's
    // own beat source here, before anything else gets a chance to read the stale one, is what
    // actually fixes it — not just disposing the clock, which was already happening.
    view.setBeatSource(() => (performance.now() - listenStartPerfTime) / 1000 / (60 / LISTEN_FAKE_BPM));
    setListenSyncStatus(null);
    listenSyncLearnedOffset = 0;
    listenSyncSongTimeOffset = 0;
    listenSyncDifferentEdit = false;
    listenSyncMemory = null;
    listenSyncPlayingVersion = null;
    refreshVersionsView();
    listenSyncReference = null;
    resetAudioAlignment();
    listenPendingHardSeek = null;
    listenSyncPaused = false;
    listenSyncConfident = false;
    delete document.body.dataset.listenSyncing;
    if (listenSyncCoverUrl !== null && listenSyncCoverUrl.startsWith('blob:')) URL.revokeObjectURL(listenSyncCoverUrl);
    listenSyncCoverUrl = null;
    // Force the next tick's HUD update to redisplay from the media API unconditionally, rather
    // than only if the title/thumbnail happen to differ from whatever they were the last time this
    // (rather than the sync path) actually called setTrack() — which could be from well before
    // sync started.
    listenLastDisplayedTitle = '';
    listenLastDisplayedThumbnail = null;
    // Back to the screensaver's environment through a fade too. (The id is read after the fade:
    // a track change can pick a new random environment meanwhile, and that one should win.)
    // Not when a new sync started meanwhile: that brings its own environment and fade, which this
    // must not undo.
    // (Skipped when a random environment for the new track follows right away, see tickListenMode —
    // two fades in a row, the second undoing the first.)
    if (options.restoreEnvironment === false) return;
    void (async () => {
      await fadeToBlack();
      if (listenSyncActive) return;
      const result = await view.setEnvironment(listenActiveEnvironmentId);
      if (result.isErr()) logEnvironmentError('failed to restore listen-mode environment after sync', result.error);
      listenRebuiltLength = -1;
      void fadeFromBlack();
    })();
  }

  /**
   * "Sync mode": looks up the currently-playing track on BeatSaver, and if a map turns out to
   * exist for it, downloads it and shows its own real, authored lightshow — seeked to the
   * estimated position — instead of the generated one.
   *
   * This runs the regular clock machinery of a map (createAudioClock, decoding the map's own audio
   * and all) rather than a hand-rolled elapsed-time formula — the earlier version assumed a single
   * constant BPM for the whole song, which breaks the moment a map has any BPM change events
   * (createAudioClock's own beat conversion doesn't have that problem, since a real map's
   * note/event timings are already pre-converted into a BPM-change-aware timeline before the clock
   * ever sees them — see recomputeSongBpmTimes in core/beatmap/bpm.ts). The one difference from
   * playing the map for real: the clock's volume is immediately set to 0. We still decode and
   * "play" the audio internally (that's what drives correct, drift-free timing), just muted — the actual
   * sound stays exactly what's already audible from the PC's own player, never a second copy of it.
   */
  /** mediaDuration if it was reported for the track that's playing now — i.e. it last changed
   *  after (or just before, see DURATION_PRE_TITLE_GRACE_MS) the title did — otherwise null. */
  function freshMediaDuration(): number | null {
    if (mediaDuration === null || mediaDuration <= 0) return null;
    return mediaDurationChangedAt >= mediaTitleChangedAt - DURATION_PRE_TITLE_GRACE_MS ? mediaDuration : null;
  }

  /** Forgets the live audio collected so far and the lock — after anything that may have moved
   *  the music relative to the map clock (a seek, a pause, a new track). */
  function resetAudioAlignment() {
    listenAligner.clear();
    listenAudioLocked = false;
    listenAudioFound = false;
    listenAlignCandidate = null;
    listenLastAlignAt = performance.now();
    listenAlignSince = performance.now();
    listenAlignMisses = 0;
    listenAlignLost = false;
  }

  /** The sync status pill once the map is on screen: "paused", "syncing" until the map is locked
   *  to the audio, then gone. When the audio can't lock it (no audio capture, the map's audio
   *  couldn't be analysed, or no lock within LISTEN_ALIGN_STATUS_TIMEOUT_MS), it goes away once
   *  the reported position has held without corrections instead. */
  function showSyncMessage(status: 'not_found' | 'download_failed') {
    setListenSyncStatus(status);
    listenSyncMessageUntil = performance.now() + SYNC_MESSAGE_HOLD_MS;
  }

  function refreshSyncStatus() {
    if (!listenSyncActive) return;
    // A new map being searched for / downloaded (another version chosen in the player) reports its
    // own progress, and a one-off message ("not found"…) stays up for its few seconds — the map
    // still playing meanwhile doesn't talk over either.
    if (listenSyncSearching || performance.now() < listenSyncMessageUntil) return;
    if (listenSyncPaused) {
      setListenSyncStatus('paused');
      return;
    }
    const audioCanLock =
      hasReceivedAnyAudioData && !listenAlignUnavailable && performance.now() - listenAlignSince < LISTEN_ALIGN_STATUS_TIMEOUT_MS;
    const settled = listenAudioLocked || (!audioCanLock && listenSyncConfident);
    setListenSyncStatus(settled ? null : 'aligning');
  }

  /** Whether the map's own audio is clearly audible right now (the last few seconds) — so a
   *  failing alignment there isn't just the song going quiet or ending. */
  function mapLoudRecently(clock: SongClock): boolean {
    if (listenSyncReference === null) return false;
    const mapTime = clock.currentTime() - listenSyncOffsetSeconds - listenSyncSongTimeOffset;
    const loudness = referenceLoudness(listenSyncReference, mapTime - 3, mapTime);
    return loudness !== null && loudness >= 0.3;
  }

  /** One audio-alignment step (see audio-sync.ts). Returns true if it moved the clock. */
  function alignSyncToAudio(clock: SongClock): boolean {
    if (listenSyncReference === null) return false;
    const whole =
      (listenSyncDifferentEdit && (!listenAudioLocked || listenAlignLost)) ||
      (!listenAudioFound && performance.now() - listenAlignSince > LISTEN_ALIGN_WHOLE_AFTER_MS);
    const estimate = listenAligner.estimate(
      listenSyncReference,
      whole ? 'whole' : listenAudioLocked ? LISTEN_ALIGN_LOCKED_SEARCH_SECONDS : LISTEN_ALIGN_SEARCH_SECONDS,
    );
    if (estimate !== null) {
      console.debug(
        `[wallpaper] sync: audio estimate ${estimate.offset >= 0 ? '+' : ''}${estimate.offset.toFixed(3)} s (score ${estimate.score.toFixed(2)}, margin ${estimate.margin.toFixed(2)})`,
      );
    }
    const trustworthy =
      estimate !== null &&
      (whole
        ? estimate.score >= LISTEN_ALIGN_WHOLE_MIN_SCORE
        : estimate.score >= LISTEN_ALIGN_MIN_SCORE && estimate.margin >= LISTEN_ALIGN_MIN_MARGIN);
    if (estimate === null || !trustworthy) {
      listenAlignCandidate = null;
      if (listenSyncDifferentEdit && listenAudioLocked && !whole && ++listenAlignMisses >= LISTEN_ALIGN_LOST_AFTER_MISSES) {
        listenAlignLost = true;
        console.log('[wallpaper] sync: lost the audio lock (a part of this edit the map lacks?), searching the whole map');
      } else if (!listenSyncDifferentEdit && listenAudioLocked && estimate !== null && mapLoudRecently(clock)) {
        // The music is there and the map is loud here too, yet nothing lines up within the locked
        // range: the map is off by more than that (e.g. it kept running through a real pause the
        // player didn't report as silence). Search the wider range again.
        if (++listenAlignMisses >= LISTEN_ALIGN_LOST_AFTER_MISSES) {
          listenAudioLocked = false;
          listenAlignMisses = 0;
          console.log('[wallpaper] sync: lost the audio lock, searching a wider range');
        }
      }
      return false;
    }
    listenAlignMisses = 0;
    if (listenAlignCandidate === null || Math.abs(estimate.offset - listenAlignCandidate) > LISTEN_ALIGN_AGREE_SECONDS) {
      listenAlignCandidate = estimate.offset;
      return false;
    }
    const offset = (estimate.offset + listenAlignCandidate) / 2;
    listenAlignCandidate = null;
    if (!listenAudioLocked || whole) {
      console.log(
        `[wallpaper] sync: locked to the audio, clock ${offset >= 0 ? '+' : ''}${offset.toFixed(2)} s (score ${estimate.score.toFixed(2)}, margin ${estimate.margin.toFixed(2)})`,
      );
    }
    listenAudioLocked = true;
    listenAudioFound = true;
    listenAlignLost = false;
    const corrected = Math.abs(offset) >= LISTEN_ALIGN_MIN_CORRECTION_SECONDS;
    if (corrected) {
      clock.seek(clock.currentTime() + offset);
      listenSyncLearnedOffset += offset;
      listenAligner.shift(offset);
      listenPendingHardSeek = null;
    }
    // Remembered for next time this track plays (see sync-memory.ts) — not for a different edit,
    // whose offset only holds for the part of the song heard just now.
    if (listenSyncMemory !== null && !listenSyncDifferentEdit) {
      rememberSyncOffset(listenSyncMemory.title, listenSyncMemory.artist, listenSyncMemory.hash, listenSyncLearnedOffset);
    }
    return corrected;
  }

  /** The "Other versions" list in the player, from listenVersions and the listener's choice. */
  function refreshVersionsView() {
    const state = listenVersions;
    if (state === null) {
      setVersions(null);
      return;
    }
    const choice = recallChoice(state.title, state.artist, freshMediaDuration());
    const synced = listenSyncActive && !listenSyncHandover && listenSyncMemory?.title === state.title && listenSyncMemory.artist === state.artist;
    const playingHash = synced ? (listenSyncMemory?.hash ?? null) : null;
    const versions = [...state.versions];
    // The playing / chosen version is listed even when the search's list doesn't have it.
    for (const extra of [synced ? listenSyncPlayingVersion : null, choice?.pinned ?? null, choice?.completed ?? null]) {
      if (extra !== null && !versions.some((version) => version.hash === extra.hash)) versions.push(extra);
    }
    const rows: VersionRow[] = versions.map((version) => ({
      hash: version.hash,
      title: version.title,
      mapper: version.mapper,
      coverUrl: version.coverUrl,
      duration: version.duration,
      isCurrent: version.hash === playingHash,
      isPinned: choice?.pinned?.hash === version.hash,
      isCompleted: choice?.completed?.hash === version.hash,
      environmentSupported: version.environmentSupported,
      usesChroma: version.usesChroma,
      usesNoodleExtensions: version.usesNoodleExtensions,
      mightUseGLS: version.mightUseGLS,
      differentEdit: version.differentEdit,
      excluded: version.excluded,
    }));
    setVersions(rows);
  }

  /** The track's versions, searched for in the background — the map played was the listener's own
   *  choice, so nothing waited for a search, but the list (and the memory) still needs one. */
  function searchVersionsInBackground(title: string, artist: string, duration: number | null) {
    void searchBeatSaverForTrack(title, artist, duration, !listenSyncRichMaps, {
      nameVariants,
      alternateNames: (name, nameArtist) => alternateTrackNames(name, nameArtist, duration),
    })
      .then((outcome) => {
        if (outcome.best !== null && outcome.complete) rememberSync(title, artist, { ...outcome.best, duration, versions: outcome.versions });
        if (listenVersions?.title !== title || listenVersions.artist !== artist) return;
        listenVersions.versions = outcome.versions;
        listenVersions.bestHash = outcome.best?.entry.hash ?? null;
        refreshVersionsView();
      })
      .catch((error: unknown) => console.warn('[wallpaper] sync: searching for the other versions failed', error));
  }

  /** The synced map has been played to the end: if it isn't the search's own pick, it becomes the
   *  track's main version (a pinned one still comes first) — see rememberCompleted. */
  function markSyncCompleted() {
    const memory = listenSyncMemory;
    const version = listenSyncPlayingVersion;
    if (memory === null || version === null) return;
    const bestHash = listenVersions?.title === memory.title && listenVersions.artist === memory.artist ? listenVersions.bestHash : null;
    const isPick = bestHash === version.hash;
    rememberCompleted(memory.title, memory.artist, isPick ? null : version, freshMediaDuration());
    console.log(`[wallpaper] sync: "${version.title}" (${version.mapId}) played to the end${isPick ? '' : ' — it plays first for this track from now on'}`);
    refreshVersionsView();
  }

  async function trySyncWithBeatSaverMap(title: string, artist: string, options: { ignoreChoice?: boolean } = {}) {
    const token = ++listenSyncToken;
    listenSyncSearching = true;
    setListenSyncStatus('searching');
    if (listenVersions?.title !== title || listenVersions.artist !== artist) {
      listenVersions = { title, artist, versions: [], bestHash: null };
      refreshVersionsView();
    }
    try {
      // Waits for a duration that belongs to *this* track (see freshMediaDuration) before searching.
      // Duration and title/artist come from two independent Wallpaper Engine callbacks with no
      // guaranteed order, so the new track's duration may already be here, or may still be on its
      // way; the previous track's duration is never used. If it never arrives (some players don't
      // report one), this gives up after DURATION_WAIT_TIMEOUT_MS and searches on title alone.
      //
      // A track synced before skips all of that: its map comes from memory (and, when it's still in
      // the map cache, without asking any server) — see sync-memory.ts. Only a short wait for the
      // duration, to tell e.g. a TV-size cut apart from the full song of the same name.
      await initMapArchiveCache(); // (isCached() is only accurate once the cache index is read)
      if (token !== listenSyncToken) return;
      const isCached = (hash: string) => browserMapArchiveCache?.isCached(hash) === true;
      let remembered = recallSync(title, artist, freshMediaDuration(), isCached);
      const useChoice = options.ignoreChoice !== true;
      let choice = useChoice ? recallChoice(title, artist, freshMediaDuration()) : null;
      if ((remembered !== null && remembered.duration !== null) || (choice !== null && choice.duration !== null)) {
        for (let waited = 0; freshMediaDuration() === null && waited < REMEMBERED_DURATION_WAIT_MS; waited += DURATION_WAIT_POLL_MS) {
          await sleep(DURATION_WAIT_POLL_MS);
          if (token !== listenSyncToken) return;
        }
        remembered = recallSync(title, artist, freshMediaDuration(), isCached);
        choice = useChoice ? recallChoice(title, artist, freshMediaDuration()) : null;
      }
      let duration: number | null;
      let searchResult: BeatSaverSearchResult | null;
      // The listener's own choice comes first: the version pinned in the player's list, else the one
      // last played to the end (see sync-memory.ts).
      const chosen = choice?.pinned ?? choice?.completed ?? null;
      let freshSearch: BeatSaverSearchOutcome | null = null;
      const versionsState = listenVersions;
      if (chosen !== null) {
        duration = freshMediaDuration();
        searchResult = {
          entry: chosen,
          durationConfirmed: duration !== null,
          differentEdit:
            duration !== null && chosen.duration !== null
              ? Math.abs(chosen.duration - duration) > SYNC_DURATION_TOLERANCE_SECONDS
              : chosen.differentEdit,
        };
        console.log(
          `[wallpaper] sync: ${choice?.pinned !== null ? 'the version picked in the player' : 'the version last played to the end'} — "${
            chosen.title
          }" (${chosen.mapId})${isCached(chosen.hash) ? ' from the map cache' : ''}`,
        );
        if (versionsState !== null) {
          versionsState.versions = remembered?.versions ?? [];
          versionsState.bestHash = remembered?.entry.hash ?? null;
        }
        if (remembered === null) searchVersionsInBackground(title, artist, duration);
      } else if (remembered !== null) {
        duration = freshMediaDuration();
        if (versionsState !== null) {
          versionsState.versions = remembered.versions;
          versionsState.bestHash = remembered.entry.hash;
        }
        searchResult = {
          entry: remembered.entry,
          durationConfirmed: remembered.durationConfirmed,
          differentEdit: remembered.differentEdit,
        };
        console.log(
          `[wallpaper] sync: known track — "${remembered.entry.title}" (${remembered.entry.mapId})${
            isCached(remembered.entry.hash) ? ' from the map cache' : ''
          }`,
        );
      } else {
        for (let waited = 0; freshMediaDuration() === null && waited < DURATION_WAIT_TIMEOUT_MS; waited += DURATION_WAIT_POLL_MS) {
          await sleep(DURATION_WAIT_POLL_MS);
          if (token !== listenSyncToken) return; // track changed again while we were waiting
        }
        const searchDuration = freshMediaDuration();
        duration = searchDuration;
        freshSearch = await searchBeatSaverForTrack(title, artist, searchDuration, !listenSyncRichMaps, {
          nameVariants,
          alternateNames: (name, nameArtist) => alternateTrackNames(name, nameArtist, searchDuration),
        });
        searchResult = freshSearch.best;
        if (versionsState !== null) {
          versionsState.versions = freshSearch.versions;
          versionsState.bestHash = freshSearch.best?.entry.hash ?? null;
        }
      }
      refreshVersionsView();
      if (token !== listenSyncToken) return; // track changed again while we were searching
      // The chosen version didn't work out (deleted, broken, offline): the usual pick instead.
      const fallBackFromChoice = async (reason: string) => {
        console.warn(`[wallpaper] sync: the chosen version ${reason} — taking the usual pick instead`);
        await trySyncWithBeatSaverMap(title, artist, { ignoreChoice: true });
      };
      if (searchResult === null) {
        showSyncMessage('not_found');
        return;
      }
      const { entry, durationConfirmed, differentEdit } = searchResult;
      console.log(
        `[wallpaper] sync: ${browserMapArchiveCache?.isCached(entry.hash) === true ? 'loading' : 'downloading'} "${entry.title}"${
          differentEdit ? ' (a different edit of the song)' : durationConfirmed ? '' : ' (duration not confirmed)'
        }`,
      );
      setListenSyncStatus('downloading', 0);
      const files = await loadBeatSaverMap(entry.hash, (progress) => {
        if (token === listenSyncToken) setListenSyncStatus('downloading', progress);
      });
      if (token !== listenSyncToken) return;
      if (files === null) {
        if (chosen !== null) return await fallBackFromChoice("couldn't be downloaded");
        showSyncMessage('download_failed');
        console.warn(`[wallpaper] sync: failed to download "${entry.title}"`);
        return;
      }
      let parsed: Awaited<ReturnType<typeof parseMapPackage>>;
      try {
        parsed = await parseMapPackage(files, parser, null);
      } catch (error) {
        console.error(`[wallpaper] sync: failed to parse "${entry.title}" (${entry.mapId})`, error);
        if (chosen !== null) return await fallBackFromChoice("couldn't be read");
        setListenSyncStatus(null);
        return;
      }
      if (token !== listenSyncToken) return;
      // A version picked by hand plays even in an environment the viewer can't show (in the default one).
      const row = pickSyncRow(parsed.rows, chosen !== null);
      const hasShow = lightEventCount(row?.difficulty) >= SYNC_MIN_LIGHT_EVENTS;
      if (row?.difficulty === undefined || row.infoDifficulty === undefined || row.environmentId === undefined || !hasShow) {
        // (The search already leaves out maps it can tell are unsupported; this catches the rest.)
        if (chosen !== null) return await fallBackFromChoice('has no lightshow the viewer can show');
        showSyncMessage('not_found');
        console.warn(`[wallpaper] sync: "${entry.title}" has no difficulty with a lightshow the viewer can show`);
        return;
      }
      // Deliberately checked *after* the download, not before: it's the exact same "takes time to
      // download, and the estimate would only get staler while we wait" problem the whole feature
      // exists to solve, so there's no point rejecting early on a first, now-outdated reading.
      const estimatedPosition = estimateCurrentPosition();
      if (estimatedPosition === null) {
        setListenSyncStatus(null);
        console.warn("[wallpaper] sync: the player doesn't report the track position");
        return;
      }
      // A track change is itself a big jump in reported position (an unrelated song), so it trips
      // the very same seek-detection the ongoing slaving loop waits out below — but this initial
      // read never used to wait for it, meaning almost *every* new track started from whatever
      // transient first reading the player happened to report right as it switched. This is
      // exactly what made a fresh sync miss the beat while a manual seek "fixed" it afterwards: a
      // seek is the one thing that reliably produces a *settled* reading, since the slaving loop
      // already knew to wait for that case specifically. A cached (near-instant) load was if
      // anything hit harder, since there was barely any natural delay for the reading to settle on
      // its own before this ran.
      for (let waited = 0; mediaPositionUpdatedAt < mediaTitleChangedAt && waited < FRESH_POSITION_WAIT_MS; waited += 100) {
        await sleep(100);
        if (token !== listenSyncToken) return;
      }
      while (performance.now() - listenLastSeekDetectedAt < LISTEN_SEEK_SETTLE_MS) {
        if (token !== listenSyncToken) return;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      const data = buildMapRenderData(row.difficulty, {
        noteJumpSpeed: effectiveNoteJumpSpeed(row.infoDifficulty),
        noteStartBeatOffset: row.infoDifficulty.noteStartBeatOffset,
        songBpm: parsed.songBpm,
        legacyNoodleV2Semantics: row.legacyNoodleV2Semantics,
        environmentRemoval: row.infoDifficulty.environmentRemoval,
      });
      if (token !== listenSyncToken) return;

      // The map's own audio drives the clock — just muted afterwards.
      const fallbackDuration = songBpmTimeToSeconds(data.endBeat, parsed.songBpm) + 1;
      let clock: SongClock;
      let hasAudio: boolean;
      let leadInSeconds = 0;
      let syncBuffer: AudioBuffer | null = null;
      if (parsed.audioData === null) {
        clock = createSilentClock(fallbackDuration, parsed.songBpm);
        hasAudio = false;
      } else {
        const clockResult = await createAudioClock({
          audioData: parsed.audioData,
          songBpm: parsed.songBpm,
          onBuffer: (buffer) => {
            leadInSeconds = detectLeadInSeconds(buffer);
            syncBuffer = buffer;
          },
        });
        hasAudio = clockResult.isOk();
        clock = clockResult.isOk() ? clockResult.value : createSilentClock(fallbackDuration, parsed.songBpm);
      }
      if (parsed.mapMeta.songTimeOffset !== 0) clock.setAudioOffset(parsed.mapMeta.songTimeOffset);
      if (token !== listenSyncToken) {
        clock.dispose();
        return;
      }

      // Into the map through the same fade as every other environment switch: hidden behind black
      // while its environment loads and the lights jump to the map's state, instead of a hard cut.
      await fadeToBlack();
      if (token !== listenSyncToken) {
        clock.dispose();
        void fadeFromBlack();
        return;
      }
      const environmentResult = await view.setEnvironment(row.environmentId, data.chromaEnvironment);
      if (token !== listenSyncToken) {
        clock.dispose();
        void fadeFromBlack();
        return;
      }
      if (environmentResult.isErr()) {
        logEnvironmentError(`sync: failed to load environment for "${entry.title}" (${entry.mapId})`, environmentResult.error);
      }
      const mapColors = syncedMapColors(row, true);
      console.log(
        `[wallpaper] sync: map colors ${
          mapColors !== row.colorScheme
            ? `replaced (${mapColors?.name ?? 'environment'})`
            : `kept (${
                hasChromaFeatures(row.difficulty)
                  ? 'Chroma'
                  : usesGroupLightingSystem(row.difficulty)
                    ? 'V3 lighting'
                    : view.hasOwnLightColors(row.colorScheme)
                      ? 'the map has its own colors'
                      : listenColorsSynced
                        ? 'setting'
                        : 'not enabled for synced maps'
              })`
        }`,
      );
      view.setMap(data, mapColors);
      listenSyncRow = row;
      currentRequiresNoodleExtensions = row.infoDifficulty.requiresNoodleExtensions;
      applyShowWalls();
      disposeListenSyncClock(); // replace whatever sync clock (if any) was running before
      clock.setVolume(0); // never audible — the real sound is already playing from the PC itself
      // The offset between the map's timeline and the streaming version of the same song is just
      // the silence the mapper padded onto the front of their audio file (measured above) — so it
      // is now derived directly from the audio itself rather than inferred.
      //
      // This replaces the earlier "first note is on the first beat" anchor, which produced exactly
      // the inconsistency reported: it only applied when the track was caught from its start, so
      // the very first play of a track got one offset and replays within the same session (no
      // silence gap to detect) silently fell back to zero — the map running ahead one time and
      // behind the next, on the same track and the same settings. Measuring the padding has no
      // such conditions: it's a property of the file, identical every time.
      //
      // That's only the starting point, though: once enough of the music has been heard, the map is
      // lined up against the audio itself (alignSyncToAudio), which also covers what no guess from
      // the file can — a quiet intro that looks like padding, the player's reporting delay.
      listenSyncSongTimeOffset = parsed.mapMeta.songTimeOffset;
      // Heard before with this very map: start at the offset it was locked at back then, so there's
      // no big jump at the start while the audio alignment settles in again.
      const rememberedOffset = !differentEdit ? (remembered?.offsets[entry.hash] ?? null) : null;
      listenSyncLearnedOffset = rememberedOffset ?? leadInSeconds + listenSyncSongTimeOffset;
      if (rememberedOffset !== null) console.log(`[wallpaper] sync: starting at the remembered offset ${rememberedOffset.toFixed(2)} s`);
      listenSyncReference = null;
      resetAudioAlignment();
      listenPendingHardSeek = null;
      listenSyncPaused = false;
      listenSyncConfident = false;
      listenLastSyncCorrectionAt = performance.now();
      listenLastSoftResyncCheckAt = performance.now();
      listenSyncDifferentEdit = differentEdit;
      listenHandledSeekAt = listenLastSeekDetectedAt;
      const apiPosition = positionOfThisTrack() ?? estimatedPosition;
      let startAt = apiPosition + listenSyncOffsetSeconds + listenSyncLearnedOffset;
      // A reported position at or past the map's end can't be this track's (Apple Music in a browser
      // was seen reporting 5:15 of a 4:05 song, the positions running on from earlier tracks):
      // starting there, the map "ended" at once and was dropped. It's handled like a different edit
      // instead — the time since the title changed as the first guess, the audio finds the real spot.
      if (!differentEdit && startAt > clock.duration - 5) {
        console.log(
          `[wallpaper] sync: the player's position (${apiPosition.toFixed(1)} s) lies past the map's end — placing it by the audio alone`,
        );
        startAt = (performance.now() - mediaTitleChangedAt) / 1000 + listenSyncLearnedOffset;
        listenSyncDifferentEdit = true;
      }
      // A different edit: the reported position is only a first guess (it can even lie past the
      // map's end — a 5:39 album version against a 3:56 map); the audio will find the real spot.
      clock.seek(listenSyncDifferentEdit ? Math.min(startAt, Math.max(0, clock.duration - 30)) : startAt);
      clock.play();
      view.setBeatSource(() => clock.currentBeat());
      listenSyncClock = clock;
      listenSyncStartedAt = performance.now();
      listenSyncActive = true;
      listenSyncHandover = false; // (the previous track's held map, if any, is replaced now)
      document.body.dataset.listenSyncing = 'true';
      if (freshSearch !== null && freshSearch.best !== null && freshSearch.complete) {
        rememberSync(title, artist, { ...freshSearch.best, duration, versions: freshSearch.versions });
      } else if (freshSearch !== null) {
        // Part of the search failed (Apple didn't answer): played now, but searched afresh next
        // time rather than remembered — a better map may have been missed.
        console.log('[wallpaper] sync: the search was incomplete — not remembered, the track is searched again next time');
      } else {
        touchSync(title, artist);
      }
      listenSyncMemory = { title, artist, hash: entry.hash };
      listenSyncPlayingVersion = chosen ??
        listenVersions?.versions.find((version) => version.hash === entry.hash) ?? {
          ...entry,
          duration: Math.round(clock.duration),
          differentEdit,
          excluded: null,
        };
      listenSyncCompletedMarked = false;
      refreshVersionsView();
      listenAlignUnavailable = syncBuffer === null;
      if (syncBuffer !== null) {
        const buffer: AudioBuffer = syncBuffer;
        const stillCurrent = () => listenSyncActive && listenSyncClock === clock;
        const builtAt = performance.now();
        void buildSyncReference(buffer, () => !stillCurrent())
          .then((reference) => {
            if (!stillCurrent()) return;
            if (reference === null) {
              listenAlignUnavailable = true;
              return;
            }
            listenSyncReference = reference;
            console.log(`[wallpaper] sync: audio reference ready (${Math.round(performance.now() - builtAt)} ms)`);
          })
          .catch((error: unknown) => {
            if (stillCurrent()) listenAlignUnavailable = true;
            console.warn('[wallpaper] sync: could not analyse the map audio, staying on the reported position', error);
          });
      }
      void fadeFromBlack();
      // From here on, the panel shows the map's own data — title, mapper, cover, copy-link —
      // rather than the PC media API's info (which is still what decided
      // *which* map to fetch, but isn't what's on screen once we actually have the real thing).
      const syncTitle = [parsed.mapMeta.title, parsed.mapMeta.author].filter((part) => part.length > 0).join(' — ');
      const syncCoverUrl =
        parsed.cover === null
          ? null
          : URL.createObjectURL(new Blob([parsed.cover.data], { type: parsed.cover.type || 'image/jpeg' }));
      if (listenSyncCoverUrl !== null && listenSyncCoverUrl.startsWith('blob:')) URL.revokeObjectURL(listenSyncCoverUrl);
      listenSyncCoverUrl = syncCoverUrl;
      setPhase('playing', syncTitle.length > 0 ? syncTitle : entry.title);
      setTrack({
        title: syncTitle.length > 0 ? syncTitle : entry.title,
        mapper: parsed.mapMeta.mapper,
        coverUrl: syncCoverUrl,
        environmentSupported: row.environmentSupported ?? true,
        hasLightshow: hasLightshowEvents(row.difficulty),
        hasAudio,
        usesChroma: hasChromaFeatures(row.difficulty),
        usesNoodleExtensions: row.infoDifficulty.requiresNoodleExtensions,
        usesGLS: usesGroupLightingSystem(row.difficulty),
        mapId: entry.mapId,
      });
      // "Syncing" until the map has been locked to the audio — see refreshSyncStatus.
      setListenSyncStatus('aligning');
      console.log(`[wallpaper] sync: playing "${entry.title}", lead-in silence ${leadInSeconds.toFixed(2)} s`);
    } catch (error) {
      setListenSyncStatus(null);
      if (token !== listenSyncToken) return;
      console.error('[wallpaper] sync attempt failed', error);
    } finally {
      if (token === listenSyncToken) listenSyncSearching = false;
    }
  }

  /** The palette as a color-scheme override for the generated show (lights only — notes/walls aren't
   *  shown in screensaver mode anyway). */
  /** The user's own light colors as a color-scheme override (same shape as paletteOverride). */
  function customColorsOverride(colors: { left: Rgb; right: Rgb }): InfoColorScheme {
    return { ...paletteOverride({ left: colors.left, right: colors.right, leftHue: 0, rightHue: 0 }), name: 'screensaver-custom' };
  }

  /** The colors a synced map is shown in: its own, unless "Light colors" is set to random or own
   *  colors *and* "also for synced maps" is on — and only for maps whose lighting doesn't bring
   *  colors of its own (Chroma's per-event colors, V3 light groups), which an override would ruin.
   *  Random colors get a fresh palette per map, like the generated show gets per track. */
  function syncedMapColors(row: DifficultyRow, fresh: boolean): InfoColorScheme | undefined {
    const own = row.colorScheme;
    if (!listenColorsSynced || row.difficulty === undefined) return own;
    if (hasChromaFeatures(row.difficulty) || usesGroupLightingSystem(row.difficulty)) return own;
    // Nor a map whose mapper picked light colors of their own (differing from the environment's).
    if (view.hasOwnLightColors(own)) return own;
    if (listenCustomColors !== null) return customColorsOverride(listenCustomColors);
    if (!listenRandomColors) return own;
    if (fresh || listenPalette === null) {
      listenPalette = randomHarmoniousPalette(listenPalette);
      // (the generated show carries on in the same colors if the sync ends)
      listenColorOverride = paletteOverride(listenPalette);
    }
    return paletteOverride(listenPalette);
  }

  /** Re-applies the colors to the synced map on screen after a color setting changed. */
  function refreshSyncedMapColors() {
    if (!listenSyncActive || listenSyncRow === null) return;
    view.refreshMapColors(syncedMapColors(listenSyncRow, false));
  }

  function paletteOverride(palette: LightPalette): InfoColorScheme {
    return {
      name: 'screensaver-random',
      overrideNotes: false,
      leftNote: DEFAULT_COLORS.leftNote,
      rightNote: DEFAULT_COLORS.rightNote,
      obstacle: DEFAULT_COLORS.obstacle,
      overrideLights: true,
      supportsEnvironmentColorBoost: false,
      environmentLeft: palette.left,
      environmentRight: palette.right,
      environmentLeftBoost: palette.left,
      environmentRightBoost: palette.right,
    };
  }

  /** Environments the generated show can actually light: everything ChroViewer has, minus the
   *  GLS-only (v3 lighting) ones, which don't respond to the classic events this show is built on. */
  function pickRandomListenEnvironment(current: string): string {
    const pool = environmentCatalog.map(({ id }) => id).filter((id) => !isGLSCapableEnvironment(id) && id !== current);
    return pool[Math.floor(Math.random() * pool.length)] ?? current;
  }

  /** On a track change in screensaver mode: a new random environment and/or a new harmonious light
   *  palette (listen_random_environment / listen_random_colors). An environment switch goes through
   *  the same fade to black as a synced map's environment; a colors-only change just switches. */
  async function randomizeListenLook(options: { forceEnvironment?: boolean } = {}) {
    const changeEnvironment = listenRandomEnvironment || options.forceEnvironment === true;
    if (!changeEnvironment && !listenRandomColors) return;
    if (listenSyncActive) return;
    const token = ++listenLookToken;
    const nextPalette = listenRandomColors ? randomHarmoniousPalette(listenPalette) : null;
    const applyColors = () => {
      if (nextPalette === null) return;
      listenPalette = nextPalette;
      listenColorOverride = paletteOverride(nextPalette);
    };
    if (!changeEnvironment) {
      applyColors();
      return;
    }
    const nextEnvironment = pickRandomListenEnvironment(listenActiveEnvironmentId);
    console.log(`[wallpaper] screensaver: ${options.forceEnvironment === true ? 'button' : 'new track'} -> environment ${nextEnvironment}${nextPalette === null ? '' : ', new colors'}`);
    await fadeToBlack();
    if (token !== listenLookToken || listenSyncActive) {
      void fadeFromBlack();
      return;
    }
    listenActiveEnvironmentId = nextEnvironment;
    applyColors();
    const result = await view.setEnvironment(nextEnvironment);
    if (result.isErr()) logEnvironmentError('failed to load random screensaver environment', result.error);
    listenRebuiltLength = -1;
    void fadeFromBlack();
  }

  /** Carries the single most recent event of each type forward across the trim, even if it's older
   *  than the window, instead of just dropping everything past the cutoff. Some types (bass-gated
   *  ring rotation/lasers) naturally push far less often than others, so a size-based trim
   *  disproportionately empties the sparser types out first — once a type has *zero* events left,
   *  the renderer has nothing to reference for it and it just goes dark/static.
   *
   *  Rotation events need more care, because the renderer derives their *current* angle from the
   *  whole remaining history:
   *  - Ring rotation (type 8) is a running sum of every event's rotation. The idle show's nudges
   *    (the ones with an explicit `rotation`) are folded, once long settled, into one event whose
   *    rotation is their sum (mod 360°) — the rings end up at the same visible angle, so no jump.
   *    While the idle show runs, older ring events without an explicit rotation (from the reactive
   *    show) are kept: their contribution can't be known here.
   *  - Laser rotation (12/13) with lockRotation continues from the angle the previous events left,
   *    so while the latest one has it, that history is kept as is (it's only a handful of events). */
  function trimListenEvents(beat: number) {
    const minBeat = beat - LISTEN_EVENT_WINDOW_BEATS;
    const lastBeforeCutoffByType = new Map<number, BasicEvent>();
    const kept: BasicEvent[] = [];
    const ringAmbient: BasicEvent[] = [];
    const lastLaser = new Map<number, BasicEvent>();
    let olderZoomCount = 0;
    let previousOlderZoom: BasicEvent | undefined;
    for (const event of listenEvents) {
      if (event.type === 12 || event.type === 13) lastLaser.set(event.type, event);
    }
    for (const event of listenEvents) {
      if (event.type === 8 && event.customData?.rotation !== undefined) {
        ringAmbient.push(event);
        continue;
      }
      const lockedLaser =
        (event.type === 12 || event.type === 13) && lastLaser.get(event.type)?.customData?.lockRotation === true;
      const keepReactiveRings = event.type === 8 && ambientSegmentEnd !== null;
      if (event.songBpmTime >= minBeat || lockedLaser || keepReactiveRings) {
        kept.push(event);
      } else {
        if (event.type === 9) {
          olderZoomCount++;
          previousOlderZoom = lastBeforeCutoffByType.get(9);
        }
        lastBeforeCutoffByType.set(event.type, event);
      }
    }
    // Ring zoom (type 9) without an explicit step alternates between the environment's two ring
    // spacings by its *index* in the list — dropping an odd number of them would flip every
    // remaining one and teleport the rings to the other spacing. Keep the count dropped even.
    const lastOlderZoom = lastBeforeCutoffByType.get(9);
    if (lastOlderZoom !== undefined) {
      lastBeforeCutoffByType.delete(9);
      kept.push(lastOlderZoom);
      if ((olderZoomCount - 1) % 2 === 1 && previousOlderZoom !== undefined) kept.push(previousOlderZoom);
    }
    // Idle-show ring nudges: fold every long-settled one into a single event carrying their summed
    // rotation (mod 360) and the last one's ring spacing — the rings' running angle, and so what's
    // on screen, stays exactly the same (see the doc comment above).
    let foldCount = 0;
    let sum = 0;
    for (const event of ringAmbient) {
      if (event.songBpmTime >= beat - AMBIENT_RING_KEEP_BEATS) break;
      const rotation = Number(event.customData?.rotation ?? 0);
      sum += event.customData?.direction === 0 ? rotation : -rotation;
      foldCount++;
    }
    const lastFolded = ringAmbient[foldCount - 1];
    if (foldCount > 1 && lastFolded !== undefined) {
      kept.push({
        ...lastFolded,
        // Snaps straight onto the folded target (fast speed, all rings at once); it lies long enough
        // in the past that this has fully settled before anything that's still visible.
        customData: { rotation: sum % 360, step: lastFolded.customData?.step ?? 0, prop: 50, speed: 10, direction: 0 },
      });
      kept.push(...ringAmbient.slice(foldCount));
    } else {
      kept.push(...ringAmbient);
    }
    for (const [type, event] of lastBeforeCutoffByType) {
      if (!kept.some((other) => other.type === type && other.songBpmTime <= event.songBpmTime)) kept.push(event);
    }
    listenEvents = kept;
  }

  /** Pulls the lights the generator has newly scheduled (on predicted beats, up to ~0.6 s ahead)
   *  into the event timeline. The generator works in seconds of performance.now(); the timeline
   *  runs on the fixed LISTEN_FAKE_BPM clock that view.setBeatSource uses in this mode. */
  function tickListenReactive() {
    const beatsPerSecond = LISTEN_FAKE_BPM / 60;
    for (const event of listenShow.collect(performance.now() / 1000)) {
      const beat = (event.time - listenStartPerfTime / 1000) * beatsPerSecond;
      listenEvents.push({
        jsonTime: beat,
        songBpmTime: beat,
        type: event.type,
        value: event.value,
        floatValue: event.floatValue,
        ...(event.customData === undefined ? {} : { customData: event.customData }),
      });
    }
    const state = listenShow.state;
    const summary = `${state.style} (${state.styleSource})${state.bpm === null ? '' : `, ~${Math.round(state.bpm)} BPM`}`;
    if (state.styleSource !== 'default' && summary.split(',')[0] !== listenLastLoggedStyle) {
      listenLastLoggedStyle = summary.split(',')[0] ?? '';
      console.log(`[wallpaper] lightshow: ${summary}`);
    }
  }

  /** The cover for the screensaver panel. Normally the player's own thumbnail — but some players
   *  (Apple Music on Windows) switch the title right away and hand over the new artwork late or
   *  never, so the previous song's cover would stay up next to the new title. If the thumbnail
   *  hasn't changed since before the track did while the album did change (or there's no thumbnail
   *  at all), it gets a short grace period to arrive, then the cover is looked up online instead
   *  (the wallpaper's placeholder if that finds nothing). A thumbnail arriving later still wins. */
  function listenCover(): string | null {
    const fresh = mediaThumbnail !== null && mediaThumbnailChangedAt >= listenCoverTrackStart - LISTEN_COVER_GRACE_MS;
    const suspect = mediaThumbnail === null || (!fresh && listenCoverAlbumChanged);
    if (!suspect) return mediaThumbnail;
    if (performance.now() - listenCoverTrackStart < LISTEN_COVER_GRACE_MS) return mediaThumbnail;
    if (!listenOnlineCoverRequested && mediaTitle !== '') {
      listenOnlineCoverRequested = true;
      const title = mediaTitle;
      console.log(`[wallpaper] cover: player sent no new cover for "${title}" — looking it up online`);
      void lookupCover(title, mediaArtist).then((url) => {
        if (mediaTitle !== title) return;
        console.log(`[wallpaper] cover: online lookup for "${title}" -> ${url ?? 'nothing found'}`);
        listenOnlineCover = url;
      });
    }
    return listenOnlineCover;
  }

  function tickListenMode() {
    if (wallpaperPaused) return; // nothing on screen — see onPausedChange
    const beat = (performance.now() - listenStartPerfTime) / 1000 / (60 / LISTEN_FAKE_BPM);

    // New track? Fall back to the generated show immediately (so there's never a dead frame while
    // we search/download), and kick off a sync attempt in the background if enabled — it'll take
    // over (see listenSyncActive below) if and when it actually succeeds.
    if (mediaTitle === '' && listenLastSyncTitle !== '') listenTitleLost = true;
    if (mediaTitle !== '' && (mediaTitle !== listenLastSyncTitle || listenTitleLost)) {
      // (The same title again after the track info was gone — a reloaded player page — is synced
      // anew, but isn't a track change: no new random look for it.)
      const previousTitle = mediaTitle === listenLastSyncTitle ? '' : listenLastSyncTitle;
      listenTitleLost = false;
      listenLastSyncTitle = mediaTitle;
      const albumKey = mediaAlbum !== '' ? mediaAlbum : mediaArtist;
      listenCoverAlbumChanged = previousTitle !== '' && albumKey !== listenCoverAlbumKey;
      listenCoverAlbumKey = albumKey;
      listenCoverTrackStart = mediaTitleChangedAt;
      listenOnlineCover = null;
      listenOnlineCoverRequested = false;
      listenShow.startTrack(`${mediaTitle}|${mediaArtist}`, mediaGenres);
      // With sync on, a synced map stays up (still running) while the new track's map is searched for —
      // see holdSyncedMap; the generated show only comes back if that search finds nothing.
      if (listenSyncEnabled) holdSyncedMap();
      else {
        listenVersions = null;
        exitSyncMode();
      }
      listenSyncToken += 1; // invalidate any sync attempt still in flight for the *previous* track
      // mediaDuration is deliberately NOT reset here any more: this tick runs up to 200 ms after the
      // title actually changed, and the new track's duration often arrives in that gap (or even just
      // before the title) — resetting it threw that away, the search then timed out waiting for a
      // repeat that never came, and ran without any duration check at all. freshMediaDuration()
      // decides instead whether the current value belongs to this track.
      // The very first title seen after entering screensaver mode isn't a track *change* — the
      // user's own environment/colors stay up for it.
      const isTrackChange = previousTitle !== '';
      if (listenSyncEnabled) {
        const title = mediaTitle;
        void trySyncWithBeatSaverMap(mediaTitle, mediaArtist).then(() => {
          if (listenLastSyncTitle !== title) return; // the track changed again in the meantime
          if (listenSyncSearching) return; // a newer attempt took over (a version chosen in the player)
          // No map for this track: the previous track's held map (if any) gives way to the
          // generated show only now.
          if (listenSyncHandover) exitSyncMode({ restoreEnvironment: !(isTrackChange && listenRandomEnvironment) });
          // A found map brings its own environment and colors; only randomize once the search has
          // settled on "no map" — otherwise the screen would switch environments twice in a row.
          if (isTrackChange && !listenSyncActive) void randomizeListenLook();
        });
      } else if (isTrackChange) {
        void randomizeListenLook();
      }
    }

    // Real silence detection, independent of whatever the media API claims — a paused track still
    // reports a title, so relying on the title alone (the first version's approach) meant a paused
    // song looked like "playing" with nothing actually happening. Measured per audio frame in the
    // audio listener, relative to the recent level (so it holds at any system volume) — see
    // LISTEN_SOUND_*.
    const nowMs = performance.now();
    const hasSound = nowMs - listenLastSoundFrameAt < LISTEN_SOUND_FRAME_HOLD_MS;
    if (hasSound) {
      if (nowMs - listenLastAudioActivityTime > LISTEN_SOUND_STREAK_GAP_MS) listenSoundStreakStart = nowMs;
      listenLastAudioActivityTime = nowMs;
    }
    const silentForMs = nowMs - listenLastAudioActivityTime;
    const soundForMs = silentForMs > LISTEN_SOUND_STREAK_GAP_MS ? 0 : nowMs - listenSoundStreakStart;
    // The media API is optional: not every player reports what's playing (and Media Integration
    // can be off). Without a title the show runs on the audio alone, under a generic title.
    const hasTrackInfo = mediaTitle !== '';
    const displayTitle = hasTrackInfo ? mediaTitle : t('listen_unknown_track');

    if (listenSyncActive && !listenSyncHandover) {
      if (mediaTitle === '') {
        // Media info gone entirely (not just quiet): the player's page may just be reloading. The
        // map is held for a while — if the track comes back it syncs again (from memory, so
        // without a new search), otherwise the generated show takes over.
        console.log('[wallpaper] sync: the player stopped reporting a track — holding the map for a while');
        holdSyncedMap(LISTEN_SYNC_TITLE_LOST_GRACE_MS);
      } else {
        // Paused/resumed in place rather than exiting sync mode on silence: the whole point of
        // syncing is not having to re-search and re-download every time the track is paused for a
        // moment. A shorter timeout than the full ambient fallback below, since "is this track
        // paused" should be obvious quickly, and there's no real cost to checking often — pausing
        // just stops the clock exactly where it is, and playing resumes it from there, which stays
        // correctly aligned as long as the real player was actually paused (not just quiet) too.
        //
        // Silence alone isn't proof, though: songs have quiet moments of their own, most of all at
        // the end, and pausing there put the map behind for the rest of the song. So the map's own
        // audio is checked over the same stretch — quiet there too means it's the song — and a
        // player still reporting a moving position isn't paused either.
        let songQuietHere = false;
        if (listenSyncReference !== null && listenSyncClock !== null && !listenSyncPaused) {
          const mapTime = listenSyncClock.currentTime() - listenSyncOffsetSeconds - listenSyncSongTimeOffset;
          const loudness = referenceLoudness(listenSyncReference, mapTime - silentForMs / 1000, mapTime + 0.3);
          songQuietHere = loudness !== null && loudness < LISTEN_SYNC_QUIET_RATIO;
        }
        const playerAdvancing = performance.now() - mediaPositionAdvancedAt < LISTEN_POSITION_ADVANCING_MS;
        const shouldBePaused = listenSyncPaused
          ? silentForMs > LISTEN_SYNC_PAUSE_TIMEOUT_MS && !playerAdvancing
          : silentForMs > LISTEN_SYNC_PAUSE_TIMEOUT_MS && !songQuietHere && !playerAdvancing;
        if (shouldBePaused && !listenSyncPaused && listenSyncClock !== null) {
          listenSyncClock.pause();
          listenSyncPaused = true;
          refreshSyncStatus();
        } else if (!shouldBePaused && listenSyncPaused && listenSyncClock !== null) {
          listenSyncClock.play();
          listenSyncPaused = false;
          // A quiet passage looks just like a pause from here, and the music kept going through it,
          // so the old lock can't be trusted any more; the audio will re-lock shortly.
          resetAudioAlignment();
          refreshSyncStatus();
        }
      }
    }

    // Leaving the calm show: right away when the player reports a track, otherwise only once sound
    // has lasted a moment. Going back to it: after a real stretch of silence either way — a track
    // title that disappears while music keeps playing doesn't stop the show.
    const shouldShowAmbient = listenSyncActive
      ? false
      : listenShowingAmbient
        ? silentForMs > LISTEN_SILENCE_TIMEOUT_MS || (!hasTrackInfo && soundForMs < LISTEN_UNTITLED_START_MS)
        : silentForMs > LISTEN_SILENCE_TIMEOUT_MS;

    if (shouldShowAmbient !== listenShowingAmbient) {
      listenShowingAmbient = shouldShowAmbient;
      if (!shouldShowAmbient) {
        stopListenAmbient(beat);
        // No title to tell songs apart: music resuming after a silence is treated as a new track,
        // so tempo and style are picked up from scratch instead of carried over.
        if (!hasTrackInfo) listenShow.startTrack(`untitled-${String(Math.round(nowMs))}`, '');
      }
      if (shouldShowAmbient) {
        setStatus('listening-idle');
        setPhase('idle'); // (not the last track's "Now playing" any more)
        setTrack(null);
        listenLastDisplayedTitle = '';
        listenLastDisplayedThumbnail = null;
        // Nothing meaningful to stay synced to once we've gone quiet/idle — resume the generated
        // ambient show rather than leaving a real map's beat clock running against silence. If the
        // same track resumes, the title won't have "changed" again, so sync won't automatically
        // re-trigger — a limitation, not a design choice; see the README.
        exitSyncMode();
      } else {
        setStatus('playing');
        setPhase('playing', displayTitle);
        setTrack({
          title: displayTitle,
          mapper: mediaArtist,
          coverUrl: listenCover(),
          environmentSupported: true,
          hasLightshow: true,
          hasAudio: true,
          usesChroma: false,
          usesNoodleExtensions: false,
          usesGLS: false,
          mapId: null,
        });
        listenLastDisplayedTitle = displayTitle;
        listenLastDisplayedThumbnail = listenCover();
      }
    } else if (
      !shouldShowAmbient &&
      (!listenSyncActive || listenSyncHandover) &&
      (displayTitle !== listenLastDisplayedTitle || listenCover() !== listenLastDisplayedThumbnail)
    ) {
      // Two separate reasons this can fire without shouldShowAmbient having flipped: the title
      // changed with no silence gap between tracks (the transition branch above never re-fires in
      // that case, so the status bar would otherwise keep showing the previous song's title
      // forever), or the *thumbnail* arrived or changed on its own — it comes from a separate
      // listener (wallpaperRegisterMediaThumbnailListener) that doesn't call setTrack() itself, so
      // without this check a thumbnail that loads slightly after the title would just sit unused
      // in mediaThumbnail forever, since nothing else was watching for it to change. Skipped
      // entirely while synced, since the panel shows the map's own cover then, not the API's —
      // except while a held map waits for the next track's (see holdSyncedMap): the panel already
      // shows the new track then.
      setPhase('playing', displayTitle);
      setTrack({
        title: displayTitle,
        mapper: mediaArtist,
        coverUrl: listenCover(),
        environmentSupported: true,
        hasLightshow: true,
        hasAudio: true,
        usesChroma: false,
        usesNoodleExtensions: false,
        usesGLS: false,
        mapId: null,
      });
      listenLastDisplayedTitle = displayTitle;
      listenLastDisplayedThumbnail = listenCover();
    }
    if (mediaTitle === '' && !hasWarnedAboutMediaIntegration) {
      hasWarnedAboutMediaIntegration = true;
      window.setTimeout(() => {
        if (mediaTitle === '') {
          showToast(t('media_integration_hint'));
        }
      }, 6000);
    }

    // A real, synced map is already fully set up on `view` by trySyncWithBeatSaverMap. It manages
    // its own beat source, but periodically double-checked against a fresh position reading in
    // case the media player keeps sending updates as the song continues — re-seeking if it's
    // drifted enough to matter. If it only ever reports position once per track, this simply never
    // finds anything to correct against and stays a no-op.
    if (listenSyncActive && listenSyncHandover) {
      // Held (see holdSyncedMap): nothing to slave; a map that ran out gives way to the generated
      // show if no next track (and so no search) turned up within the grace period.
      if (!listenSyncSearching && performance.now() - listenSyncHandoverSince > listenSyncHandoverGraceMs) exitSyncMode();
      return;
    }
    if (listenSyncActive && listenSyncClock !== null) {
      // The map's own audio file can be a slightly different length than the streaming version
      // (different edit, different fade-out) — if its clock has reached the end and stopped on its
      // own, staying "synced" any longer just means sitting frozen on the last frame while the real
      // song keeps playing. isPlaying() is checked as the primary signal, but backed up by a direct
      // comparison against duration too — belt and braces, since relying on a single internal flag
      // for something this important (getting stuck showed up as "broken" in exactly the way it was
      // reported) isn't worth the small extra cost of checking twice. Guarded by !listenSyncPaused
      // so our own pause below is never mistaken for the track having ended.
      const reachedEnd =
        !listenSyncPaused &&
        performance.now() - listenSyncStartedAt > LISTEN_SYNC_MIN_PLAY_MS &&
        (!listenSyncClock.isPlaying() || listenSyncClock.currentTime() >= listenSyncClock.duration - 0.1);
      if (reachedEnd) {
        holdSyncedMap(); // the next track is usually a moment away — see LISTEN_SYNC_END_GRACE_MS
      } else if (!listenSyncPaused) {
        setProgress(listenSyncClock.currentTime(), listenSyncClock.duration);
        if (
          !listenSyncCompletedMarked &&
          listenSyncClock.currentTime() >= listenSyncClock.duration * LISTEN_SYNC_COMPLETED_FRACTION &&
          performance.now() - listenSyncStartedAt > LISTEN_SYNC_COMPLETED_MIN_PLAY_MS
        ) {
          listenSyncCompletedMarked = true;
          markSyncCompleted();
        }
        document.body.dataset.listenHasProgress = 'true';
        // Continuously slaved to the player's own reported position (plus the constant offset
        // learned at startup) rather than left to free-run indefinitely — see the README for the
        // full history of why a hard-seek-only version could get stuck slightly wrong after a seek,
        // and why a soft, infrequent correction band was added on top of the immediate one.
        const target = positionOfThisTrack();
        // Right after a detected seek the reported position can still be the transient one (see
        // the timeline listener), so wait for it to settle before trusting it as the reference.
        const settlingAfterSeek = performance.now() - listenLastSeekDetectedAt < LISTEN_SEEK_SETTLE_MS;
        if (target !== null && !settlingAfterSeek) {
          const wanted = target + listenSyncOffsetSeconds + listenSyncLearnedOffset;
          const error = Math.abs(wanted - listenSyncClock.currentTime());
          const now = performance.now();
          let corrected = false;
          if (listenSyncDifferentEdit) {
            // The reported position doesn't map onto this edit of the song, so it never moves the
            // clock — it only tells us a seek happened, after which the audio has to be found anew.
            if (listenLastSeekDetectedAt > listenHandledSeekAt) {
              listenHandledSeekAt = listenLastSeekDetectedAt;
              resetAudioAlignment();
            }
          } else {
            if (error > LISTEN_SLAVE_HARD_SEEK_SECONDS) {
              // Confirmed on a second consecutive tick before actually jumping, not acted on
              // immediately — a single glitched position reading (the API is the one thing here we
              // can't fully trust; see the README on the measured latency for how much it varies)
              // would otherwise be enough to throw the map onto a wrong position for the rest of the
              // track, since nothing else afterwards would look wrong enough on its own to fix it. A
              // genuine seek keeps reporting the new position on the next tick too, so this doesn't
              // cost any real responsiveness there — only a glitch fails to reappear and gets
              // ignored, which is exactly the point.
              if (listenPendingHardSeek !== null && Math.abs(listenPendingHardSeek - wanted) < LISTEN_SLAVE_SOFT_RESYNC_SECONDS) {
                console.log(`[wallpaper] sync: seek detected, clock ${listenSyncClock.currentTime().toFixed(2)} -> ${wanted.toFixed(2)} s`);
                listenSyncClock.seek(wanted);
                listenLastSoftResyncCheckAt = now;
                listenPendingHardSeek = null;
                resetAudioAlignment();
                corrected = true;
              } else {
                listenPendingHardSeek = wanted;
              }
            } else {
              listenPendingHardSeek = null;
              // Once the audio has placed the map, this reported-position correction stays out of
              // it for the rest of the track (until a seek/pause resets the alignment) — also after
              // the lock is lost again: the readings jitter by more than the lock is accurate to,
              // and the player's report is off by however much the audio corrected in the first
              // place, so pulling the map back to it undid the audio sync (maps ran early again).
              if (
                !listenAudioFound &&
                error > LISTEN_SLAVE_SOFT_RESYNC_SECONDS &&
                now - listenLastSoftResyncCheckAt > LISTEN_SLAVE_SOFT_RESYNC_INTERVAL_MS
              ) {
                // Only the clock moves here, not the music: the audio collected so far stays valid.
                console.log(`[wallpaper] sync: following the reported position, clock ${(wanted - listenSyncClock.currentTime()).toFixed(2)} s`);
                listenAligner.shift(wanted - listenSyncClock.currentTime());
                listenSyncClock.seek(wanted);
                listenLastSoftResyncCheckAt = now;
                corrected = true;
              }
            }
          }
          if (!corrected && now - listenLastAlignAt > LISTEN_ALIGN_INTERVAL_MS) {
            listenLastAlignAt = now;
            corrected = alignSyncToAudio(listenSyncClock);
          }
          // "Confident" (the fallback for the status pill when the audio can't lock, see
          // refreshSyncStatus) needs a stretch of time with no correction at all — any
          // correction means we're still closing a gap.
          if (corrected) {
            listenLastSyncCorrectionAt = now;
            listenSyncConfident = false;
          } else if (!listenSyncConfident && now - listenLastSyncCorrectionAt > LISTEN_SYNC_CONFIDENT_AFTER_MS) {
            listenSyncConfident = true;
          }
          refreshSyncStatus();
        }
      }
      return;
    }

    if (shouldShowAmbient) {
      tickListenAmbient(beat);
      document.body.dataset.listenHasProgress = 'false';
    } else {
      tickListenReactive();
      // Not synced, but the player itself can still report where it is — Wallpaper Engine's
      // media-timeline API works independently of the sync feature, so this is shown whenever it's
      // available rather than being tied to sync being turned on at all.
      const livePosition = positionOfThisTrack();
      if (livePosition !== null && mediaDuration !== null) {
        document.body.dataset.listenHasProgress = 'true';
        setProgress(livePosition, mediaDuration);
      } else {
        document.body.dataset.listenHasProgress = 'false';
      }
    }

    // Trim old events past the trailing window so this doesn't grow forever over a long session.
    if (listenEvents.length > 400) trimListenEvents(beat);
    // The idle show schedules its color targets ahead of time, and the trim re-appends carried-over
    // events, so the list isn't chronological by construction — the light timelines binary-search
    // it, so it has to be. (Stable sort: same-beat events keep their push order.)
    listenEvents.sort((left, right) => left.songBpmTime - right.songBpmTime);

    // Rebuilding the render data isn't free, so new events are batched: they're scheduled ahead of
    // time, and a rebuild only happens right away when one of them is about to be due (a silence
    // fade, a punch, an instrument hit) — otherwise with the next batch, at most every
    // LISTEN_REBUILD_MAX_INTERVAL_MS (which also catches environment switches etc.).
    const now = performance.now();
    const tail = listenEvents[listenEvents.length - 1];
    const forced = listenRebuiltLength === -1 || listenColorOverride !== listenRebuiltOverride;
    const changed = forced || listenEvents.length !== listenRebuiltLength || tail !== listenRebuiltTail;
    const urgent =
      changed &&
      listenEvents.some((event) => event.songBpmTime < beat + LISTEN_URGENT_BEATS && !listenBuiltEvents.has(event));
    if (!forced && !urgent && now - listenRebuiltAt < LISTEN_REBUILD_MAX_INTERVAL_MS) return;
    if (!forced && !changed && now - listenRebuiltAt < LISTEN_REBUILD_MAX_INTERVAL_MS * 2) return;
    listenRebuiltLength = listenEvents.length;
    listenRebuiltTail = tail;
    listenRebuiltOverride = listenColorOverride;
    listenRebuiltAt = now;
    listenBuiltEvents = new Set(listenEvents);

    const difficulty = createDifficulty('3.3.0');
    difficulty.events = listenEvents;
    const data = buildMapRenderData(difficulty, {
      noteJumpSpeed: 10,
      noteStartBeatOffset: 0,
      songBpm: LISTEN_FAKE_BPM,
      legacyNoodleV2Semantics: false,
      environmentRemoval: [],
    });
    view.updateLightshow(data, listenColorOverride);
  }

  /** keepLook: re-entering only because the renderer was rebuilt (mirror quality change) — keep
   *  the environment/colors that were showing instead of picking new random ones. */
  function enterListenMode(options: { keepLook?: boolean } = {}) {
    listenEvents = [];
    listenRebuiltLength = -1;
    listenShow.startTrack('', '');
    ambientSegmentEnd = null;
    listenSyncActive = false;
    disposeListenSyncClock();
    listenLastSyncTitle = '';
    listenLastDisplayedTitle = '';
    listenLastDisplayedThumbnail = null;
    listenSyncToken += 1; // invalidate any sync attempt left over from before this (re-)entry
    // Start assuming idle/ambient (silent "forever ago") until a tick actually detects otherwise —
    // avoids a flash of the reactive show's silence-gated darkness before the first real reading.
    listenLastAudioActivityTime = 0;
    listenSoundStreakStart = 0;
    listenShowingAmbient = true;
    listenStartPerfTime = performance.now();
    setStatus('listening-idle');
    setPhase('idle');
    setTrack(null);

    // With "random environment/colors on track change" on, the screensaver starts on a random
    // environment/palette too — including the very first start — not on the one picked in the
    // settings (that's the starting point only while random switching is off).
    if (options.keepLook !== true) {
      listenActiveEnvironmentId = listenRandomEnvironment
        ? pickRandomListenEnvironment(listenEnvironmentId)
        : listenEnvironmentId;
      if (listenRandomColors) {
        listenPalette = randomHarmoniousPalette(listenPalette);
        listenColorOverride = paletteOverride(listenPalette);
      }
    }
    void view.setEnvironment(listenActiveEnvironmentId).then((result) => {
      if (result.isErr()) logEnvironmentError('failed to load listen-mode environment', result.error);
    });
    view.setBeatSource(() => (performance.now() - listenStartPerfTime) / 1000 / (60 / LISTEN_FAKE_BPM));
    if (listenUpdateTimer === null) listenUpdateTimer = window.setInterval(tickListenMode, LISTEN_UPDATE_INTERVAL_MS);
    tickListenMode(); // don't wait up to LISTEN_UPDATE_INTERVAL_MS for the first visible frame

    if (!hasWarnedAboutAudioData) {
      hasWarnedAboutAudioData = true;
      window.setTimeout(() => {
        if (!hasReceivedAnyAudioData) {
          showToast(t('no_audio_hint'));
          console.warn(
            '[wallpaper] no audio samples received after entering listen mode — check that ' +
              '"supportsaudioprocessing" took effect (may need Change Project Settings or a full ' +
              're-import in Wallpaper Engine) and that audio capture is allowed in its own settings',
          );
        }
      }, 6000);
    }
  }

  if (typeof window.wallpaperRegisterAudioListener === 'function') {
    window.wallpaperRegisterAudioListener((audioArray) => {
      if (!hasReceivedAnyAudioData) {
        hasReceivedAnyAudioData = true;
        console.log('[wallpaper] first audio sample received from Wallpaper Engine — audio capture is working');
      }
      let framePeak = 0;
      for (const value of audioArray) if (value > framePeak) framePeak = value;
      const frameAt = performance.now();
      listenRecentPeak *= Math.pow(0.5, (frameAt - listenRecentPeakAt) / LISTEN_SOUND_LEVEL_HALF_LIFE_MS);
      listenRecentPeakAt = frameAt;
      if (framePeak > listenRecentPeak) listenRecentPeak = framePeak;
      if (framePeak > Math.max(LISTEN_SOUND_MIN_LEVEL, listenRecentPeak * LISTEN_SOUND_RELATIVE_LEVEL)) {
        listenLastSoundFrameAt = frameAt;
      }
      listenShow.addFrame(audioArray, performance.now() / 1000);
      if (listenSyncActive && !listenSyncPaused && !listenSyncHandover && listenSyncClock !== null) {
        // Recorded against the map's file time the clock shows right now, without the manual
        // offset (that one is the user's own preference on top of a correct alignment).
        const fileTime = listenSyncClock.currentTime() - listenSyncOffsetSeconds - listenSyncSongTimeOffset;
        listenAligner.addFrame(audioArray, fileTime, performance.now() / 1000);
      }
    });
  } else {
    console.warn('[wallpaper] window.wallpaperRegisterAudioListener is not available (not running in Wallpaper Engine?)');
  }
  // Deliberately not using MediaStatusListener/MediaPlaybackListener as hard gates here — Wallpaper
  // Engine's own documentation gives two different, conflicting property paths for the playback
  // state constants, so trusting either blindly risked silently never detecting "playing" at all.
  // A non-empty title from MediaPropertiesListener, combined with the real silence detection in
  // tickListenMode above, is what actually decides idle vs. active now.
  if (typeof window.wallpaperRegisterMediaPropertiesListener === 'function') {
    window.wallpaperRegisterMediaPropertiesListener((event) => {
      const title = event.title ?? '';
      if (title !== mediaTitle) mediaTitleChangedAt = performance.now();
      mediaTitle = title;
      mediaArtist = event.artist ?? '';
      mediaGenres = event.genres ?? '';
      mediaAlbum = event.albumTitle ?? '';
    });
  }
  if (typeof window.wallpaperRegisterMediaThumbnailListener === 'function') {
    window.wallpaperRegisterMediaThumbnailListener((event) => {
      // Some players send extra thumbnail events without an image (color-only updates); those
      // must not wipe a cover that's already there. An explicit empty string does mean "no cover".
      if (typeof event.thumbnail !== 'string') return;
      const thumbnail = event.thumbnail.startsWith('data:') || /^https?:|^file:|^blob:/.test(event.thumbnail) ? event.thumbnail : null;
      if (thumbnail !== mediaThumbnail) {
        mediaThumbnailChangedAt = performance.now();
        console.log(`[wallpaper] media thumbnail: ${thumbnail === null ? 'none' : `${thumbnail.slice(0, 30)}… (${String(thumbnail.length)} chars)`}`);
      }
      mediaThumbnail = thumbnail;
    });
  }
  // Powers "sync mode" only — position/duration reporting is optional and not every media player
  // sends it ("Not all media players support this feature" per Wallpaper Engine's own docs), so
  // sync mode has to cope with mediaPosition simply staying null the whole time (see
  // estimateCurrentPosition and trySyncWithBeatSaverMap).
  if (typeof window.wallpaperRegisterMediaTimelineListener === 'function') {
    window.wallpaperRegisterMediaTimelineListener((event) => {
      if (typeof event.position === 'number') {
        // A jump far bigger than the time actually elapsed since the last update means you seeked.
        // Around a seek a streaming player often reports the *target* position before the audio has
        // resumed there, so the first reading or two can be ahead of what's really playing — and
        // because sync then keeps slaving to that same skewed reference, it stays wrong for the
        // rest of the track, which matches "after seeking I have to find a different value".
        // Noting when it happened lets the slaving loop hold off briefly and take a settled reading
        // instead of locking onto the transient one.
        const elapsed = (performance.now() - mediaPositionUpdatedAt) / 1000;
        const jumped = mediaPosition !== null && Math.abs(event.position - (mediaPosition + elapsed)) > 2.5;
        if (jumped) listenLastSeekDetectedAt = performance.now();
        else if (mediaPosition !== null && event.position > mediaPosition + 0.2) mediaPositionAdvancedAt = performance.now();
        mediaPosition = event.position;
        mediaPositionUpdatedAt = performance.now();
      }
      if (typeof event.duration === 'number') {
        // Only a real change counts as "new" — players resend the same duration with every position
        // update, and those repeats must not make the previous track's length look fresh.
        if (mediaDuration === null || Math.abs(event.duration - mediaDuration) > 0.5) {
          mediaDurationChangedAt = performance.now();
        }
        mediaDuration = event.duration;
      }
    });
  }

  // Mouse-parallax: web wallpapers in Wallpaper Engine do receive plain document-level mousemove
  // (this is exactly how other web wallpapers on the workshop implement their own parallax, so
  // it's a well-established technique rather than a guess) — unlike the wheel/drag events, which
  // are documented as *not* forwarded.
  document.addEventListener('mousemove', (event) => {
    if (!parallaxEnabled) return;
    const nx = (event.clientX / window.innerWidth) * 2 - 1; // -1..1, left to right
    const ny = (event.clientY / window.innerHeight) * 2 - 1; // -1..1, top to bottom
    const signX = parallaxInvertX ? -1 : 1;
    const signY = parallaxInvertY ? -1 : 1;
    view.setParallax(nx * parallaxIntensity * signX, ny * parallaxIntensity * signY);
  });

  function rebuildRenderer() {
    // Stop "listen" mode's own ticking against the *old* view before disposing it — otherwise a
    // tick already queued for this instant could still call view.setMap() on a view that's either
    // mid-dispose or already gone. enterListenMode() below restarts it cleanly on the new view.
    if (listenUpdateTimer !== null) {
      window.clearInterval(listenUpdateTimer);
      listenUpdateTimer = null;
    }
    view.dispose();
    lifecycle.dispose();
    ({ lifecycle, view } = createRenderer());
    // Mirror resolution can only be set at creation, so the screensaver is re-entered on the new
    // view — keeping the environment/colors that were showing.
    enterListenMode({ keepLook: true });
  }


  listenForWallpaperControls({
    onCameraChange: (fov, distance) => {
      graphics.cameraFov = fov;
      graphics.cameraDistance = distance;
      view.setReplayCameraSettings({
        ...DEFAULT_REPLAY_CAMERA_SETTINGS,
        replayCameraFov: fov,
        previewCameraDistance: distance,
      });
    },
    onMirrorQualityChange: (quality) => {
      if (quality === graphics.mirrorQuality) return;
      graphics.mirrorQuality = quality;
      rebuildRenderer();
    },
    onScreenDisplacementChange: (enabled) => {
      graphics.screenDisplacement = enabled;
      view.setScreenDisplacementEffects(enabled);
    },
    onShowPlayerPlatformChange: (enabled) => {
      graphics.showPlayerPlatform = enabled;
      view.setShowPlayerPlatform(enabled);
    },
    onShowWallsChange: (enabled) => {
      graphics.showWalls = enabled;
      applyShowWalls();
    },
    onCacheSizeChange: (megabytes) => {
      const bytes = Math.min(Math.max(megabytes, 256), 20480) * 1024 * 1024;
      const wasPending = cacheSizeTimer !== null;
      if (cacheSizeTimer !== null) window.clearTimeout(cacheSizeTimer);
      cacheSizeTimer = null;
      // The value saved in the settings applies right away at startup; a change made afterwards
      // waits CACHE_SIZE_APPLY_DELAY_MS, so brushing the slider by accident doesn't immediately
      // wipe maps out of the cache (moving it back within that time cancels the change).
      if (!cacheSizeInitialized) {
        cacheSizeInitialized = true;
        browserMapArchiveCache?.setLimit(bytes);
        return;
      }
      if (browserMapArchiveCache === null) return;
      if (bytes === browserMapArchiveCache.limit) {
        if (wasPending) showToast(t('cache_size_cancelled'));
        return;
      }
      showToast(t('cache_size_pending', { size: formatCacheSize(bytes), seconds: String(CACHE_SIZE_APPLY_DELAY_MS / 1000) }));
      cacheSizeTimer = window.setTimeout(() => {
        cacheSizeTimer = null;
        browserMapArchiveCache?.setLimit(bytes);
        showToast(t('cache_size_applied', { size: formatCacheSize(bytes) }));
      }, CACHE_SIZE_APPLY_DELAY_MS);
    },
    onRenderScaleChange: (scale) => {
      graphics.renderScale = scale;
      lifecycle.setRenderScale(scale);
    },
    onUiPositionChange: (position) => {
      document.body.dataset.uiPosition = position;
    },
    onUiScaleChange: (scale) => {
      // Scales the player, its pills, the toast and the startup notices (see setUiScale).
      setUiScale(scale);
    },
    onPinPanelChange: (pinned) => {
      setPanelPinned(pinned);
    },
    onPinStatusChange: (pinned) => {
      setStatusPinned(pinned);
    },
    onListenEnvironmentChange: (environmentId) => {
      listenEnvironmentId = environmentId;
      // Picking an environment explicitly always shows it, even with random switching on — the
      // next track change moves on from there.
      listenActiveEnvironmentId = environmentId;
      // Only touches the view immediately if we're actually showing the generated show right now —
      // while a synced real map is up, its own environment stays in charge until sync ends, at
      // which point exitSyncMode() below re-applies whatever this was most recently set to. (Before
      // the screensaver has started, enterListenMode loads it itself.)
      if (listenUpdateTimer !== null && !listenSyncActive) {
        void view.setEnvironment(listenEnvironmentId).then((result) => {
          if (result.isErr()) logEnvironmentError('failed to load listen-mode environment', result.error);
        });
      }
    },
    onListenRandomEnvironmentChange: (enabled) => {
      listenRandomEnvironment = enabled;
    },
    onListenColorsChange: (colors) => {
      const wasRandom = listenRandomColors;
      listenRandomColors = colors.mode === 'random';
      listenCustomColors = colors.mode === 'custom' ? { left: colors.left, right: colors.right } : null;
      if (colors.mode === 'custom') {
        listenColorOverride = customColorsOverride({ left: colors.left, right: colors.right });
      } else if (colors.mode === 'random') {
        // Switching to random shows a random palette right away, not only from the next track on.
        if (!wasRandom || listenPalette === null) {
          listenPalette = randomHarmoniousPalette(listenPalette);
          listenColorOverride = paletteOverride(listenPalette);
        }
      } else {
        // Back to the environment's own colors right away rather than keeping the last ones.
        listenPalette = null;
        listenColorOverride = undefined;
      }
      refreshSyncedMapColors();
    },
    onListenColorsSyncedChange: (enabled) => {
      listenColorsSynced = enabled;
      refreshSyncedMapColors();
    },
    onListenSyncEnabledChange: (enabled) => {
      listenSyncEnabled = enabled;
      if (!enabled) {
        // Turning it off mid-sync should hand back control to the generated show immediately,
        // not just stop future sync attempts.
        listenVersions = null;
        exitSyncMode();
        listenSyncToken += 1;
      } else if (mediaTitle !== '') {
        // Turning it on while a track is already playing shouldn't require a track change to
        // actually try syncing — re-arm the "title changed" check by forgetting the last title.
        listenLastSyncTitle = '';
      }
    },
    onListenSyncRichMapsChange: (enabled) => {
      listenSyncRichMaps = enabled;
    },
    onListenSyncOffsetChange: (offsetSeconds) => {
      const delta = offsetSeconds - listenSyncOffsetSeconds;
      listenSyncOffsetSeconds = offsetSeconds;
      // Applied straight away: once the audio has locked, the slaving loop below no longer makes
      // small corrections on its own, so it wouldn't pick this up.
      if (listenSyncActive && listenSyncClock !== null && !listenSyncPaused && delta !== 0) {
        listenSyncClock.seek(listenSyncClock.currentTime() + delta);
      }
      // Changing either of these shifts the target the slaving loop is aiming at, so let it act
      // immediately rather than waiting out the soft-resync interval — otherwise dragging the
      // slider appears to do nothing for several seconds and then jump, which reads as drift.
      listenLastSoftResyncCheckAt = 0;
    },
    onLanguageChange: (language) => {
      setLanguage(language === 'auto' ? resolveAutoLanguage() : language);
    },
    onParallaxEnabledChange: (enabled) => {
      parallaxEnabled = enabled;
      if (!enabled) view.setParallax(0, 0); // ease/snap back to the normal fixed camera
    },
    onParallaxIntensityChange: (intensity) => {
      parallaxIntensity = intensity;
    },
    onParallaxInvertXChange: (inverted) => {
      parallaxInvertX = inverted;
    },
    onParallaxInvertYChange: (inverted) => {
      parallaxInvertY = inverted;
    },
    onParallaxJellyChange: (amount) => {
      parallaxJelly = amount;
      view.setParallaxJelly(amount);
    },
    onShowEpilepsyWarningChange: (enabled) => {
      epilepsyWarningEnabled = enabled;
      if (!enabled) hideEpilepsyWarning();
      else if (startupNoticesDone) showEpilepsyWarning(); // switched on in the settings: show it now
    },
    onShowFpsChange: (enabled) => {
      setFpsCounterEnabled(enabled);
    },
    onFpsLimitChange: (fps) => {
      setMaxRenderFrameRate(fps);
    },
    onShowUiHintChange: (enabled) => {
      uiHintEnabled = enabled;
      if (!enabled) hideUiHint();
      else if (startupNoticesDone) showUiHint();
    },
    onPausedChange: (paused) => {
      // Wallpaper Engine paused us (a fullscreen app etc.): nothing is visible, so the screensaver
      // mode's analysis/rebuild tick stops too; it picks up again on resume.
      wallpaperPaused = paused;
      if (!paused) listenRebuiltLength = -1;
    },
  });
  // Startup notices, once the settings (including whether they're wanted, and a pinned-open panel
  // that makes the hint pointless) have been applied above.
  if (epilepsyWarningEnabled) showEpilepsyWarning();
  if (uiHintEnabled) showUiHint();
  startupNoticesDone = true;

  initNowPlayingControls({
    onExitSync: () => {
      // The ⏏ button while synced: drop the map for this track and go back to the generated show.
      // The title stays "seen", so it won't search again until the next track. The map is also
      // forgotten for this track (it's most likely the wrong one), so next time it's searched anew.
      if (!listenSyncActive) return;
      console.log('[wallpaper] sync: left the map by button — back to the generated lightshow');
      // A version chosen in the player is dropped from the choice too; the search's memory only if
      // it was the search's own pick.
      if (listenSyncMemory !== null) {
        const { title, artist, hash } = listenSyncMemory;
        forgetChoice(title, artist, hash);
        const bestHash = listenVersions?.title === title && listenVersions.artist === artist ? listenVersions.bestHash : null;
        if (bestHash === null || bestHash === hash) forgetSync(title, artist);
      }
      listenSyncToken += 1;
      exitSyncMode();
    },
    onChooseVersion: (hash) => {
      // A version in the "Other versions" list: pinned for this track, and switched to right away
      // (downloaded if needed) — the map playing now stays up until the chosen one is ready.
      const state = listenVersions;
      if (state === null) return;
      const choice = recallChoice(state.title, state.artist, null);
      const version =
        state.versions.find((candidate) => candidate.hash === hash) ??
        (listenSyncPlayingVersion?.hash === hash ? listenSyncPlayingVersion : null) ??
        (choice?.pinned?.hash === hash ? choice.pinned : null) ??
        (choice?.completed?.hash === hash ? choice.completed : null);
      if (version === null) return;
      pinVersion(state.title, state.artist, version, freshMediaDuration());
      const playingNow =
        listenSyncActive && !listenSyncHandover && listenSyncMemory?.title === state.title && listenSyncMemory.hash === hash;
      const sameTrack = mediaTitle === state.title && mediaArtist === state.artist;
      console.log(`[wallpaper] sync: chose "${version.title}" (${version.mapId}) for "${state.title}"${playingNow ? '' : ' — switching to it'}`);
      if (!playingNow && sameTrack && listenSyncEnabled) {
        showToast(t('versions_switching'));
        void trySyncWithBeatSaverMap(state.title, state.artist);
      } else {
        showToast(t('versions_pinned'));
      }
      refreshVersionsView();
    },
    onUnpinVersion: (hash) => {
      // The pinned version's button again: the choice is cleared (what's playing stays).
      const state = listenVersions;
      if (state === null || recallChoice(state.title, state.artist, null)?.pinned?.hash !== hash) return;
      pinVersion(state.title, state.artist, null, freshMediaDuration());
      console.log(`[wallpaper] sync: unpinned the version for "${state.title}"`);
      showToast(t('versions_unpinned'));
      refreshVersionsView();
    },
    onRandomEnvironment: () => {
      // The 🎲 button in the player: a new random environment right now, through the usual fade —
      // plus new colors too if random colors are enabled.
      void randomizeListenLook({ forceEnvironment: true });
    },
  });

  enterListenMode();
}

void main().catch((error: unknown) => {
  console.error('[wallpaper] fatal error', error);
  setStatus('error');
});
