import type { Rgb } from '../core/colors';
import type { MirrorQuality } from '../renderer/quality';

export interface WallpaperControls {
  cameraFov: number;
  cameraDistance: number;
  mirrorQuality: MirrorQuality;
  screenDisplacement: boolean;
  showPlayerPlatform: boolean;
  showWalls: boolean;
  renderScale: number;
  parallaxEnabled: boolean;
  parallaxIntensity: number;
  parallaxInvertX: boolean;
  parallaxInvertY: boolean;
  parallaxJelly: number;
  listenEnvironment: string;
}

export const DEFAULT_WALLPAPER_CONTROLS: WallpaperControls = {
  cameraFov: 70,
  cameraDistance: 4,
  mirrorQuality: 'medium',
  screenDisplacement: true,
  // Off by default: with no actual player standing on it, the platform reads as an odd floating
  // slab in a wallpaper rather than something meaningful — the Wallpaper Engine checkbox (see
  // project.json's show_player_platform) is there for anyone who wants it back.
  showPlayerPlatform: false,
  // Off by default too, but for a different reason than the platform above: walls are real
  // gameplay obstacles for most maps, and flying them at the camera in a passive wallpaper just
  // reads as visual noise. The one exception — maps that require Noodle Extensions, where walls
  // are frequently used as decorative/animated scenery rather than obstacles to dodge — is handled
  // separately in main.ts's applyShowWalls, which shows them regardless of this setting for those.
  showWalls: false,
  renderScale: 1,
  parallaxEnabled: false,
  parallaxIntensity: 0.3,
  parallaxInvertX: false,
  parallaxInvertY: false,
  parallaxJelly: 0,
  listenEnvironment: 'BigMirrorEnvironment',
};

interface WallpaperProperty {
  value: string | number | boolean;
}

// Matches Wallpaper Engine's window.wallpaperPropertyListener contract. Declared locally instead
// of augmenting the global Window type, since this only exists at runtime inside Wallpaper Engine.
interface WallpaperPropertyListener {
  applyUserProperties?: (properties: WallpaperProperties) => void;
  /** Called with true when Wallpaper Engine pauses the wallpaper (a fullscreen app, the "pause"
   *  playback rule), false when it resumes. */
  setPaused?: (paused: boolean) => void;
}

export type WallpaperProperties = Record<string, WallpaperProperty>;

// Everything Wallpaper Engine sent before listenForWallpaperControls took over (merged, latest
// value per property) — applied by it on registration so nothing sent early gets lost.
let earlyProperties: WallpaperProperties | null = null;

/**
 * Wallpaper Engine sends every property once, right after the page loads. Waiting for that first
 * batch (briefly — outside Wallpaper Engine it never comes) before building the renderer lets it
 * start with the user's real settings: before, the renderer was built with the defaults, and a
 * non-default mirror quality then tore it down and rebuilt it while the first environment was
 * still loading (twice the startup work, plus "load was cancelled" errors in the log).
 */
export function waitForInitialProperties(timeoutMs: number): Promise<WallpaperProperties | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(earlyProperties), timeoutMs);
    window.wallpaperPropertyListener = {
      applyUserProperties: (properties) => {
        earlyProperties = { ...earlyProperties, ...properties };
        window.clearTimeout(timer);
        resolve(earlyProperties);
      },
    };
  });
}

declare global {
  interface Window {
    wallpaperPropertyListener?: WallpaperPropertyListener;
  }
}

export interface WallpaperControlsHandlers {
  onCameraChange: (fov: number, distance: number) => void;
  onMirrorQualityChange: (quality: MirrorQuality) => void;
  onScreenDisplacementChange: (enabled: boolean) => void;
  onShowPlayerPlatformChange: (enabled: boolean) => void;
  onShowWallsChange: (enabled: boolean) => void;
  onRenderScaleChange: (scale: number) => void;
  /** "Map cache size" (the "Misc" section), in megabytes. */
  onCacheSizeChange: (megabytes: number) => void;
  onUiPositionChange: (position: string) => void;
  onPinPanelChange: (pinned: boolean) => void;
  onPinStatusChange: (pinned: boolean) => void;
  onParallaxEnabledChange: (enabled: boolean) => void;
  onParallaxIntensityChange: (intensity: number) => void;
  onParallaxInvertXChange: (inverted: boolean) => void;
  onParallaxInvertYChange: (inverted: boolean) => void;
  onParallaxJellyChange: (amount: number) => void;
  onListenEnvironmentChange: (environmentId: string) => void;
  onListenRandomEnvironmentChange: (enabled: boolean) => void;
  /** "Light colors": the environment's/map's own, random ones on each track change, or the
   *  user's two colors — always given together (Wallpaper Engine only sends what changed). */
  onListenColorsChange: (colors: ListenColors) => void;
  /** Whether those colors also replace a synced map's own (maps without Chroma or V3 lighting). */
  onListenColorsSyncedChange: (enabled: boolean) => void;
  onListenSyncEnabledChange: (enabled: boolean) => void;
  onListenSyncOffsetChange: (offsetSeconds: number) => void;
  /** Whether sync may pick maps with V3 lighting or Noodle Extensions (heavier to render). */
  onListenSyncRichMapsChange: (enabled: boolean) => void;
  onLanguageChange: (language: 'auto' | 'ru' | 'en') => void;
  onPausedChange?: (paused: boolean) => void;
  onShowEpilepsyWarningChange: (enabled: boolean) => void;
  onShowUiHintChange: (enabled: boolean) => void;
  /** "FPS counter" (the "Misc" section). */
  onShowFpsChange: (enabled: boolean) => void;
  /** "FPS limit" (the "Misc" section, a 30–240 slider): frames per second. */
  onFpsLimitChange: (fps: number | null) => void;
}

