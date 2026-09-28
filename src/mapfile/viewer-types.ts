import type { InfoColorScheme, InfoDifficulty } from '../core/beatmap/info';
import type { Difficulty } from '../core/beatmap/types';
import type { MapRenderData } from '../core/placement/map-render-data';
import type { ConfigurableViewerSource } from '../sources/source-types';

export interface MapMeta {
  title: string;
  subtitle: string;
  author: string;
  mapper: string;
  /** See MapInfo.songTimeOffset in core/beatmap/info.ts — 0 for anything but older v2 maps. */
  songTimeOffset: number;
}

export interface DifficultyRow {
  key: string;
  label: string;
  difficulty?: Difficulty;
  infoDifficulty?: InfoDifficulty;
  environmentId?: string;
  /** False when the map's declared environment isn't one ChroViewer has data for (silently
   *  falls back to the default environment when actually rendered), or when the map requires
   *  the Vivify mod (custom shaders ChroViewer doesn't run). */
  environmentSupported?: boolean;
  replayEnvironmentId?: string;
  colorScheme?: InfoColorScheme;
  replayMatch?: boolean;
  legacyNoodleV2Semantics?: boolean;
}

export interface MapIdentity {
  key: string;
  hash: string;
}

export interface ViewerSourceLink {
  type: 'map' | 'replay';
  url: string;
}

export interface ActiveSelection {
  data: MapRenderData;
  environmentId: string;
  mapEnvironmentId: string;
  replayEnvironmentId?: string;
  usesChromaOrNoodle: boolean;
  mapColorScheme?: InfoColorScheme;
}

export type ViewerPanel = 'about' | 'share' | 'speed' | 'lights' | 'camera' | 'volume' | null;

export type ViewerSource = ConfigurableViewerSource | 'link';
