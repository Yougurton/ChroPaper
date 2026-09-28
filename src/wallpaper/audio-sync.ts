/**
 * Audio-based fine alignment for the screensaver's sync mode.
 *
 * Sync mode starts from the media player's reported position plus the silence the mapper padded
 * onto the map's audio. Both are estimates: the player's position arrives with a delay that varies
 * from reading to reading, and a song's own quiet intro can't always be told apart from padding.
 * Either one leaves the map running early or late by up to a couple of seconds.
 *
 * This measures the offset directly instead. The map's own audio file (already decoded for the
 * sync clock) is turned into an onset curve once; Wallpaper Engine's live spectrum of what is
 * actually playing is turned into the same kind of curve as it arrives. Correlating the two over
 * the last few seconds shows how far the map clock is from the music being heard. Only onset
 * *timing* is compared, so a different master, EQ or loudness in the streaming version doesn't
 * matter.
 *
 * Checked offline against BeatSaver maps with a simulated Wallpaper Engine spectrum (EQ change,
 * noise, frame jitter, WE-style decay): estimates landed within 35 ms of the true offset. With
 * another song mixed in at -12 dB some estimates go wrong, which is what the score/margin checks
 * are for; alignSyncToAudio in main.ts also requires two estimates in a row to agree before it
 * moves anything.
 */

// Reference curve from the map's audio: decimated to ~12 kHz, 512-point FFT every 20 ms.
const REFERENCE_TARGET_RATE = 12000;
const REFERENCE_FFT_SIZE = 512;
const REFERENCE_HOP_SECONDS = 0.02;
const BAND_COUNT = 64;
const BAND_LOW_HZ = 30;
const REFERENCE_BAND_HIGH_HZ = 5500;
// Bins/bands below this index count as "low" (kick/bass) for the second feature.
const LOW_BAND_COUNT = 10;
const FEATURE_WEIGHTS = [0.6, 0.4] as const;
const NORMALIZE_QUANTILE = 0.95;
const FRAMES_PER_YIELD = 150;

// Live side.
const WINDOW_SECONDS = 16;
const MIN_WINDOW_SPAN_SECONDS = 10;
const MIN_WINDOW_FRAMES = 150;
const MAX_FRAME_GAP_SECONDS = 0.1;
const LAG_STEP_SECONDS = 0.01;
// A second-best peak closer than this to the best one is just the same peak's shoulder.
const PEAK_EXCLUSION_SECONDS = 0.12;
// Searching the whole map: a coarser first pass (one reference frame), and how close two peaks'
// scores have to be to count as the same section repeated.
const WHOLE_LAG_STEP_SECONDS = 0.02;
const WHOLE_TIE_TOLERANCE = 0.03;
const WHOLE_CANDIDATES = 12;

export interface SyncReference {
  /** Curve frames per second of file time. */
  readonly rate: number;
  /** Onset strength per frame, whole spectrum and low bands only; frame j describes the audio
   *  ending at file time (j + 1) / rate. */
  readonly all: Float32Array;
  readonly low: Float32Array;
  /** RMS level of the map's audio per frame (the 20 ms ending at the frame's time). */
  readonly level: Float32Array;
  /** The level most of the song stays under (90th percentile) — what "loud" means for it. */
  readonly loudLevel: number;
  readonly frameCount: number;
}

export interface AlignEstimate {
  /** Seconds to add to the map clock so it lines up with what is playing. */
  offset: number;
  /** Weighted correlation at the best lag (-1..1). */
  score: number;
  /** How far the best lag beats any other candidate. */
  margin: number;
}

/** Log-spaced band edges as FFT bin ranges [start, end). Every band gets at least one bin. */
function bandRanges(fftSize: number, sampleRate: number, lowHz: number, highHz: number): Int32Array {
  const ranges = new Int32Array(BAND_COUNT * 2);
  const binHz = sampleRate / fftSize;
  const maxBin = fftSize / 2;
  for (let band = 0; band < BAND_COUNT; band++) {
    const lo = lowHz * Math.pow(highHz / lowHz, band / BAND_COUNT);
    const hi = lowHz * Math.pow(highHz / lowHz, (band + 1) / BAND_COUNT);
    let start = Math.ceil(lo / binHz);
    let end = Math.ceil(hi / binHz);
    if (end <= start) {
      start = Math.min(maxBin, Math.round(lo / binHz));
      end = start + 1;
    }
    ranges[band * 2] = Math.min(start, maxBin);
    ranges[band * 2 + 1] = Math.min(Math.max(end, start + 1), maxBin + 1);
  }
  return ranges;
}

