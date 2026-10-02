import { t } from './i18n';
import { version as APP_VERSION } from '../../package.json';

// Shown in the panel whenever nothing is playing (see setTrack(null)).
const APP_NAME = 'ChroPaper';
const APP_AUTHOR = 'Yougurton';

export type HudPhase = 'playing' | 'idle';

export interface TrackMeta {
  title: string;
  mapper: string;
  coverUrl: string | null;
  environmentSupported: boolean;
  hasLightshow: boolean;
  hasAudio: boolean;
  usesChroma: boolean;
  usesNoodleExtensions: boolean;
  usesGLS: boolean;
  /** BeatSaver's short map id, for the "copy link" button — null for the generated show. */
  mapId: string | null;
}

export interface NowPlayingHandlers {
  /** The 🎲 button (generated show): switch to a random environment right away. */
  onRandomEnvironment(): void;
  /** The ⏏ button, while synced to a BeatSaver map: drop the map, back to the generated show. */
  onExitSync(): void;
  /** A row in "Other versions" (or its "Choose" button): switch to that version now, and keep
   *  playing it for this track. */
  onChooseVersion(hash: string): void;
  /** The chosen version's button again: clear the choice. */
  onUnpinVersion(hash: string): void;
}

/** One map of the playing song in the "Other versions" list (☰). */
export interface VersionRow {
  hash: string;
  title: string;
  mapper: string;
  coverUrl: string | null;
  /** The map's length in seconds, null if unknown. */
  duration: number | null;
  /** Synced to right now. */
  isCurrent: boolean;
  /** Picked by hand: plays the next time the track does. */
  isPinned: boolean;
  /** Played to the end last time (and not the search's own pick): the main version unless one is pinned. */
  isCompleted: boolean;
  environmentSupported: boolean;
  usesChroma: boolean;
  usesNoodleExtensions: boolean;
  mightUseGLS: boolean;
  /** Its length is off the track's: another edit of the song. */
  differentEdit: boolean;
  /** Why the search wouldn't pick it on its own (see MapVersion.excluded). */
  excluded: 'unsupported' | 'rich' | null;
}

function phaseLabel(phase: HudPhase): string {
  return t(phase === 'playing' ? 'phase_playing' : 'phase_idle');
}

const PILL_AUTO_HIDE_MS = 6000;
// The panel also closes on its own after this much mouse inactivity, even if the cursor never
// actually left the hover area (e.g. the user forgot about it).
const PANEL_IDLE_HIDE_MS = 4000;
// Matches the opacity/transform transition duration on #now-playing-panel.expanded in index.html.
const PANEL_COLLAPSE_TRANSITION_MS = 180;
// A real pause before mouseleave actually starts collapsing anything — not just relying on
// #now-playing-hover-buffer's spatial margin, which only helps if the cursor happens to still be
// within it; a fast mouse movement crosses even a generous margin in a fraction of a second. This
// gives a genuine window to move back in regardless of trajectory or speed, and is cancelled by
// mouseenter the same way the collapse-transition delay already is.
const PANEL_LEAVE_GRACE_MS = 500;
let panelLeaveGraceTimeout: number | null = null;
let panelCollapseTimeout: number | null = null;
const TOAST_VISIBLE_MS = 5000;

