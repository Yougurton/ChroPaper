import type { SpawnState } from '../spawn/variable-njs';
import { Z_OFFSET } from './grid';

const leadInSeconds = 0.5;
const leadInDistance = 100;
const wallTailGraceSeconds = 0.15;
const jumpRetreatDistance = 500;

export interface ObjectMotion {
  beat: number;
  enterBeat: number;
  spawnBeat: number;
  despawnBeat: number;
  hjdBeats: number;
  unitsPerBeat: number;
  leadInBeats: number;
  movementEndBeat: number;
  spawnAnchorBeat: number;
  usesGlobalNjs: boolean;
}

export function preJumpTravelBeats(songBpm: number) {
  return (songBpm / 60) * leadInSeconds;
}

export function wallTailGraceBeats(songBpm: number) {
  return (songBpm / 60) * wallTailGraceSeconds;
}

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

export function currentHalfJumpDurationInBeats(motion: ObjectMotion, state: SpawnState) {
  return motion.usesGlobalNjs ? state.halfJumpDurationInBeats : motion.hjdBeats;
}

export function currentUnitsPerBeat(motion: ObjectMotion, state: SpawnState) {
  return motion.usesGlobalNjs ? state.halfJumpDistance / state.halfJumpDurationInBeats : motion.unitsPerBeat;
}

export function currentSpawnBeat(motion: ObjectMotion, state: SpawnState) {
  return motion.spawnAnchorBeat - currentHalfJumpDurationInBeats(motion, state);
}

function jumpLineDistance(motion: ObjectMotion, nowBeat: number, state: SpawnState) {
  return Z_OFFSET + (motion.beat - nowBeat) * currentUnitsPerBeat(motion, state);
}

export function aheadDistance(motion: ObjectMotion, nowBeat: number, state: SpawnState): number {
  const spawnBeat = currentSpawnBeat(motion, state);
  if (nowBeat >= spawnBeat) return jumpLineDistance(motion, nowBeat, state);

  const enterBeat = spawnBeat - motion.leadInBeats;
  const travel = clamp01((nowBeat - enterBeat) / motion.leadInBeats);
  return jumpLineDistance(motion, spawnBeat, state) + leadInDistance * (1 - travel);
}

export function noteJumpAheadDistance(motion: ObjectMotion, nowBeat: number, state: SpawnState): number {
  const regularDistance = aheadDistance(motion, nowBeat, state);
  const jumpDuration = currentHalfJumpDurationInBeats(motion, state) * 2;
  const retreatDuration = jumpDuration * 0.25;
  const retreatBeat = currentSpawnBeat(motion, state) + jumpDuration - retreatDuration;
  if (nowBeat <= retreatBeat || retreatDuration <= 0) return regularDistance;
  const retreat = clamp01((nowBeat - retreatBeat) / retreatDuration);
  return regularDistance - jumpRetreatDistance * retreat ** 3;
}

export function wallAheadDistance(motion: ObjectMotion, pullBeat: number, nowBeat: number, state: SpawnState): number {
  const regularDistance = aheadDistance(motion, nowBeat, state);
  const retreatDuration = motion.movementEndBeat + currentHalfJumpDurationInBeats(motion, state) - pullBeat;
  if (nowBeat <= pullBeat || retreatDuration <= 0) return regularDistance;
  const retreat = clamp01((nowBeat - pullBeat) / retreatDuration);
  return regularDistance - jumpRetreatDistance * retreat ** 3;
}

export function isVisible(motion: ObjectMotion, nowBeat: number): boolean {
  return nowBeat >= motion.enterBeat && nowBeat <= motion.despawnBeat;
}

export function isVisibleBeforeHit(motion: ObjectMotion, nowBeat: number): boolean {
  return isVisible(motion, nowBeat) && nowBeat < motion.beat;
}

function spawnLinearProgress(motion: ObjectMotion, nowBeat: number, state: SpawnState) {
  const spawnBeat = currentSpawnBeat(motion, state);
  return clamp01((nowBeat - spawnBeat) / (motion.spawnAnchorBeat - spawnBeat));
}

export function spawnProgress(motion: ObjectMotion, nowBeat: number, state: SpawnState): number {
  const progress = spawnLinearProgress(motion, nowBeat, state);
  return progress * (2 - progress);
}

export function spawnFlipProgress(motion: ObjectMotion, nowBeat: number, state: SpawnState) {
  const progress = clamp01(spawnLinearProgress(motion, nowBeat, state) * 2);
  return progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
}

export function spawnFlipYOffset(motion: ObjectMotion, nowBeat: number, flipYSide: number, state: SpawnState) {
  const progress = spawnLinearProgress(motion, nowBeat, state);
  if (flipYSide === 0 || progress >= 0.5) return 0;
  const avoidance = flipYSide > 0 ? flipYSide * 0.45 : flipYSide * 0.15;
  return (0.5 - Math.cos(progress * Math.PI * 4) * 0.5) * avoidance;
}

export function spawnRotationProgress(motion: ObjectMotion, nowBeat: number, state: SpawnState): number {
  const turn = clamp01(spawnLinearProgress(motion, nowBeat, state) * 4);
  return Math.sin(turn * Math.PI * 0.5);
}

// the game's ObstacleScaleUp sizes its window from the global movement provider,
// so per-object noodle njs/offset must not stretch the grow duration
export function wallSpawnScale(motion: ObjectMotion, nowBeat: number, state: SpawnState): number {
  const growBeats = state.halfJumpDurationInBeats * 0.25;
  const progress = clamp01((nowBeat - currentSpawnBeat(motion, state)) / growBeats);
  return progress * (2 - progress);
}

export function maxConcurrent(windows: { enterBeat: number; despawnBeat: number }[]): number {
  const edges: { beat: number; delta: number }[] = [];
  for (const window of windows) {
    edges.push({ beat: window.enterBeat, delta: 1 });
    edges.push({ beat: window.despawnBeat, delta: -1 });
  }
  edges.sort((a, b) => a.beat - b.beat || a.delta - b.delta);
  let current = 0;
  let max = 0;
  for (const edge of edges) {
    current += edge.delta;
    if (current > max) max = current;
  }
  return max;
}