/** In-place iterative radix-2 FFT (size must be a power of two). */
class Fft {
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly reverse: Uint32Array;

  constructor(readonly size: number) {
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.reverse = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r;
    }
  }

  transform(re: Float32Array, im: Float32Array) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reverse[i] ?? 0;
      if (j > i) {
        const tr = re[i] ?? 0;
        re[i] = re[j] ?? 0;
        re[j] = tr;
        const ti = im[i] ?? 0;
        im[i] = im[j] ?? 0;
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step] ?? 1;
          const wi = this.sin[k * step] ?? 0;
          const a = start + k;
          const b = a + half;
          const br = re[b] ?? 0;
          const bi = im[b] ?? 0;
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          const ar = re[a] ?? 0;
          const ai = im[a] ?? 0;
          re[b] = ar - tr;
          im[b] = ai - ti;
          re[a] = ar + tr;
          im[a] = ai + ti;
        }
      }
    }
  }
}

function quantileOf(values: Float32Array, quantile: number, stride: number): number {
  const sample = new Float32Array(Math.ceil(values.length / stride));
  for (let i = 0, j = 0; i < values.length; i += stride, j++) sample[j] = values[i] ?? 0;
  if (sample.length === 0) return 0;
  sample.sort(); // typed-array sort is numeric
  return sample[Math.min(sample.length - 1, Math.floor(sample.length * quantile))] ?? 0;
}

/** Onset features from per-frame band magnitudes (frames × 64), the same way for both sides:
 *  normalized by the level most of the song stays under, log-compressed, then the positive change
 *  per band summed (all bands, and just the low ones). `continuous[j] === false` marks a frame
 *  that doesn't follow its predecessor closely enough to take a difference from. */
function onsetFeatures(magnitudes: Float32Array, frames: number, continuous?: (frame: number) => boolean): Float32Array {
  const reference = quantileOf(magnitudes, NORMALIZE_QUANTILE, magnitudes.length > 200_000 ? 7 : 1) || 1e-9;
  const features = new Float32Array(frames * 2);
  const previous = new Float32Array(BAND_COUNT);
  for (let frame = 0; frame < frames; frame++) {
    const usePrevious = frame > 0 && (continuous?.(frame) ?? true);
    let all = 0;
    let low = 0;
    for (let band = 0; band < BAND_COUNT; band++) {
      const value = Math.log1p(20 * Math.min((magnitudes[frame * BAND_COUNT + band] ?? 0) / reference, 1.5));
      if (usePrevious) {
        const rise = value - (previous[band] ?? 0);
        if (rise > 0) {
          all += rise;
          if (band < LOW_BAND_COUNT) low += rise;
        }
      }
      previous[band] = value;
    }
    features[frame * 2] = all;
    features[frame * 2 + 1] = low;
  }
  return features;
}

/** Builds the map audio's onset curve. Runs in slices so a long song doesn't stall rendering;
 *  returns null if cancelled (the synced track changed meanwhile). */