let pillHideTimer: number | null = null;
let panelIdleTimer: number | null = null;
let toastHideTimer: number | null = null;
let previousCoverUrl: string | null = null;
// public/cover.jpg — Vite copies public/ as-is next to index.html, and base is './', so a plain
// relative path resolves both in dev and in the built wallpaper. Deliberately not preview.jpg:
// Wallpaper Engine overwrites that one with the workshop preview when the project is edited there.
const FALLBACK_COVER_URL = 'cover.jpg';
let statusPinned = false;
let panelPinned = false;
let lastPhase: HudPhase | null = null;
let currentMapId: string | null = null;

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(minutes)}:${secs.toString().padStart(2, '0')}`;
}

/** "Interface scale": 0.5–3 (1 = normal). The CSS in index.html scales everything of the interface
 *  with var(--ui-scale); the same rules are also written out here with the plain number in a
 *  stylesheet of their own, which wins over them — Wallpaper Engine's browser was seen logging the
 *  new scale while the interface stayed the same size, i.e. not picking up the variable's change. */
export function setUiScale(scale: number) {
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  let override = document.getElementById('ui-scale-override');
  if (!(override instanceof HTMLStyleElement)) {
    override = document.createElement('style');
    override.id = 'ui-scale-override';
    document.head.appendChild(override);
  }
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.ownerNode === override) continue;
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSStyleRule && rule.cssText.includes('var(--ui-scale)')) {
        rules.push(rule.cssText.split('var(--ui-scale)').join(String(scale)));
      }
    }
  }
  override.textContent = rules.join('\n');
  const playerTransform = getComputedStyle(byId('now-playing') ?? document.body).transform;
  console.log(`[wallpaper] interface scale ${String(Math.round(scale * 100))} % (${String(rules.length)} rules, player transform ${playerTransform})`);
}

/** The FPS counter left of the status pill ("FPS counter" in the settings). null hides it. */
export function setFps(fps: number | null) {
  const element = byId('hud-fps');
  if (element === null) return;
  element.hidden = fps === null;
  if (fps !== null) element.textContent = `${String(Math.round(fps))} FPS`;
}

/** title can be left empty while a map is still downloading/parsing and its name isn't known yet. */
export function setPhase(phase: HudPhase, title = '') {
  const pill = byId('now-playing-pill');
  const phaseEl = byId('hud-phase');
  const titleEl = byId('hud-title');
  if (pill === null || phaseEl === null || titleEl === null) return;

  const changed = phase !== lastPhase || titleEl.textContent !== title;
  lastPhase = phase;
  phaseEl.textContent = phaseLabel(phase);
  titleEl.textContent = title;
  pill.classList.add('visible');
  if (changed) {
    // (The pill itself, not the title span: transforms don't apply to inline text.)
    pill.classList.remove('np-pill-in');
    void pill.offsetWidth;
    pill.classList.add('np-pill-in');
  }

  if (pillHideTimer !== null) {
    window.clearTimeout(pillHideTimer);
    pillHideTimer = null;
  }
  if ((phase === 'playing' || phase === 'idle') && !statusPinned) {
    pillHideTimer = window.setTimeout(() => pill.classList.remove('visible'), PILL_AUTO_HIDE_MS);
  }
}

const SYNC_PILL_FADE_MS = 250;
const SYNC_MESSAGE_VISIBLE_MS = 5000;
let syncPillHideTimer: number | null = null;
let shownSyncKey = 'none';

/** Sync mode's status pill, left of the status pill (with the FPS counter): searching for the map,
 *  downloading it (with a progress bar), then syncing
 *  until the map has been lined up against the audio — or, for a few seconds, that no map was
 *  found or it couldn't be downloaded. null hides it — nothing to report, or the
 *  map is locked to the music. progress is 0..1 while downloading (null/omitted: unknown). */
export function setListenSyncStatus(
  status: 'searching' | 'downloading' | 'aligning' | 'paused' | 'not_found' | 'download_failed' | null,
  progress?: number | null,
) {
  const pill = byId('hud-sync');
  const text = byId('hud-sync-text');
  const bar = byId('hud-sync-bar');
  const fill = byId('hud-sync-fill');
  if (pill === null || text === null || bar === null || fill === null) return;
  // Called every tick while synced — only touch the DOM when something actually changed.
  const key = status === null ? 'none' : `${status}|${String(progress ?? '')}|${t('sync_status_aligning')}`;
  if (key === shownSyncKey) return;
  shownSyncKey = key;
  if (syncPillHideTimer !== null) {
    window.clearTimeout(syncPillHideTimer);
    syncPillHideTimer = null;
  }
  // The status pill stays up alongside it, so it doesn't float next to an empty spot.
  if (status === null) delete document.body.dataset.syncPill;
  else document.body.dataset.syncPill = 'true';
  if (status === null) {
    if (pill.hidden) return;
    pill.classList.remove('visible');
    syncPillHideTimer = window.setTimeout(() => {
      syncPillHideTimer = null;
      pill.hidden = true;
    }, SYNC_PILL_FADE_MS);
    return;
  }
  if (pill.hidden) {
    pill.hidden = false;
    void pill.offsetWidth; // start the fade/slide-in from the hidden state
  }
  pill.classList.add('visible');

  const known = typeof progress === 'number';
  if (status === 'searching') {
    text.textContent = t('sync_status_searching');
  } else if (status === 'downloading') {
    const percent = known ? ` ${String(Math.round(Math.min(1, Math.max(0, progress)) * 100))}%` : '';
    text.textContent = t('sync_status_downloading', { percent });
  } else if (status === 'aligning') {
    text.textContent = t('sync_status_aligning');
  } else if (status === 'paused') {
    text.textContent = t('sync_status_paused');
  } else {
    text.textContent = t(status === 'not_found' ? 'sync_status_not_found' : 'sync_status_download_failed');
    // A one-off message rather than a state: it goes away on its own.
    syncPillHideTimer = window.setTimeout(() => setListenSyncStatus(null), SYNC_MESSAGE_VISIBLE_MS);
  }
  bar.hidden = status === 'paused' || status === 'not_found' || status === 'download_failed';
  if (status === 'downloading' && known) {
    fill.classList.remove('indeterminate');
    fill.style.width = `${String(Math.round(Math.min(1, Math.max(0, progress)) * 100))}%`;
  } else {
    fill.classList.add('indeterminate');
  }
}

/** Nothing playing: "v1.0.0 · Yougurton · About" in place of the mapper line, where "About" copies
 *  the wallpaper's page link (handled by the delegated click listener in initNowPlayingControls). */
function renderAppInfo(element: HTMLElement) {
  const about = document.createElement('button');
  about.type = 'button';
  about.className = 'np-about-link';
  about.dataset.i18n = 'app_about';
  about.textContent = t('app_about');
  about.title = t('app_about_title');
  element.replaceChildren(`v${APP_VERSION} · ${APP_AUTHOR} · `, about);
}

// Track-change slide (see setTrack): what the panel currently shows, and the update waiting for the
// outgoing slide to finish.
const SLIDE_OUT_MS = 150;
const COVER_LOAD_WAIT_MS = 300;
let displayedTitle: string | null = null;
let displayedCover: string | null = null;
let pendingTrack: TrackMeta | null = null;
let slideTimer: number | null = null;
let slidingText = false;
let slidingCover = false;

function restartAnimation(element: HTMLElement | null, className: string) {
  if (element === null) return;
  element.classList.remove('np-slide-in', 'np-slide-out');
  void element.offsetWidth; // (reflow, so re-adding the same class restarts the animation)
  element.classList.add(className);
}

function panelIsShown() {
  const panel = byId('now-playing-panel');
  return (
    panel !== null &&
    panel.offsetParent !== null &&
    (panel.classList.contains('expanded') || panel.classList.contains('pinned'))
  );
}

/** Pass null when nothing is playing (the panel then shows the wallpaper's own name and version).
 *  A new title slides the text out to the left and the new one in from the right; a new cover does
 *  the same for the cover — each only when it actually changed (the screensaver's cover often
 *  arrives a moment after the title, and then only the cover moves). The cover slides in once its
 *  image has loaded (briefly waited for), so it doesn't arrive blank. Only while the panel is
 *  visible; otherwise everything is updated at once. */
export function setTrack(track: TrackMeta | null) {
  // Only for a real map (it has a BeatSaver id) — the generated show has no mapper to name.
  setMapperPill(track !== null && track.mapId !== null ? track.mapper : '');
  const title = track?.title ?? '';
  const cover = track?.coverUrl ?? '';
  pendingTrack = track;
  if (displayedTitle === null || !panelIsShown()) {
    if (slideTimer === null) applyTrack(track);
    return;
  }
  const textChanged = title !== displayedTitle;
  const coverChanged = cover !== displayedCover;
  const info = byId('np-info');
  const coverEl = byId('np-cover');
  // Mid-slide, a further change joins it (the newest update is what slides in).
  if (textChanged && !slidingText) {
    slidingText = true;
    restartAnimation(info, 'np-slide-out');
  }
  if (coverChanged && !slidingCover) {
    slidingCover = true;
    restartAnimation(coverEl, 'np-slide-out');
  }
  if (slideTimer !== null) return;
  if (!slidingText && !slidingCover) {
    applyTrack(track);
    return;
  }
  slideTimer = window.setTimeout(() => {
    slideTimer = null;
    const next = pendingTrack;
    const text = slidingText;
    const coverSlide = slidingCover;
    slidingText = slidingCover = false;
    applyTrack(next);
    if (text) restartAnimation(info, 'np-slide-in');
    if (!coverSlide) return;
    if (!(coverEl instanceof HTMLImageElement) || coverEl.complete) {
      restartAnimation(coverEl, 'np-slide-in');
      return;
    }
    let shown = false;
    const show = () => {
      if (shown) return;
      shown = true;
      restartAnimation(coverEl, 'np-slide-in');
    };
    coverEl.addEventListener('load', show, { once: true });
    coverEl.addEventListener('error', show, { once: true });
    window.setTimeout(show, COVER_LOAD_WAIT_MS);
  }, SLIDE_OUT_MS);
}

/** "Map by: …" — a pill of its own right of the status pill, while a map is synced. It shows and
 *  hides together with the status pill (see the CSS), and slides in the same way when it changes. */
let shownMapper = '';
function setMapperPill(mapper: string) {
  if (mapper === shownMapper) return;
  shownMapper = mapper;
  const pill = byId('hud-mapper-pill');
  const name = byId('hud-mapper-name');
  if (pill === null || name === null) return;
  pill.hidden = mapper === '';
  if (mapper === '') return;
  name.textContent = mapper;
  pill.classList.remove('np-pill-in');
  void pill.offsetWidth;
  pill.classList.add('np-pill-in');
}

function applyTrack(track: TrackMeta | null) {
  displayedTitle = track?.title ?? '';
  displayedCover = track?.coverUrl ?? '';
  currentMapId = track?.mapId ?? null;
  const titleEl = byId('np-title');
  const mapperEl = byId('np-mapper');
  const badgeEl = byId('np-unsupported');
  const noLightshowEl = byId('np-no-lightshow');
  const noAudioEl = byId('np-no-audio');
  const glsEl = byId('np-gls');
  const chromaEl = byId('np-chroma');
  const noodleEl = byId('np-noodle');
  const coverEl = byId<HTMLImageElement>('np-cover');
  const mapLinkEl = byId('np-map-link');
  if (titleEl !== null) titleEl.textContent = track?.title ?? APP_NAME;
  if (mapperEl !== null) {
    if (track === null) renderAppInfo(mapperEl);
    // A real map names its mapper; for the generated show this line is just the track's artist.
    else if (track.mapId === null) mapperEl.textContent = track.mapper;
    else mapperEl.textContent = track.mapper !== '' ? t('track_mapper_by', { mapper: track.mapper }) : '';
  }
  if (badgeEl !== null) badgeEl.hidden = track === null || track.environmentSupported;
  if (noLightshowEl !== null) noLightshowEl.hidden = track === null || track.hasLightshow;
  if (noAudioEl !== null) noAudioEl.hidden = track === null || track.hasAudio;
  // GLS gets priority (checked/shown first) when a map has both — see the CSS for why they're
  // now different colours too, so having both visible at once reads clearly as two badges.
  if (glsEl !== null) glsEl.hidden = track === null || !track.usesGLS;
  if (chromaEl !== null) chromaEl.hidden = track === null || !track.usesChroma;
  if (noodleEl !== null) noodleEl.hidden = track === null || !track.usesNoodleExtensions;
  if (mapLinkEl !== null) {
    mapLinkEl.hidden = currentMapId === null;
    mapLinkEl.title = t('view_map_title');
  }
  if (coverEl !== null) {
    const coverUrl = track?.coverUrl ?? null;
    // (Never revoke the URL that's about to be shown again — a repeat setTrack() with the same
    // cover would otherwise break its own image.)
    if (previousCoverUrl !== null && previousCoverUrl !== coverUrl && previousCoverUrl.startsWith('blob:')) {
      URL.revokeObjectURL(previousCoverUrl);
    }
    previousCoverUrl = coverUrl;
    // No cover of its own (no thumbnail from the player, nothing playing at all) → the wallpaper's own preview image from public/. Same if
    // the cover exists but fails to load (a broken/truncated image, an unreachable URL).
    const wanted = coverUrl ?? FALLBACK_COVER_URL;
    coverEl.onerror = () => {
      coverEl.onerror = null;
      if (coverEl.src !== new URL(FALLBACK_COVER_URL, document.baseURI).href) {
        console.warn('[wallpaper] cover failed to load, showing the fallback image');
        coverEl.src = FALLBACK_COVER_URL;
      }
    };
    if (coverEl.getAttribute('src') !== wanted) coverEl.src = wanted;
  }
  // Deliberately not force-collapsing here just because there's no track (setTrack(null) happens
  // for every ordinary loading transition too, not only genuinely empty states) — see the
  // mouseenter handler for why the panel needs to stay reachable through those.
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy fallback below (older/execCommand-only environments, or a
    // rejected permission) — better to try a second way than to just give up silently.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export function setProgress(currentSeconds: number, durationSeconds: number) {
  const currentEl = byId('np-current-time');
  const durationEl = byId('np-duration');
  const fillEl = byId('np-progress-fill');
  if (currentEl !== null) currentEl.textContent = formatTime(currentSeconds);
  if (durationEl !== null) durationEl.textContent = formatTime(durationSeconds);
  if (fillEl !== null) {
    const percent = durationSeconds > 0 ? Math.min(100, (currentSeconds / durationSeconds) * 100) : 0;
    fillEl.style.width = `${String(percent)}%`;
  }
}

// Startup notices (both switchable in the wallpaper's settings, see main.ts): the photosensitivity
// warning and the hint on how to open the player. Each shows for NOTICE_VISIBLE_MS; the hint also
// goes away as soon as the player is opened.
const NOTICE_VISIBLE_MS = 10_000;
const noticeTimers = new Map<string, number>();

function showNotice(id: string) {
  const element = byId(id);
  if (element === null) return;
  const previous = noticeTimers.get(id);
  if (previous !== undefined) window.clearTimeout(previous);
  element.hidden = false;
  element.classList.remove('visible');
  void element.offsetWidth; // (restart the fade-in and the countdown bar)
  element.classList.add('visible');
  noticeTimers.set(id, window.setTimeout(() => hideNotice(id), NOTICE_VISIBLE_MS));
}

function hideNotice(id: string) {
  const element = byId(id);
  const timer = noticeTimers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  noticeTimers.delete(id);
  if (element === null || !element.classList.contains('visible')) return;
  element.classList.remove('visible');
  // display: none only once the fade-out has played
  noticeTimers.set(
    id,
    window.setTimeout(() => {
      noticeTimers.delete(id);
      if (!element.classList.contains('visible')) element.hidden = true;
    }, 400),
  );
}

export function showEpilepsyWarning() {
  showNotice('epilepsy-warning');
}

export function hideEpilepsyWarning() {
  hideNotice('epilepsy-warning');
}

/** No point explaining how to open the player while it's pinned open anyway. */
export function showUiHint() {
  if (panelPinned) return;
  showNotice('ui-hint');
}

export function hideUiHint() {
  hideNotice('ui-hint');
}

const TOAST_GAP_PX = 12;
let toastFollowTimer: number | null = null;

/** Puts the toast next to the player: below everything of it that's showing in the top layouts
 *  (pill, panel, "About", the "hover here" hint), above all of that in the bottom ones — so
 *  it never covers any of it, and moves along when something opens or closes while it's up. */
function positionToast(toast: HTMLElement) {
  const bottomLayout = (document.body.dataset.uiPosition ?? '').startsWith('bottom');
  const parts = ['now-playing-status', 'now-playing-panel', 'about-view', 'ui-hint']
    .map((id) => byId(id))
    .filter((element): element is HTMLElement => {
      if (element === null) return false;
      if (element.id === 'now-playing-status') return true;
      if (element.id === 'ui-hint') return !element.hidden && element.classList.contains('visible');
      return element.classList.contains('expanded') || element.classList.contains('pinned');
    });
  let edge = bottomLayout ? window.innerHeight : 0;
  for (const part of parts) {
    const rect = part.getBoundingClientRect();
    if (rect.height <= 0) continue;
    edge = bottomLayout ? Math.min(edge, rect.top) : Math.max(edge, rect.bottom);
  }
  if (bottomLayout) {
    toast.style.top = 'auto';
    toast.style.bottom = `${String(Math.round(window.innerHeight - edge + TOAST_GAP_PX))}px`;
  } else {
    toast.style.bottom = 'auto';
    toast.style.top = `${String(Math.round(edge + TOAST_GAP_PX))}px`;
  }
}

export function showToast(message: string) {
  const toast = byId('toast');
  if (toast === null) return;
  toast.textContent = message;
  // Placed before it fades in (no sliding in from the old spot), then kept up to date.
  toast.classList.remove('placed');
  positionToast(toast);
  void toast.offsetHeight;
  toast.classList.add('placed', 'visible');
  if (toastFollowTimer !== null) window.clearInterval(toastFollowTimer);
  toastFollowTimer = window.setInterval(() => positionToast(toast), 150);
  if (toastHideTimer !== null) window.clearTimeout(toastHideTimer);
  toastHideTimer = window.setTimeout(() => {
    toast.classList.remove('visible');
    window.setTimeout(() => {
      if (toast.classList.contains('visible') || toastFollowTimer === null) return;
      window.clearInterval(toastFollowTimer);
      toastFollowTimer = null;
    }, 300);
  }, TOAST_VISIBLE_MS);
}

function setExpandActive(active: boolean) {
  const el = byId('now-playing-expand');
  if (el === null) return;
  if (active && panelCollapseTimeout !== null) {
    // A pending "finish fading out, then display:none" from collapsePanel() is about to fire —
    // cancel it, since re-expanding while it's still queued would otherwise still hide the panel
    // right out from under whatever just re-opened it.
    window.clearTimeout(panelCollapseTimeout);
    panelCollapseTimeout = null;
  }
  el.classList.toggle('active', active);
  // Force a reflow right after switching away from display:none, so the opacity/transform
  // transition on the panel/"About" card that follows immediately still animates instead of
  // snapping instantly (browsers otherwise tend to coalesce both style changes into one frame).
  if (active) void el.offsetHeight;
}

/** The "About" card (the link shown in place of the mapper line while nothing plays) — opens below
 *  the panel. */
function openAboutView() {
  closeVersionsView();
  setExpandActive(true);
  byId('now-playing-panel')?.classList.add('expanded');
  const version = byId('about-version-number');
  if (version !== null) version.textContent = APP_VERSION;
  if (aboutCloseTimer !== null) {
    // reopened while still closing
    window.clearTimeout(aboutCloseTimer);
    aboutCloseTimer = null;
    byId('about-view')?.classList.remove('closing');
  }
  // The avatar picture is optional (public/ava.jpg): without it, the initial underneath stays.
  const avatar = byId<HTMLImageElement>('about-avatar-img');
  if (avatar !== null) {
    if (avatar.complete && avatar.naturalWidth === 0) avatar.remove();
    else avatar.addEventListener('error', () => avatar.remove(), { once: true });
  }
  byId('about-view')?.classList.add('expanded');
  byId('now-playing-expand')?.classList.add('about-open');
}

const ABOUT_CLOSE_MS = 180; // matches #about-view.closing's animation in index.html
let aboutCloseTimer: number | null = null;

function closeAboutView() {
  const view = byId('about-view');
  if (view === null || !view.classList.contains('expanded') || view.classList.contains('closing')) return;
  // Played out before it's hidden (display: none would cut the animation off).
  view.classList.add('closing');
  aboutCloseTimer = window.setTimeout(() => {
    aboutCloseTimer = null;
    view.classList.remove('expanded', 'closing');
    byId('now-playing-expand')?.classList.remove('about-open');
  }, ABOUT_CLOSE_MS);
}

// "Other versions" (☰): the maps found of the playing song, best first, each with a pin button.
let versionRows: VersionRow[] | null = null;
let versionsCloseTimer: number | null = null;
const VERSIONS_CLOSE_MS = 180; // matches #versions-view.closing's animation in index.html
const VERSIONS_ROW_STAGGER_MS = 30;

function versionsOpen(): boolean {
  const view = byId('versions-view');
  return view !== null && view.classList.contains('expanded') && !view.classList.contains('closing');
}

/** The list is worth opening when it offers something besides the map already playing. */
function versionsAvailable(rows: VersionRow[] | null): boolean {
  return rows !== null && rows.some((row) => !row.isCurrent);
}

/** The versions of the playing song (null: none — the ☰ button goes away). Re-renders the list
 *  when it's open. */
export function setVersions(rows: VersionRow[] | null) {
  versionRows = rows;
  const available = versionsAvailable(rows);
  const toggle = byId('np-versions-toggle');
  if (toggle !== null) {
    toggle.hidden = !available;
    toggle.title = t('versions_toggle_title');
  }
  if (!available) {
    closeVersionsView();
    return;
  }
  if (versionsOpen()) renderVersions(false);
}

function badge(className: string, text: string, title: string) {
  const element = document.createElement('span');
  element.className = `version-badge ${className}`;
  element.textContent = text;
  element.title = title;
  return element;
}

function renderVersions(animate: boolean) {
  const list = byId('versions-list');
  if (list === null) return;
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  const rows = versionRows ?? [];
  rows.forEach((row, index) => {
    const item = document.createElement('div');
    item.className = 'version-row';
    item.classList.toggle('current', row.isCurrent);
    item.classList.toggle('pinned', row.isPinned);
    item.classList.toggle('dimmed', row.excluded !== null && !row.isPinned && !row.isCurrent);
    item.dataset.hash = row.hash;

    const cover = document.createElement('img');
    cover.className = 'version-cover';
    cover.alt = '';
    cover.onerror = () => {
      cover.onerror = null;
      cover.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'; // transparent pixel
    };
    if (row.coverUrl !== null) cover.src = row.coverUrl;

    const text = document.createElement('div');
    text.className = 'version-text';
    const title = document.createElement('div');
    title.className = 'version-title';
    if (row.isCurrent) {
      const playing = document.createElement('span');
      playing.className = 'version-playing';
      playing.textContent = '▶ ';
      playing.title = t('versions_playing_title');
      title.append(playing);
    }
    title.append(row.title);
    title.title = row.title;
    const meta = document.createElement('div');
    meta.className = 'version-meta';
    const parts = [row.mapper !== '' ? t('track_mapper_by', { mapper: row.mapper }) : '', row.duration !== null ? formatTime(row.duration) : ''];
    meta.textContent = parts.filter((part) => part !== '').join(' · ');
    text.append(title, meta);

    const badges: HTMLElement[] = [];
    if (row.isCompleted) badges.push(badge('version-badge-done', t('versions_badge_completed'), t('versions_badge_completed_title')));
    if (!row.environmentSupported || row.excluded === 'unsupported') {
      badges.push(badge('version-badge-warn', t('row_badge_unsupported_text'), t('row_badge_unsupported_title')));
    }
    if (row.mightUseGLS) badges.push(badge('version-badge-gls', t('row_badge_gls_text'), t('row_badge_gls_title')));
    if (row.usesChroma) badges.push(badge('version-badge-good', t('row_badge_chroma_text'), t('row_badge_chroma_title')));
    if (row.usesNoodleExtensions) badges.push(badge('version-badge-noodle', t('row_badge_noodle_text'), t('row_badge_noodle_title')));
    if (row.excluded === 'rich') badges.push(badge('version-badge-skip', t('row_badge_skip_text'), t('row_badge_skip_title')));
    if (row.differentEdit) badges.push(badge('version-badge-skip', t('versions_badge_other_edit'), t('versions_badge_other_edit_title')));
    if (badges.length > 0) {
      const line = document.createElement('div');
      line.className = 'version-badges';
      line.append(...badges);
      text.append(line);
    }

    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'version-pin';
    pin.classList.toggle('active', row.isPinned);
    pin.dataset.action = 'pin';
    pin.textContent = row.isPinned ? t('versions_pinned_button') : t('versions_pin_button');
    pin.title = row.isPinned ? t('versions_unpin_title') : t('versions_pin_title');

    item.append(cover, text, pin);
    if (animate) {
      item.classList.add('version-row-in');
      item.style.animationDelay = `${String(Math.min(index, 10) * VERSIONS_ROW_STAGGER_MS)}ms`;
    }
    list.appendChild(item);
  });
  list.scrollTop = scrollTop;
  updateVersionsScrollButtons();
}

/** ▲/▼ only when the list doesn't fit (Wallpaper Engine passes no mouse wheel to wallpapers). */
function updateVersionsScrollButtons() {
  const list = byId('versions-list');
  if (list === null) return;
  const overflowing = list.scrollHeight > list.clientHeight + 2;
  const up = byId('versions-scroll-up');
  const down = byId('versions-scroll-down');
  if (up !== null) up.hidden = !overflowing;
  if (down !== null) down.hidden = !overflowing;
}

function openVersionsView() {
  if (!versionsAvailable(versionRows)) return;
  closeAboutView();
  setExpandActive(true);
  byId('now-playing-panel')?.classList.add('expanded');
  const view = byId('versions-view');
  if (view === null) return;
  if (versionsCloseTimer !== null) {
    window.clearTimeout(versionsCloseTimer);
    versionsCloseTimer = null;
    view.classList.remove('closing');
  }
  view.classList.add('expanded');
  byId('now-playing-expand')?.classList.add('versions-open');
  byId('np-versions-toggle')?.classList.add('active');
  renderVersions(true);
  const list = byId('versions-list');
  if (list !== null) list.scrollTop = 0;
  // (Measured once laid out.)
  window.requestAnimationFrame(updateVersionsScrollButtons);
}

function closeVersionsView() {
  byId('np-versions-toggle')?.classList.remove('active');
  const view = byId('versions-view');
  if (view === null || !view.classList.contains('expanded') || view.classList.contains('closing')) return;
  view.classList.add('closing');
  versionsCloseTimer = window.setTimeout(() => {
    versionsCloseTimer = null;
    view.classList.remove('expanded', 'closing');
    byId('now-playing-expand')?.classList.remove('versions-open');
  }, VERSIONS_CLOSE_MS);
}

/** force=true always collapses, even while pinned (used when there's genuinely nothing to show). */
function collapsePanel(force = false) {
  if (panelPinned && !force) return;
  byId('now-playing-panel')?.classList.remove('expanded');
  closeAboutView();
  closeVersionsView();
  if (panelIdleTimer !== null) {
    window.clearTimeout(panelIdleTimer);
    panelIdleTimer = null;
  }
  // #now-playing-panel's own fade-out (opacity/transform, see index.html) needs display:flex to
  // still be in effect on the wrapper while it plays — switching the wrapper straight to
  // display:none in the same frame (which is what setExpandActive(false) does) cuts the animation
  // off before a single frame of it can render, so it was never actually visible despite being
  // there in CSS the whole time. Deferring the display:none until the transition has had time to
  // finish is what actually lets it play.
  if (panelCollapseTimeout !== null) window.clearTimeout(panelCollapseTimeout);
  panelCollapseTimeout = window.setTimeout(() => {
    setExpandActive(false);
    panelCollapseTimeout = null;
  }, PANEL_COLLAPSE_TRANSITION_MS);
}

function resetPanelIdleTimer() {
  if (panelPinned) return;
  if (panelIdleTimer !== null) window.clearTimeout(panelIdleTimer);
  panelIdleTimer = window.setTimeout(() => collapsePanel(), PANEL_IDLE_HIDE_MS);
}

function applyStatusPinned() {
  const pill = byId('now-playing-pill');
  pill?.classList.toggle('pinned', statusPinned);
  byId('np-pin-status')?.classList.toggle('active', statusPinned);
  if (pillHideTimer !== null) {
    window.clearTimeout(pillHideTimer);
    pillHideTimer = null;
  }
  if (statusPinned) {
    pill?.classList.add('visible');
  } else if ((lastPhase === 'playing' || lastPhase === 'idle') && pill !== null) {
    // Un-pinning resumes the normal auto-hide countdown instead of leaving it stuck visible
    // forever (that was the bug: nothing else re-arms this timer until the next track starts).
    pillHideTimer = window.setTimeout(() => pill.classList.remove('visible'), PILL_AUTO_HIDE_MS);
  }
}

function applyPanelPinned() {
  const panel = byId('now-playing-panel');
  panel?.classList.toggle('pinned', panelPinned);
  byId('now-playing-expand')?.classList.toggle('pinned', panelPinned);
  byId('np-pin-panel')?.classList.toggle('active', panelPinned);
  if (panelPinned) {
    hideUiHint();
    setExpandActive(true);
    panel?.classList.add('expanded');
    if (panelIdleTimer !== null) {
      window.clearTimeout(panelIdleTimer);
      panelIdleTimer = null;
    }
  }
}

/** Also callable from outside (a Wallpaper Engine property, duplicating the in-page 📌 button) —
 *  both end up going through the same state + DOM update, so they can never disagree with each
 *  other. Note this is necessarily one-directional: if you pin/unpin from the in-page button, the
 *  WE checkbox itself has no way to reflect that back. */
export function setPanelPinned(pinned: boolean) {
  if (panelPinned === pinned) return;
  panelPinned = pinned;
  applyPanelPinned();
}

/** See setPanelPinned — same idea, for the 👁 "always show status" pin. */
export function setStatusPinned(pinned: boolean) {
  if (statusPinned === pinned) return;
  statusPinned = pinned;
  applyStatusPinned();
}

/** Wires up hover-to-expand, inactivity auto-hide and all the buttons. Call once. */
export function initNowPlayingControls(handlers: NowPlayingHandlers) {
  const wrapper = byId('now-playing');
  const panel = byId('now-playing-panel');
  if (wrapper === null || panel === null) return;

  // Keeps the cover square regardless of how tall the text/controls column ends up being (it can
  // vary — the "unsupported environment" badge, longer titles, etc): a fixed pixel width alone
  // (like before) drifted out of square whenever the panel got taller than that width, which
  // looked like the cover was being cropped. Measuring the actual rendered height and mirroring
  // it onto the cover's width is simple, robust, and needs no fragile CSS (aspect-ratio + auto
  // resolution from a stretched cross size is exactly what broke last time).
  const coverWrap = byId('np-cover-wrap');
  if (coverWrap !== null && typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(() => {
      coverWrap.style.width = `${String(panel.clientHeight)}px`;
    });
    resizeObserver.observe(panel);
  }

  // The panel grows and shrinks smoothly when its content changes (a map with more or fewer
  // badges, the time/progress rows appearing): its height is set explicitly to
  // what the content needs, and CSS transitions between the values. The cover follows along
  // through the observer above, so it stays square the whole way.
  const body = byId('np-body');
  const info = byId('np-info');
  const controls = byId('np-controls');
  if (body !== null && info !== null && controls !== null && typeof ResizeObserver !== 'undefined') {
    const syncPanelHeight = () => {
      // Collapsed (display: none somewhere up the tree): nothing to measure — keep the last value,
      // and animate from it on the next expand.
      if (info.offsetHeight === 0 && controls.offsetHeight === 0) return;
      const style = getComputedStyle(body);
      const target =
        info.offsetHeight +
        controls.offsetHeight +
        (Number.parseFloat(style.rowGap) || 0) +
        (Number.parseFloat(style.paddingTop) || 0) +
        (Number.parseFloat(style.paddingBottom) || 0);
      const height = `${String(Math.ceil(target))}px`;
      if (panel.style.height !== height) panel.style.height = height;
    };
    const contentObserver = new ResizeObserver(syncPanelHeight);
    contentObserver.observe(info);
    contentObserver.observe(controls);
  }

  byId('np-mapper')?.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.target.closest('.np-about-link') === null) return;
    resetPanelIdleTimer();
    const about = byId('about-view');
    if (about?.classList.contains('expanded') === true && !about.classList.contains('closing')) closeAboutView();
    else openAboutView();
  });
  byId('about-close')?.addEventListener('click', () => {
    resetPanelIdleTimer();
    closeAboutView();
  });
  // The card's links: a wallpaper can't open a browser, so they're copied to the clipboard.
  byId('about-view')?.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLElement>('.about-link');
    const url = link?.dataset.url;
    if (url === undefined) return;
    resetPanelIdleTimer();
    void copyTextToClipboard(url).then((copied) => {
      showToast(copied ? t('about_link_copied', { url: url.replace(/^https?:\/\//, '') }) : t('link_copy_failed'));
    });
  });

  wrapper.addEventListener('mouseenter', () => {
    // No "only if something's actually playing" gate: with nothing playing the panel shows the
    // wallpaper's own name, version and the "About" link (see setTrack(null)).
    if (panelLeaveGraceTimeout !== null) {
      window.clearTimeout(panelLeaveGraceTimeout);
      panelLeaveGraceTimeout = null;
    }
    setExpandActive(true);
    panel.classList.add('expanded');
    resetPanelIdleTimer();
    hideUiHint(); // found it
  });
  wrapper.addEventListener('mousemove', () => {
    if (panel.classList.contains('expanded')) resetPanelIdleTimer();
  });
  wrapper.addEventListener('mouseleave', () => {
    if (panelLeaveGraceTimeout !== null) window.clearTimeout(panelLeaveGraceTimeout);
    panelLeaveGraceTimeout = window.setTimeout(() => {
      panelLeaveGraceTimeout = null;
      collapsePanel();
    }, PANEL_LEAVE_GRACE_MS);
  });

  byId('np-random-env')?.addEventListener('click', () => {
    resetPanelIdleTimer();
    handlers.onRandomEnvironment();
  });
  byId('np-exit-sync')?.addEventListener('click', () => {
    resetPanelIdleTimer();
    handlers.onExitSync();
  });

  byId('np-pin-panel')?.addEventListener('click', () => {
    setPanelPinned(!panelPinned);
  });
  byId('np-pin-status')?.addEventListener('click', () => {
    resetPanelIdleTimer();
    setStatusPinned(!statusPinned);
  });

  byId('np-versions-toggle')?.addEventListener('click', () => {
    resetPanelIdleTimer();
    if (versionsOpen()) closeVersionsView();
    else openVersionsView();
  });
  byId('versions-close')?.addEventListener('click', () => {
    resetPanelIdleTimer();
    closeVersionsView();
  });
  const versionsList = byId('versions-list');
  versionsList?.addEventListener('click', (event) => {
    resetPanelIdleTimer();
    if (!(event.target instanceof Element)) return;
    const hash = event.target.closest<HTMLElement>('.version-row')?.dataset.hash;
    const row = versionRows?.find((candidate) => candidate.hash === hash);
    if (hash === undefined || row === undefined) return;
    const onButton = event.target.closest('[data-action="pin"]') !== null;
    if (onButton && row.isPinned) handlers.onUnpinVersion(hash);
    else if (!(row.isPinned && row.isCurrent)) handlers.onChooseVersion(hash);
  });
  if (versionsList !== null) {
    // Wallpaper Engine passes no mouse wheel or drag to wallpapers: ▲/▼ scroll the list, and so
    // does holding the cursor near its top/bottom edge (where plain mouse moves get through).
    const scrollByPage = (direction: 1 | -1) => {
      resetPanelIdleTimer();
      versionsList.scrollTop += direction * versionsList.clientHeight * 0.8;
    };
    byId('versions-scroll-up')?.addEventListener('click', () => scrollByPage(-1));
    byId('versions-scroll-down')?.addEventListener('click', () => scrollByPage(1));
    const EDGE_ZONE_PX = 24;
    const SCROLL_STEP_PX = 5;
    let hoverDirection = 0;
    let hoverTimer: number | null = null;
    const stopEdgeScroll = () => {
      hoverDirection = 0;
      if (hoverTimer !== null) {
        window.clearInterval(hoverTimer);
        hoverTimer = null;
      }
    };
    versionsList.addEventListener('mousemove', (event) => {
      const rect = versionsList.getBoundingClientRect();
      const y = event.clientY - rect.top;
      hoverDirection = y < EDGE_ZONE_PX ? -1 : y > rect.height - EDGE_ZONE_PX ? 1 : 0;
      if (hoverDirection === 0) {
        stopEdgeScroll();
        return;
      }
      hoverTimer ??= window.setInterval(() => {
        versionsList.scrollTop += hoverDirection * SCROLL_STEP_PX;
        resetPanelIdleTimer(); // holding still to scroll counts as activity
      }, 16);
    });
    versionsList.addEventListener('mouseleave', stopEdgeScroll);
  }

  // "View map": a wallpaper can't open a browser, so the map's BeatSaver link is copied instead.
  byId('np-map-link')?.addEventListener('click', () => {
    resetPanelIdleTimer();
    if (currentMapId === null) return;
    void copyTextToClipboard(`https://beatsaver.com/maps/${currentMapId}`).then((copied) => {
      showToast(copied ? t('link_copied') : t('link_copy_failed'));
    });
  });
}
