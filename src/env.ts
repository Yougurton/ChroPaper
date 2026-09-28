// The original ChroViewer env.ts wires up @t3-oss/env-core validation for every source
// (BeatSaver/ScoreSaber/BeatLeader/Ludus) plus the "enabled sources" setting. The wallpaper only
// ever talks to BeatSaver, so this is a deliberately tiny stand-in exposing just that one URL,
// which is all sources/beatsaver/provider.ts actually reads.
export const env = {
  VITE_BEATSAVER_API_URL: 'https://api.beatsaver.com',
};