export async function buildSyncReference(buffer: AudioBuffer, isCancelled: () => boolean): Promise<SyncReference | null> {
  const factor = Math.max(1, Math.round(buffer.sampleRate / REFERENCE_TARGET_RATE));
  const rate = buffer.sampleRate / factor;
  const length = Math.floor(buffer.length / factor);
  const mono = new Float32Array(length);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const scale = 1 / (factor * Math.max(1, channels.length));
  for (const channel of channels) {
    for (let i = 0; i < length; i++) {
      let sum = 0;
      const base = i * factor;
      for (let k = 0; k < factor; k++) sum += channel[base + k] ?? 0;
      mono[i] = (mono[i] ?? 0) + sum * scale;
    }
  }

  const size = REFERENCE_FFT_SIZE;
  const hop = Math.max(1, Math.round(rate * REFERENCE_HOP_SECONDS));
  const frames = Math.floor(length / hop);
  if (frames < 2) return null;
  const fft = new Fft(size);
  const hann = new Float32Array(size);
  for (let i = 0; i < size; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const ranges = bandRanges(size, rate, BAND_LOW_HZ, Math.min(REFERENCE_BAND_HIGH_HZ, rate / 2 - 1));
  const magnitudes = new Float32Array(frames * BAND_COUNT);
  const level = new Float32Array(frames);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  for (let frame = 0; frame < frames; frame++) {
    if (frame % FRAMES_PER_YIELD === 0 && frame > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (isCancelled()) return null;
    }
    const end = (frame + 1) * hop;
    const start = end - size;
    let squares = 0;
    for (let i = end - hop; i < end; i++) squares += (mono[i] ?? 0) ** 2;
    level[frame] = Math.sqrt(squares / hop);
    for (let i = 0; i < size; i++) {
      const index = start + i;
      re[i] = index >= 0 ? (mono[index] ?? 0) * (hann[i] ?? 0) : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let band = 0; band < BAND_COUNT; band++) {
      const from = ranges[band * 2] ?? 0;
      const to = ranges[band * 2 + 1] ?? from + 1;
      let sum = 0;
      for (let bin = from; bin < to; bin++) {
        const r = re[bin] ?? 0;
        const i = im[bin] ?? 0;
        sum += Math.sqrt(r * r + i * i);
      }
      magnitudes[frame * BAND_COUNT + band] = sum / (to - from);
    }
  }
  if (isCancelled()) return null;
  const features = onsetFeatures(magnitudes, frames);
  const all = new Float32Array(frames);
  const low = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    all[frame] = features[frame * 2] ?? 0;
    low[frame] = features[frame * 2 + 1] ?? 0;
  }
  const loudLevel = quantileOf(level, 0.9, 3);
  return { rate: rate / hop, all, low, level, loudLevel, frameCount: frames };
}

/** How loud the map's own audio gets between two file times, relative to its loudLevel (0 = silent,
 *  1 = as loud as the song usually gets) — or null if that stretch lies outside the audio. Lets
 *  sync mode tell a quiet moment in the song (the map is quiet there too) from a paused player. */
export function referenceLoudness(reference: SyncReference, fromTime: number, toTime: number): number | null {
  const first = Math.max(0, Math.floor(fromTime * reference.rate));
  const last = Math.min(reference.frameCount - 1, Math.ceil(toTime * reference.rate));
  if (last < first || reference.loudLevel <= 0) return null;
  let peak = 0;
  for (let frame = first; frame <= last; frame++) peak = Math.max(peak, reference.level[frame] ?? 0);
  return peak / reference.loudLevel;
}

interface LiveFrame {
  /** Map file time the clock showed when this frame arrived (without the user's manual offset). */
  fileTime: number;
  /** Arrival time, seconds. */
  at: number;
  bins: Float32Array;
}

/** Collects Wallpaper Engine's live spectrum alongside the map clock and estimates their offset. */
export class SyncAligner {
  private frames: LiveFrame[] = [];

  clear() {
    this.frames = [];
  }

  /** The map clock was moved by `delta` without the music moving: keep old frames consistent. */
  shift(delta: number) {
    for (const frame of this.frames) frame.fileTime += delta;
  }

  addFrame(audio: ArrayLike<number>, fileTime: number, nowSec: number) {
    const bins = new Float32Array(BAND_COUNT);
    for (let bin = 0; bin < BAND_COUNT; bin++) {
      bins[bin] = Math.min(((audio[bin] ?? 0) + (audio[bin + BAND_COUNT] ?? 0)) * 0.5, 1.5);
    }
    this.frames.push({ fileTime, at: nowSec, bins });
    const oldest = nowSec - WINDOW_SECONDS - 1;
    let drop = 0;
    while (drop < this.frames.length && (this.frames[drop]?.at ?? 0) < oldest) drop++;
    if (drop > 0) this.frames.splice(0, drop);
  }

