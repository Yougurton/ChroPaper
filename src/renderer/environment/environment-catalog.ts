export interface EnvironmentCatalogEntry {
  id: string;
  title: string;
}

export const environmentCatalog: readonly EnvironmentCatalogEntry[] = [
  { id: 'DefaultEnvironment', title: 'The First' },
  { id: 'OriginsEnvironment', title: 'Origins' },
  { id: 'TriangleEnvironment', title: 'Triangle' },
  { id: 'NiceEnvironment', title: 'Nice' },
  { id: 'BigMirrorEnvironment', title: 'Big Mirror' },
  { id: 'DragonsEnvironment', title: 'Dragons' },
  { id: 'KDAEnvironment', title: 'KDA' },
  { id: 'MonstercatEnvironment', title: 'Monstercat' },
  { id: 'CrabRaveEnvironment', title: 'Crab Rave' },
  { id: 'PanicEnvironment', title: 'Panic' },
  { id: 'RocketEnvironment', title: 'Rocket' },
  { id: 'GreenDayGrenadeEnvironment', title: 'Green Day Grenade' },
  { id: 'GreenDayEnvironment', title: 'Green Day' },
  { id: 'TimbalandEnvironment', title: 'Timbaland' },
  { id: 'FitBeatEnvironment', title: 'Fit Beat' },
  { id: 'LinkinParkEnvironment', title: 'Linkin Park' },
  { id: 'GlassDesertEnvironment', title: 'Glass Desert' },
  { id: 'BTSEnvironment', title: 'BTS' },
  { id: 'KaleidoscopeEnvironment', title: 'Kaleidoscope' },
  { id: 'InterscopeEnvironment', title: 'Interscope' },
  { id: 'GagaEnvironment', title: 'Gaga' },
  { id: 'SkrillexEnvironment', title: 'Skrillex' },
  { id: 'HalloweenEnvironment', title: 'Spooky' },
  { id: 'WeaveEnvironment', title: 'Weave' },
  { id: 'EDMEnvironment', title: 'EDM' },
  { id: 'TheSecondEnvironment', title: 'The Second' },
  { id: 'LizzoEnvironment', title: 'Lizzo' },
  { id: 'TheWeekndEnvironment', title: 'The Weeknd' },
  { id: 'Dragons2Environment', title: 'Dragons 2.0' },
  { id: 'LatticeEnvironment', title: 'Lattice' },
  { id: 'DaftPunkEnvironment', title: 'Daft Punk' },
  { id: 'HipHopEnvironment', title: 'Hip Hop Mixtape' },
  { id: 'ColliderEnvironment', title: 'Collider' },
  { id: 'GridEnvironment', title: 'Cube' },
];

const environmentIds = new Set([...environmentCatalog.map(({ id }) => id), 'BillieEnvironment']);

export function resolveEnvironmentId(id: string) {
  return environmentIds.has(id) ? id : 'DefaultEnvironment';
}

/** Whether this exact environment id is one ChroViewer actually has assets/data for. */
export function isKnownEnvironmentId(id: string): boolean {
  return environmentIds.has(id);
}

// Environments that support the v3 "Group Lighting System" (GLS) — introduced with the Weave
// environment (OST5) — versus the older Static Event System used by every environment before it.
// Sourced from the "Group Lighting System" table at https://bsmg.wiki/mapping/basic-lighting.html
// (as opposed to that page's separate "Pre-Group Lighting System" table). Only the entries that
// are also in `environmentCatalog` above are listed — ChroViewer doesn't have data for every GLS
// environment BeatGames has since released (e.g. Metallica, Queen, Britney, Coldplay aren't here
// yet), so this list will need a new entry whenever ChroViewer itself gains support for one.
const glsCapableEnvironmentIds = new Set([
  'WeaveEnvironment',
  'EDMEnvironment',
  'TheSecondEnvironment',
  'LizzoEnvironment',
  'TheWeekndEnvironment',
  'Dragons2Environment',
  'LatticeEnvironment',
  'DaftPunkEnvironment',
  'HipHopEnvironment',
  'ColliderEnvironment',
  'GridEnvironment',
]);

/** Whether this environment *can* use the v3 Group Lighting System — a necessary but not
 *  sufficient condition for a specific map to actually use it (the mapper still has to use those
 *  tools). Cheap and doesn't require downloading the map, unlike checking the parsed difficulty
 *  data directly — see hasGroupLightingSystemEvents in wallpaper/main.ts for the accurate check. */
export function isGLSCapableEnvironment(id: string): boolean {
  return glsCapableEnvironmentIds.has(id);
}
