/**
 * The wallpaper's own "[wallpaper] …" console lines, also kept in localStorage (the last
 * MAX_LINES, key chropaper.debugLog) — Wallpaper Engine shows no console by default, and this way a
 * sync problem can still be looked into afterwards from the browser profile.
 */
const STORAGE_KEY = 'chropaper.debugLog';
const MAX_LINES = 800;
const FLUSH_INTERVAL_MS = 3000;

export function installDebugLog() {
  let lines: string[] = [];
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(saved)) lines = saved.filter((line): line is string => typeof line === 'string');
  } catch {
    // unreadable — start over
  }
  lines.push(`${new Date().toISOString()} ---- wallpaper started`);
  let dirty = true;
  const record = (level: string, args: unknown[]) => {
    const first = args[0];
    if (typeof first !== 'string' || !first.startsWith('[wallpaper]')) return;
    const text = args
      .map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
      .join(' ');
    lines.push(`${new Date().toISOString().slice(11, 23)} ${level} ${text.slice(0, 400)}`);
    if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
    dirty = true;
  };
  for (const level of ['log', 'debug', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      record(level, args);
      original(...args);
    };
  }
  window.setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // storage full or unavailable
    }
  }, FLUSH_INTERVAL_MS);
}