  /** Best offset within ±range seconds of the clock — or anywhere in the map with 'whole' (for a
   *  different edit of the song, where the clock can be anywhere) — or null if there isn't enough
   *  (non-silent) audio yet. */
  estimate(reference: SyncReference, range: number | 'whole'): AlignEstimate | null {
    const last = this.frames[this.frames.length - 1];
    if (last === undefined) return null;
    const recent = this.frames.filter((frame) => frame.at >= last.at - WINDOW_SECONDS);
    const first = recent[0];
    if (first === undefined || recent.length < MIN_WINDOW_FRAMES || last.at - first.at < MIN_WINDOW_SPAN_SECONDS) return null;

    const count = recent.length;
    const magnitudes = new Float32Array(count * BAND_COUNT);
    recent.forEach((frame, index) => magnitudes.set(frame.bins, index * BAND_COUNT));
    const live = onsetFeatures(magnitudes, count, (index) => {
      const current = recent[index];
      const previous = recent[index - 1];
      return current !== undefined && previous !== undefined && current.at - previous.at <= MAX_FRAME_GAP_SECONDS;
    });

    // Live features, standardized per feature.
    const liveZ = new Float32Array(count * 2);
    for (let f = 0; f < 2; f++) {
      let mean = 0;
      for (let i = 0; i < count; i++) mean += live[i * 2 + f] ?? 0;
      mean /= count;
      let variance = 0;
      for (let i = 0; i < count; i++) variance += ((live[i * 2 + f] ?? 0) - mean) ** 2;
      const std = Math.sqrt(variance / count);
      if (std < 1e-6) return null; // silence or a flat signal: nothing to line up
      for (let i = 0; i < count; i++) liveZ[i * 2 + f] = ((live[i * 2 + f] ?? 0) - mean) / std;
    }

    // Flat arrays up front: the loop below runs lags × frames times.
    const refAll = reference.all;
    const refLow = reference.low;
    const liveAll = new Float32Array(count);
    const liveLow = new Float32Array(count);
    const basePosition = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      liveAll[i] = liveZ[i * 2] ?? 0;
      liveLow[i] = liveZ[i * 2 + 1] ?? 0;
      basePosition[i] = (recent[i]?.fileTime ?? 0) * reference.rate - 1;
    }
    const pearson = (sumL: number, sumLL: number, sumR: number, sumRR: number, sumLR: number, used: number) => {
      const meanL = sumL / used;
      const meanR = sumR / used;
      const varL = sumLL / used - meanL * meanL;
      const varR = sumRR / used - meanR * meanR;
      if (varL <= 1e-9 || varR <= 1e-9) return 0;
      return (sumLR / used - meanL * meanR) / Math.sqrt(varL * varR);
    };
    const lastIndex = reference.frameCount - 1;
    /** Weighted correlation with the map shifted by `lag` seconds (−∞ if too little overlaps). */
    const scoreAt = (lag: number, frameStride = 1): number => {
      const lagFrames = lag * reference.rate;
      let used = 0;
      let aL = 0, aLL = 0, aR = 0, aRR = 0, aLR = 0;
      let bL = 0, bLL = 0, bR = 0, bRR = 0, bLR = 0;
      for (let i = 0; i < count; i += frameStride) {
        const position = (basePosition[i] ?? 0) + lagFrames;
        const index = Math.floor(position);
        if (index < 0 || index >= lastIndex) continue;
        const fraction = position - index;
        used++;
        const ra = (refAll[index] ?? 0) + ((refAll[index + 1] ?? 0) - (refAll[index] ?? 0)) * fraction;
        const rb = (refLow[index] ?? 0) + ((refLow[index + 1] ?? 0) - (refLow[index] ?? 0)) * fraction;
        const la = liveAll[i] ?? 0;
        const lb = liveLow[i] ?? 0;
        aL += la;
        aLL += la * la;
        aR += ra;
        aRR += ra * ra;
        aLR += la * ra;
        bL += lb;
        bLL += lb * lb;
        bR += rb;
        bRR += rb * rb;
        bLR += lb * rb;
      }
      if (used < (count / frameStride) * 0.8) return Number.NEGATIVE_INFINITY;
      return FEATURE_WEIGHTS[0] * pearson(aL, aLL, aR, aRR, aLR, used) + FEATURE_WEIGHTS[1] * pearson(bL, bLL, bR, bRR, bLR, used);
    };