export interface ListenColors {
  mode: 'default' | 'random' | 'custom';
  left: Rgb;
  right: Rgb;
}

/** Matches project.json's listen_color_left/right defaults. */
export const DEFAULT_LISTEN_COLORS: ListenColors = {
  mode: 'default',
  left: [0.7843, 0.0784, 0.0784],
  right: [0.1569, 0.5569, 0.8235],
};

/** A Wallpaper Engine color property ("r g b", each 0-1). */
function parseWallpaperColor(value: string): Rgb | null {
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
  const clamp = (part: number) => Math.min(1, Math.max(0, part));
  return [clamp(parts[0] ?? 0), clamp(parts[1] ?? 0), clamp(parts[2] ?? 0)];
}

/**
 * Wires up window.wallpaperPropertyListener so the properties defined in project.json (camera,
 * screensaver, sync, etc.) can control the running wallpaper. Outside of Wallpaper Engine (plain
 * browser preview) this simply never fires and the defaults apply.
 */
export function listenForWallpaperControls(handlers: WallpaperControlsHandlers) {
  // Wallpaper Engine only includes whatever property actually changed in a given
  // applyUserProperties call, not a full snapshot of every property — so dragging the FOV slider
  // fires a call whose `properties` has camera_fov but no camera_distance at all, and vice versa.
  // onCameraChange needs both at once, though, so falling back to a fixed default for whichever one
  // is missing from *this* call (as this used to) meant dragging either slider silently reset the
  // other back to its default. These remember whichever value was last actually seen for each of
  // the pair, so a call reporting only one of them reuses the other's last known value instead of
  // clobbering it.
  let lastCameraFov = DEFAULT_WALLPAPER_CONTROLS.cameraFov;
  let lastCameraDistance = DEFAULT_WALLPAPER_CONTROLS.cameraDistance;
  let lastListenColors: ListenColors = DEFAULT_LISTEN_COLORS;
  const listener: WallpaperPropertyListener = {
    setPaused(paused) {
      handlers.onPausedChange?.(paused);
    },
    applyUserProperties(properties) {
      const fovProperty = properties.camera_fov;
      const distanceProperty = properties.camera_distance;
      if (typeof fovProperty?.value === 'number') lastCameraFov = fovProperty.value;
      if (typeof distanceProperty?.value === 'number') lastCameraDistance = distanceProperty.value;
      if (typeof fovProperty?.value === 'number' || typeof distanceProperty?.value === 'number') {
        handlers.onCameraChange(lastCameraFov, lastCameraDistance);
      }

      const mirrorQuality = properties.mirror_quality;
      if (
        mirrorQuality !== undefined &&
        (mirrorQuality.value === 'none' ||
          mirrorQuality.value === 'low' ||
          mirrorQuality.value === 'medium' ||
          mirrorQuality.value === 'high')
      ) {
        handlers.onMirrorQualityChange(mirrorQuality.value);
      }

      const screenDisplacement = properties.screen_displacement;
      if (typeof screenDisplacement?.value === 'boolean') {
        handlers.onScreenDisplacementChange(screenDisplacement.value);
      }

      const showPlayerPlatform = properties.show_player_platform;
      if (typeof showPlayerPlatform?.value === 'boolean') {
        handlers.onShowPlayerPlatformChange(showPlayerPlatform.value);
      }

      const showWalls = properties.show_walls;
      if (typeof showWalls?.value === 'boolean') {
        handlers.onShowWallsChange(showWalls.value);
      }

      const renderScalePercent = properties.render_scale;
      if (typeof renderScalePercent?.value === 'number') {
        handlers.onRenderScaleChange(renderScalePercent.value / 100);
      }

      const cacheSize = properties.cache_size;
      if (typeof cacheSize?.value === 'number') handlers.onCacheSizeChange(cacheSize.value);

      const uiPosition = properties.ui_position;
      if (
        uiPosition !== undefined &&
        (uiPosition.value === 'top-left' ||
          uiPosition.value === 'top-center' ||
          uiPosition.value === 'top-right' ||
          uiPosition.value === 'bottom-left' ||
          uiPosition.value === 'bottom-center' ||
          uiPosition.value === 'bottom-right')
      ) {
        handlers.onUiPositionChange(uiPosition.value);
      }

      const pinPanelProperty = properties.pin_panel;
      if (typeof pinPanelProperty?.value === 'boolean') {
        handlers.onPinPanelChange(pinPanelProperty.value);
      }

      const showEpilepsyWarning = properties.show_epilepsy_warning;
      if (typeof showEpilepsyWarning?.value === 'boolean') handlers.onShowEpilepsyWarningChange(showEpilepsyWarning.value);

      const showUiHint = properties.show_ui_hint;
      if (typeof showUiHint?.value === 'boolean') handlers.onShowUiHintChange(showUiHint.value);

      const showFps = properties.show_fps;
      if (typeof showFps?.value === 'boolean') handlers.onShowFpsChange(showFps.value);

      const fpsLimit = properties.fps_limit;
      if (fpsLimit !== undefined) {
        const fps = Number(fpsLimit.value);
        // (0 = "unlimited" from the earlier dropdown version of this setting → the slider's maximum)
        if (Number.isFinite(fps)) handlers.onFpsLimitChange(fps > 0 ? Math.min(Math.max(fps, 30), 240) : 240);
      }

      const pinStatusProperty = properties.pin_status;
      if (typeof pinStatusProperty?.value === 'boolean') {
        handlers.onPinStatusChange(pinStatusProperty.value);
      }

      const parallaxEnabled = properties.parallax_enabled;
      if (typeof parallaxEnabled?.value === 'boolean') {
        handlers.onParallaxEnabledChange(parallaxEnabled.value);
      }

      const parallaxIntensity = properties.parallax_intensity;
      if (typeof parallaxIntensity?.value === 'number') {
        handlers.onParallaxIntensityChange(parallaxIntensity.value / 100);
      }

      const parallaxInvertX = properties.parallax_invert_x;
      if (typeof parallaxInvertX?.value === 'boolean') {
        handlers.onParallaxInvertXChange(parallaxInvertX.value);
      }

      const parallaxInvertY = properties.parallax_invert_y;
      if (typeof parallaxInvertY?.value === 'boolean') {
        handlers.onParallaxInvertYChange(parallaxInvertY.value);
      }

      const parallaxJelly = properties.parallax_jelly;
      if (typeof parallaxJelly?.value === 'number') {
        handlers.onParallaxJellyChange(parallaxJelly.value / 100);
      }

      const listenEnvironment = properties.listen_environment;
      if (typeof listenEnvironment?.value === 'string' && listenEnvironment.value !== '') {
        handlers.onListenEnvironmentChange(listenEnvironment.value);
      }

      const listenRandomEnvironment = properties.listen_random_environment;
      if (typeof listenRandomEnvironment?.value === 'boolean') {
        handlers.onListenRandomEnvironmentChange(listenRandomEnvironment.value);
      }

      const colorsMode = properties.listen_colors;
      const colorLeft = properties.listen_color_left;
      const colorRight = properties.listen_color_right;
      let colorsChanged = false;
      if (colorsMode?.value === 'default' || colorsMode?.value === 'random' || colorsMode?.value === 'custom') {
        lastListenColors = { ...lastListenColors, mode: colorsMode.value };
        colorsChanged = true;
      }
      const left = typeof colorLeft?.value === 'string' ? parseWallpaperColor(colorLeft.value) : null;
      if (left !== null) {
        lastListenColors = { ...lastListenColors, left };
        colorsChanged = true;
      }
      const right = typeof colorRight?.value === 'string' ? parseWallpaperColor(colorRight.value) : null;
      if (right !== null) {
        lastListenColors = { ...lastListenColors, right };
        colorsChanged = true;
      }
      if (colorsChanged) handlers.onListenColorsChange(lastListenColors);
      const colorsSynced = properties.listen_colors_synced;
      if (typeof colorsSynced?.value === 'boolean') handlers.onListenColorsSyncedChange(colorsSynced.value);

      const listenSyncEnabled = properties.listen_sync_enabled;
      if (typeof listenSyncEnabled?.value === 'boolean') handlers.onListenSyncEnabledChange(listenSyncEnabled.value);

      const listenSyncOffset = properties.listen_sync_offset;
      if (typeof listenSyncOffset?.value === 'number') handlers.onListenSyncOffsetChange(listenSyncOffset.value / 10);

      const listenSyncRichMaps = properties.listen_sync_rich_maps;
      if (typeof listenSyncRichMaps?.value === 'boolean') handlers.onListenSyncRichMapsChange(listenSyncRichMaps.value);

      const uiLanguage = properties.ui_language;
      if (uiLanguage?.value === 'auto' || uiLanguage?.value === 'ru' || uiLanguage?.value === 'en') {
        handlers.onLanguageChange(uiLanguage.value);
      }
    },
  };
  window.wallpaperPropertyListener = listener;
  const early = earlyProperties;
  earlyProperties = null;
  if (early !== null) listener.applyUserProperties?.(early);
}
