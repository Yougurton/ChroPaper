/** Default cap; the "FPS limit" setting changes it (setMaxRenderFrameRate). */
export const MAX_RENDER_FRAME_RATE = 120;

const DEADLINE_TOLERANCE_MS = 0.5;

/** 0 = no cap: render on every animation frame the browser gives us. */
let frameIntervalMs = 1000 / MAX_RENDER_FRAME_RATE;

/** The "FPS limit" setting: frames per second, or null for no limit. */
export function setMaxRenderFrameRate(fps: number | null) {
  frameIntervalMs = fps === null || !Number.isFinite(fps) || fps <= 0 ? 0 : 1000 / fps;
}

export function nextRenderDeadline(timestamp: number, deadline: number): number | null {
  if (frameIntervalMs === 0) return timestamp;
  if (timestamp + DEADLINE_TOLERANCE_MS < deadline) return null;
  const next = deadline + frameIntervalMs;
  return timestamp - next >= frameIntervalMs ? timestamp + frameIntervalMs : next;
}