    const refineAround = (lag: number): { lag: number; score: number } => {
      let bestLag = lag;
      let bestScore = scoreAt(lag);
      for (let k = -3; k <= 3; k++) {
        if (k === 0) continue;
        const value = scoreAt(lag + k * LAG_STEP_SECONDS);
        if (value > bestScore) {
          bestScore = value;
          bestLag = lag + k * LAG_STEP_SECONDS;
        }
      }
      return { lag: bestLag, score: bestScore };
    };
    const finish = (center: number, centerScore: number, margin: number): AlignEstimate => {
      // Parabolic interpolation for a finer offset than the 10 ms grid.
      const before = scoreAt(center - LAG_STEP_SECONDS);
      const after = scoreAt(center + LAG_STEP_SECONDS);
      let refined = center;
      if (Number.isFinite(before) && Number.isFinite(after)) {
        const curvature = before - 2 * centerScore + after;
        if (curvature < 0) refined += (0.5 * (before - after) * LAG_STEP_SECONDS) / curvature;
      }
      return { offset: refined, score: centerScore, margin };
    };

    if (range !== 'whole') {
      const lagCount = Math.floor((2 * range) / LAG_STEP_SECONDS) + 1;
      const scores = new Float32Array(lagCount);
      for (let i = 0; i < lagCount; i++) scores[i] = scoreAt(-range + i * LAG_STEP_SECONDS);
      let best = -1;
      for (let i = 0; i < lagCount; i++) if (best < 0 || (scores[i] ?? -Infinity) > (scores[best] ?? -Infinity)) best = i;
      const bestScore = scores[best] ?? Number.NEGATIVE_INFINITY;
      if (best < 0 || !Number.isFinite(bestScore)) return null;
      const exclusion = Math.round(PEAK_EXCLUSION_SECONDS / LAG_STEP_SECONDS);
      let second = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < lagCount; i++) {
        if (Math.abs(i - best) > exclusion) second = Math.max(second, scores[i] ?? Number.NEGATIVE_INFINITY);
      }
      return finish(-range + best * LAG_STEP_SECONDS, bestScore, Number.isFinite(second) ? bestScore - second : bestScore);
    }

    // The whole map: a coarse pass (coarser lag grid, every other live frame) to find candidate
    // peaks, then the best few are measured properly.
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    for (const frame of recent) {
      minTime = Math.min(minTime, frame.fileTime);
      maxTime = Math.max(maxTime, frame.fileTime);
    }
    const minLag = -minTime;
    const maxLag = reference.frameCount / reference.rate - maxTime;
    if (maxLag <= minLag) return null;
    const lagCount = Math.floor((maxLag - minLag) / WHOLE_LAG_STEP_SECONDS) + 1;
    const coarse = new Float32Array(lagCount);
    for (let i = 0; i < lagCount; i++) coarse[i] = scoreAt(minLag + i * WHOLE_LAG_STEP_SECONDS, 2);
    const peaks: number[] = [];
    for (let i = 0; i < lagCount; i++) {
      const value = coarse[i] ?? Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(value)) continue;
      if (value >= (coarse[i - 1] ?? Number.NEGATIVE_INFINITY) && value > (coarse[i + 1] ?? Number.NEGATIVE_INFINITY)) peaks.push(i);
    }
    if (peaks.length === 0) return null;
    peaks.sort((a, b) => (coarse[b] ?? 0) - (coarse[a] ?? 0));
    const candidates = peaks.slice(0, WHOLE_CANDIDATES).map((i) => refineAround(minLag + i * WHOLE_LAG_STEP_SECONDS));
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];
    if (top === undefined || !Number.isFinite(top.score)) return null;
    // A section the song repeats (a chorus) matches in several places almost equally well; any of
    // them lights the same way, so take the one nearest the current position — that keeps the pick
    // stable from one estimate to the next instead of flipping between copies.
    let chosen = top;
    for (const candidate of candidates) {
      if (candidate.score >= top.score - WHOLE_TIE_TOLERANCE && Math.abs(candidate.lag) < Math.abs(chosen.lag)) chosen = candidate;
    }
    const second = candidates.find((candidate) => Math.abs(candidate.lag - top.lag) > PEAK_EXCLUSION_SECONDS);
    return finish(chosen.lag, chosen.score, second === undefined ? top.score : top.score - second.score);
  }
}
