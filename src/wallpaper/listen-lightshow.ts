/**
 * Offline lightshow generator for the screensaver ("listen") mode — turns Wallpaper Engine's live
 * audio spectrum into classic Beat Saber light events, the way a mapper would light the song.
 *
 * What it's modelled on: five hand-lit reference maps in different genres (funk, EDM, pop, ambient,
 * rock), analysed against their own audio. The takeaways that shaped this:
 *
 * - Mappers light to the *beat grid*, not to raw audio onsets: 60-90% of their light events sit on
 *   whole or half beats, while matching an audio onset only ~1.3x as often as chance. So the core
 *   here is a tempo/beat tracker, and events are scheduled on predicted beats — onsets only decide
 *   extras (half-beat accents) and how strong the music currently is.
 * - Each map keeps one lighting *vocabulary* for the whole song, and the vocabulary is what differs
 *   between genres: rock pulses every group with fades on each beat and flips the colour every bar
 *   (Cicada); pop spreads groups over beats 1/3 vs 2/4 and off-beats with flashes (Spoken For);
 *   EDM uses fades with a lot of white and spinning rings (Idol); funk/groove uses on + transition
 *   pairs for pumping gradients and strobing side lasers (Funk Off); ambient uses long, sparse
 *   transitions (Lunar Carver). → a style per track (from genre tags when the player sends them,
 *   otherwise tempo and sound character).
 * - Density follows loudness within a song (correlation 0.3-0.6): louder sections get more groups
 *   and more half-beats. → four intensity tiers, changed only on bar boundaries.
 * - Ring spins land every 1-4 beats on the beat, zooms every 2-8 bars, laser speed changes every
 *   1-2 beats, and colour changes on bar/phrase boundaries. → all of that is grid-aligned here too.
 *
 * Everything runs locally on the audio Wallpaper Engine already provides (128-bin spectrum at
 * ~30 fps, no raw audio) — no network needed. The class is plain TypeScript with no DOM/Three
 * dependencies, so it can be (and was) run offline against the reference songs to check tempo
 * detection and event density.
 */

import type { BeatmapCustomData } from '../core/beatmap/types';
import type { Rgb } from '../core/colors';

export type LightStyle = 'ambient' | 'gradient' | 'pulse' | 'pop' | 'edm' | 'layered';

export interface GeneratedLightEvent {
  /** Seconds, on the same clock as the `nowSec` values passed in. */
  time: number;
  type: number;
  value: number;
  floatValue: number;
  customData?: BeatmapCustomData;
}

export interface ListenLightshowState {
  bpm: number | null;
  confidence: number;
  intensity: number;
  tier: number;
  style: LightStyle;
  styleSource: 'genre' | 'audio' | 'default';
  /** 'sustained' while the music is pads/chords without much percussion, 'gap' during a silence. */
  texture: 'percussive' | 'sustained' | 'gap';
  /** True while the tempo keeps jumping between readings (the beat grid isn't trusted). */
  tempoUnstable: boolean;
}

// ----- tunables -----------------------------------------------------------------------------------

const HISTORY_SECONDS = 12; // onset history kept for tempo/phase estimation
const TEMPO_WINDOW_SECONDS = 10;
const PHASE_WINDOW_SECONDS = 6;
const TEMPO_UPDATE_SECONDS = 0.5;
const MIN_BPM = 70;
const MAX_BPM = 190;
const BPM_STEP = 0.5;
// Log-normal prior around typical song tempos, so octave errors lean towards the usual range.
const PRIOR_CENTER_BPM = 125;
const PRIOR_WIDTH_OCTAVES = 0.9;
// Beats scheduled at most this far ahead; the caller's tick runs every ~200 ms.
const SCHEDULE_HORIZON_SECONDS = 0.6;
// Below this tempo-confidence the beat grid isn't trusted and a free-running fallback pulse is used.
const MIN_CONFIDENCE = 1.25;
// Beat phase is scored on the full-spectrum onsets plus half again for the bass ones. (Tried
// leaning harder on the bass — kicks sit on the beat — but on the reference songs it helped the
// funk track and hurt rock/EDM; this balance kept 92-100% of beats on the beat for the
// steady-tempo tracks once combined with local tracking, see updatePhase.)
const PHASE_WEIGHT_ALL = 1;
const PHASE_WEIGHT_BASS = 0.5;

// Frequency bands (Wallpaper Engine bins 0-63, bass → treble) — each one is bound to its own light
// group in the "layered" style: kick/bass → ring lights, chords/snare/voice → back lasers,
// hats/cymbals → side lasers, and the tonal body (pads, chords, vocals) → the centre's glow.
const BAND_RANGES: readonly (readonly [number, number])[] = [
  [0, 8], // low: kick, bass
  [8, 24], // low-mid: bass notes, chord body
  [24, 44], // mid: chords, stabs, snare body, voice
  [44, 64], // high: hats, cymbals, air
];
const BAND_LOW = 0;
const BAND_LOWMID = 1;
const BAND_MID = 2;
const BAND_HIGH = 3;
const BAND_REFRACTORY_SECONDS = [0.14, 0.14, 0.11, 0.08];
// Envelope-following lights are refreshed this often (smooth transitions in between).
const ENVELOPE_STEP_SECONDS = 0.12;
// Two or more tempo re-locks within this window = the tempo can't be pinned down (e.g. Ball Pit
// keeps reading as 140, 94 and 105 BPM: its 3-3-2 syncopation supports all three).
const TEMPO_UNSTABLE_WINDOW_SECONDS = 40;
// One full colour glide (left colour → right colour → back) in the smooth layers.
// Silence must hold this long before the lights go dark (shorter dips are just staccato/chops),
// then fades out over GAP_FADE_SECONDS; the comeback flash is only for pauses longer than
// GAP_PUNCH_SECONDS.
const GAP_CONFIRM_SECONDS = 0.35;
const GAP_FADE_SECONDS = 0.3;
const GAP_PUNCH_SECONDS = 0.8;
const GLIDE_PERIOD_SECONDS = 16;

const VALUE_BASE = { blue: 1, red: 5, white: 9 } as const;
const KIND_OFFSET = { on: 0, flash: 1, fade: 2, trans: 3 } as const;
type LightColor = keyof typeof VALUE_BASE;
type LightKind = keyof typeof KIND_OFFSET;

// Classic light groups: 0 back lasers, 1 ring lights, 2 left lasers, 3 right lasers, 4 center.
const BACK = 0;
const RING = 1;
const LEFT = 2;
const RIGHT = 3;
const CENTER = 4;
const BOOST = 5;
const RING_SPIN = 8;
const RING_ZOOM = 9;
const LEFT_SPEED = 12;
const RIGHT_SPEED = 13;

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

/** Linear interpolation into an array at a fractional index (0 outside). */
function sampleAt(values: Float32Array, length: number, index: number) {
  if (index < 0 || index > length - 1) return 0;
  const low = Math.floor(index);
  const fraction = index - low;
  const a = values[low] ?? 0;
  const b = values[Math.min(low + 1, length - 1)] ?? 0;
  return a + (b - a) * fraction;
}

/** Small deterministic PRNG so a given track lights the same way each time it plays. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Style from the player's genre tags, when it sends any (not all players do). */
export function styleFromGenres(genres: string): LightStyle | null {
  const text = genres.toLowerCase();
  if (text.trim() === '') return null;
  if (/ambient|classical|piano|lo-?fi|chill|acoustic|soundtrack|score|new age|meditation|sleep/.test(text)) return 'ambient';
  if (/dubstep|drum|dnb|d&b|edm|electro|trap|techno|trance|bass|hardstyle|future|riddim|breakbeat/.test(text)) return 'edm';
  if (/funk|disco|jazz|soul|r&b|rnb|house|groove|hip.?hop|rap|swing|blues/.test(text)) return 'gradient';
  if (/rock|metal|punk|indie|alternative|grunge|emo|core/.test(text)) return 'pulse';
  if (/pop|vocaloid|anime|k-?pop|j-?pop|dance|idol|synth/.test(text)) return 'pop';
  return null;
}

export class ListenLightshow {
  // --- analysis state ---
  private readonly capacity: number;
  private readonly onset: Float32Array;
  private readonly lowOnset: Float32Array;
  private readonly frameTime: Float64Array;
  private frames = 0; // total frames seen (ring buffer write position = frames % capacity)
  private readonly logScratch = new Float32Array(64);
  private readonly previousLog = new Float32Array(64);
  private hasPrevious = false;
  private fps = 30;
  private lastFrameTime: number | null = null;

  private shortEnergy = 0;
  private longEnergy = 0;
  private energyFrames = 0; // frames since the level references were reset
  private readonly energyHistory = new Float32Array(480); // short-term loudness, ~4 samples/s
  private energyHistoryCount = 0;
  private onsetMean = 0;
  // Per-track sound character, for picking a style (see styleFromAudio).
  private trackEnergies: number[] = [];
  private trackLowShare = 0;
  private trackHighShare = 0;
  private trackActiveFrames = 0;
  private trackStrongOnsets = 0;

  // --- beat tracking ---
  private bpm: number | null = null;
  private confidence = 0;
  private beatPeriod = 0.5;
  private beatAnchor: number | null = null; // time of beat number `anchorIndex`
  private anchorIndex = 0;
  private lastTempoUpdate = -Infinity;
  private candidateBpm: number | null = null;
  private candidateVotes = 0;
  private relockVotes = 0;
  private readonly downbeatScore = new Float64Array(4);

  // --- song structure ---
  private intensity = 0.5;
  private tier = 1;
  private lowerBars = 0;
  private lowerTarget = 1;
  private barIntensitySum = 0;
  private barIntensityFrames = 0;
  private previousTier = 1;
  private dropPending = false;
  private boostOn = false;

  // --- style ---
  private style: LightStyle = 'pop';
  private styleSource: 'genre' | 'audio' | 'default' = 'default';
  private genreStyle: LightStyle | null = null;
  private trackSeed = 1;
  private random = mulberry32(1);
  private beatsSinceTrackStart = 0;
  private styleDecisions = 0;

  // --- texture, instruments, silences (see addFrame) ---
  private readonly bandLevel = new Float32Array(4);
  private readonly bandEnv = new Float32Array(4);
  private readonly bandPeak = new Float32Array(4);
  private readonly bandFluxMean = new Float32Array(4);
  private readonly bandLastOnset = new Float64Array(4).fill(Number.NEGATIVE_INFINITY);
  private pendingOnsets: { time: number; band: number; strength: number }[] = [];
  private fluxFast = 0;
  private fluxSlow = 0;
  private highFast = 0;
  private sustained = false;
  private textureCandidateSince: number | null = null;
  private readonly fluxHistory = new Float32Array(480);
  private readonly highHistory = new Float32Array(480);
  private intensityFast = 0.5;
  private recentLevel = 0;
  private inGap = false;
  private gapStart = 0;
  private gapCandidateSince: number | null = null;
  private recentRingSpins: number[] = [];
  private preGapLevel = 0;
  private immediate: GeneratedLightEvent[] = [];
  private tempoRelocks: number[] = [];
  private styleBeforeLayered: LightStyle | null = null;
  private kickCount = 0;
  private hatSide = false;
  private nextEnvelopeTime = 0;
  private readonly lastEnvelopeValue = new Float32Array(5).fill(-1);
  private layeredLaserSpeedSet = false;
  /** Current environment colours (left/right lights), for the smooth colour glides. */
  colorProvider: (() => { left: Rgb; right: Rgb }) | null = null;

  // --- scheduling ---
  private scheduledThroughTime = -Infinity; // time of the last emitted half-beat step
  private colorFlip = false;

  /** 0..1 scale on input levels (the screensaver's "signal gain" setting). */
  gain = 1;
  /** 0..1: how quickly intensity follows loudness (the "reaction speed" setting). */
  responsiveness = 0.8;
  /** Extra density bias (the "sensitivity" setting): 0 = sparser, 1 = default, 2 = busier. */
  densityBias = 1;
  /** Seconds added to every scheduled light to compensate audio-capture latency. */
  latencySeconds = 0;

  constructor() {
    this.capacity = Math.ceil(HISTORY_SECONDS * 40);
    this.onset = new Float32Array(this.capacity);
    this.lowOnset = new Float32Array(this.capacity);
    this.frameTime = new Float64Array(this.capacity);
  }

  /** New track: forget tempo/style decisions, keep the running level references. */
  startTrack(title: string, genres: string) {
    this.trackSeed = hashString(`${title}|${genres}`) || 1;
    this.random = mulberry32(this.trackSeed);
    this.genreStyle = styleFromGenres(genres);
    this.style = this.genreStyle ?? 'pop';
    this.styleSource = this.genreStyle === null ? 'default' : 'genre';
    this.beatsSinceTrackStart = 0;
    this.styleDecisions = 0;
    this.bpm = null;
    this.confidence = 0;
    this.beatAnchor = null;
    this.candidateBpm = null;
    this.candidateVotes = 0;
    this.downbeatScore.fill(0);
    this.dropPending = false;
    this.colorFlip = this.random() < 0.5;
    this.trackEnergies = [];
    this.trackLowShare = 0;
    this.trackHighShare = 0;
    this.trackActiveFrames = 0;
    this.trackStrongOnsets = 0;
    this.tempoRelocks = [];
    this.pendingOnsets = [];
    this.layeredLaserSpeedSet = false;
    this.styleBeforeLayered = null;
  }

  /** Internal levels, for tuning/diagnostics only. */
  get debug() {
    return {
      longEnergy: this.longEnergy,
      shortEnergy: this.shortEnergy,
      ...this.trackCharacter(),
      fps: this.fps,
      fluxRatio: this.fluxFast / Math.max(this.fluxSlow, 1e-4),
    };
  }

  get state(): ListenLightshowState {
    return {
      bpm: this.bpm,
      confidence: this.confidence,
      intensity: this.intensity,
      tier: this.tier,
      style: this.style,
      styleSource: this.styleSource,
      texture: this.inGap ? 'gap' : this.sustained ? 'sustained' : 'percussive',
      tempoUnstable: this.tempoUnstable(this.lastFrameTime ?? 0),
    };
  }

  // ----- analysis -------------------------------------------------------------------------------

  /** Feed one Wallpaper Engine audio frame (128 values: 64 left + 64 right, bass → treble). */
  addFrame(audio: ArrayLike<number>, nowSec: number) {
    // A gap (paused audio, hidden wallpaper) breaks the frame-time series: start the history over.
    if (this.lastFrameTime !== null && nowSec - this.lastFrameTime > 0.5) this.frames = 0;
    this.lastFrameTime = nowSec;

    const log = this.logScratch;
    let energy = 0;
    let low = 0;
    let high = 0;
    for (let bin = 0; bin < 64; bin++) {
      const value = Math.min(((audio[bin] ?? 0) + (audio[bin + 64] ?? 0)) * 0.5 * this.gain, 1.5);
      energy += value;
      if (bin < 10) low += value;
      if (bin >= 40) high += value;
      log[bin] = Math.log1p(20 * value);
    }
    energy /= 64;

    let flux = 0;
    let lowFlux = 0;
    if (this.hasPrevious) {
      for (let bin = 0; bin < 64; bin++) {
        const rise = (log[bin] ?? 0) - (this.previousLog[bin] ?? 0);
        if (rise > 0) {
          // Bass weighted up a little: kicks carry the pulse in almost every genre.
          flux += rise * (bin < 10 ? 1.5 : 1);
          if (bin < 10) lowFlux += rise;
        }
      }
    }
    this.analyseBands(audio, log, nowSec);
    this.previousLog.set(log);
    this.hasPrevious = true;
    this.detectGap(energy, nowSec);

    const slot = this.frames % this.capacity;
    this.onset[slot] = flux;
    this.lowOnset[slot] = lowFlux;
    this.frameTime[slot] = nowSec;
    this.frames++;
    // Frame rate from the span of the whole history (not per-frame intervals: averaging 1/dt over
    // jittery callbacks is biased high, which showed up as every tempo reading ~1.5% too fast).
    const stored = Math.min(this.frames, this.capacity);
    if (stored > 60) {
      const oldest = this.frameTime[(this.frames - stored) % this.capacity] ?? nowSec;
      if (nowSec > oldest) this.fps = (stored - 1) / (nowSec - oldest);
    }

    this.onsetMean += (flux - this.onsetMean) * 0.01;
    // "Active" = clearly above this track's own quiet floor (relative, so it works at any level).
    if (energy > 1e-4 && energy > this.longEnergy * 0.3) {
      this.trackActiveFrames++;
      this.trackLowShare += low / (energy * 64);
      this.trackHighShare += high / (energy * 64);
      if (this.trackEnergies.length < 4000) this.trackEnergies.push(energy);
    }

    // Loudness: short (~1-3 s, per reaction-speed setting) vs long (~40 s) reference. The long
    // one is a plain running average until 40 s have gone by, so a quiet intro doesn't leave it
    // stuck near zero (which made everything after the intro look like a huge "drop").
    const shortRate = 0.01 + 0.04 * clamp01(this.responsiveness);
    this.energyFrames++;
    this.shortEnergy += (energy - this.shortEnergy) * shortRate;
    this.longEnergy += (energy - this.longEnergy) * Math.max(1 / (40 * this.fps), 1 / this.energyFrames);
    // Intensity = where the current loudness ranks among the last ~2 minutes (so every song spends
    // roughly a quarter of its time in each tier, the way the reference maps spread their busiest
    // lighting over the loudest quarter), nudged by the density setting. A plain ratio to the
    // long-term average put the tier at "peak" for ~65% of every song.
    if (this.energyFrames % 8 === 0) {
      this.energyHistory[this.energyHistoryCount % this.energyHistory.length] = this.shortEnergy;
      this.energyHistoryCount++;
    }
    const samples = Math.min(this.energyHistoryCount, this.energyHistory.length);
    if (this.energyFrames % 8 === 0) {
      this.fluxHistory[(this.energyHistoryCount - 1) % this.fluxHistory.length] = this.fluxFast;
      this.highHistory[(this.energyHistoryCount - 1) % this.highHistory.length] = this.highFast;
    }
    let below = 0;
    let fluxBelow = 0;
    let highBelow = 0;
    for (let index = 0; index < samples; index++) {
      if ((this.energyHistory[index] ?? 0) < this.shortEnergy) below++;
      if ((this.fluxHistory[index] ?? 0) < this.fluxFast) fluxBelow++;
      if ((this.highHistory[index] ?? 0) < this.highFast) highBelow++;
    }
    // Loudness alone isn't enough: heavily compressed tracks sit at the same level from start to
    // end and change *texture* instead (drums drop out, the treble is filtered away, only pads
    // remain). So "how busy is it" = loudness rank + percussion rank + brightness rank.
    const rank =
      samples < 20 ? 0.5 : (0.4 * below + 0.4 * fluxBelow + 0.2 * highBelow) / samples;
    // Only near-silence is judged in absolute terms: Wallpaper Engine's level scale depends on the
    // system volume and the player, so anything stricter would misjudge whole songs.
    const audible = clamp01(this.shortEnergy / 0.01);
    this.intensity = clamp01(rank + (this.densityBias - 1) * 0.15) * audible;
    this.barIntensitySum += this.intensity;
    this.barIntensityFrames++;
    this.intensityFast += (this.intensity - this.intensityFast) * 0.08;

    // No rhythm to read in silences or drum-less passages: the tempo holds until the beat returns.
    if (nowSec - this.lastTempoUpdate >= TEMPO_UPDATE_SECONDS && !this.inGap && this.gapCandidateSince === null && !this.sustained) {
      this.lastTempoUpdate = nowSec;
      this.updateTempo(nowSec);
    }
  }

  /** Detrended onset envelope for the last `seconds` (oldest first). */
  private recentOnsets(seconds: number, source: Float32Array = this.onset) {
    const count = Math.min(this.frames, Math.round(seconds * this.fps), this.capacity);
    const values = new Float32Array(count);
    const start = this.frames - count;
    for (let index = 0; index < count; index++) values[index] = source[(start + index) % this.capacity] ?? 0;
    // Subtract a local mean (~0.3 s) and keep only what sticks out: the peaks that carry rhythm.
    const radius = Math.max(2, Math.round(this.fps * 0.15));
    const detrended = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      let sum = 0;
      let n = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const value = values[index + offset];
        if (value !== undefined) {
          sum += value;
          n++;
        }
      }
      detrended[index] = Math.max(0, (values[index] ?? 0) - sum / Math.max(n, 1));
    }
    return { values: detrended, count, endTime: this.frameTime[(this.frames - 1) % this.capacity] ?? 0 };
  }

  private updateTempo(nowSec: number) {
    const { values, count, endTime } = this.recentOnsets(TEMPO_WINDOW_SECONDS);
    if (count < this.fps * 5) return;

    // Comb autocorrelation over fractional lags: score(bpm) = Σ o[n]·(o[n-P] + ½·o[n-2P]).
    let best = 0;
    let bestBpm = 0;
    let total = 0;
    let samples = 0;
    for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += BPM_STEP) {
      const period = (this.fps * 60) / bpm;
      let score = 0;
      for (let index = Math.ceil(2 * period); index < count; index++) {
        const value = values[index] ?? 0;
        if (value === 0) continue;
        score += value * (sampleAt(values, count, index - period) + 0.5 * sampleAt(values, count, index - 2 * period));
      }
      const octaves = Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_WIDTH_OCTAVES;
      const weighted = score * Math.exp(-0.5 * octaves * octaves);
      total += weighted;
      samples++;
      if (weighted > best) {
        best = weighted;
        bestBpm = bpm;
      }
    }
    if (best <= 0 || samples === 0) return;
    const confidence = best / (total / samples);

    // Refine around the peak with a finer step.
    let refined = bestBpm;
    let refinedScore = -1;
    for (let bpm = bestBpm - BPM_STEP; bpm <= bestBpm + BPM_STEP; bpm += 0.1) {
      const period = (this.fps * 60) / bpm;
      let score = 0;
      for (let index = Math.ceil(2 * period); index < count; index++) {
        const value = values[index] ?? 0;
        if (value !== 0) score += value * (sampleAt(values, count, index - period) + 0.5 * sampleAt(values, count, index - 2 * period));
      }
      if (score > refinedScore) {
        refinedScore = score;
        refined = bpm;
      }
    }

    // The comb gives the tempo to within ~1-2%; the phase-locked loop in updatePhase does the fine
    // tuning from where the beats actually land. So the comb only (re)sets the clock when it finds
    // a clearly different tempo — twice in a row (one second apart), so a single noisy window can't
    // flip the whole grid.
    if (this.bpm === null) {
      this.bpm = refined;
      this.beatPeriod = 60 / refined;
    } else if (Math.abs(refined - this.bpm) / this.bpm > 0.04) {
      if (this.candidateBpm !== null && Math.abs(refined - this.candidateBpm) / this.candidateBpm < 0.03) {
        this.candidateVotes++;
      } else {
        this.candidateBpm = refined;
        this.candidateVotes = 1;
      }
      // A reading at a simple ratio of the current tempo (half/double time, 2/3, 3/4 …) is usually
      // the same music heard at another metrical level — breakdowns and syncopation produce these
      // constantly (Cicada 180↔90, Funk Off 129↔86, Ball Pit 140↔94). Those need ~4 s of agreement
      // before the grid changes; an unrelated tempo only needs two readings.
      const related = isMetricallyRelated(refined, this.bpm);
      if (this.candidateVotes >= (related ? 8 : 2)) {
        if (!related) this.tempoRelocks.push(nowSec);
        this.bpm = refined;
        this.beatPeriod = 60 / refined;
        this.beatAnchor = null; // re-lock phase to the new tempo
        this.candidateBpm = null;
        this.candidateVotes = 0;
      }
    } else {
      this.candidateBpm = null;
      this.candidateVotes = 0;
    }
    this.confidence = confidence;
    this.updatePhase(endTime, nowSec);
    this.bpm = 60 / this.beatPeriod;
  }

  /** Finds where the beats fall for the current tempo and nudges the running beat clock onto it. */
  private updatePhase(endTime: number, nowSec: number) {
    const { values, count } = this.recentOnsets(PHASE_WINDOW_SECONDS);
    const low = this.recentOnsets(PHASE_WINDOW_SECONDS, this.lowOnset).values;
    const period = this.beatPeriod * this.fps;
    if (count < period * 3) return;
    // Score every candidate phase (in frames back from the newest frame).
    const steps = Math.ceil(period / 0.25);
    const scores = new Float64Array(steps);
    let globalBest = 0;
    for (let step = 0; step < steps; step++) {
      const phase = step * 0.25;
      let score = 0;
      for (let position = count - 1 - phase; position >= 0; position -= period) {
        // A little tolerance either side: frames arrive with jitter.
        const all = sampleAt(values, count, position) + 0.5 * (sampleAt(values, count, position - 1) + sampleAt(values, count, position + 1));
        const bass = sampleAt(low, count, position) + 0.5 * (sampleAt(low, count, position - 1) + sampleAt(low, count, position + 1));
        score += PHASE_WEIGHT_ALL * all + PHASE_WEIGHT_BASS * bass;
      }
      scores[step] = score;
      if (score > (scores[globalBest] ?? 0)) globalBest = step;
    }

    if (this.beatAnchor === null) {
      this.beatAnchor = endTime - (globalBest * 0.25) / this.fps;
      this.anchorIndex = 0;
      this.relockVotes = 0;
      return;
    }

    // Track locally: look for the best phase only within ±15% of a beat around where the running
    // clock says the beat is. Rock/EDM have strong off-beat hits (hi-hats, bass stabs, snares on
    // 2 & 4) that regularly score almost as high as the beat itself — searching the whole beat
    // every time made the grid hop between them. Only a clearly better phase elsewhere, several
    // updates in a row, re-locks the clock to it.
    const sinceBeat = (((endTime - this.beatAnchor) % this.beatPeriod) + this.beatPeriod) % this.beatPeriod;
    const predictedStep = Math.round((sinceBeat * this.fps) / 0.25) % steps;
    const radius = Math.max(1, Math.round((period * 0.15) / 0.25));
    let localBest = predictedStep;
    for (let offset = -radius; offset <= radius; offset++) {
      const step = (((predictedStep + offset) % steps) + steps) % steps;
      if ((scores[step] ?? 0) > (scores[localBest] ?? 0)) localBest = step;
    }
    if ((scores[globalBest] ?? 0) > (scores[localBest] ?? 0) * 1.35) this.relockVotes++;
    else this.relockVotes = 0;
    const chosen = this.relockVotes >= 4 ? globalBest : localBest;
    if (this.relockVotes >= 4) this.relockVotes = 0;
    const measuredBeat = endTime - (chosen * 0.25) / this.fps;

    // Phase-locked loop: move the running clock a fraction of the way to the measurement.
    const beatsSinceAnchor = Math.round((measuredBeat - this.beatAnchor) / this.beatPeriod);
    const predicted = this.beatAnchor + beatsSinceAnchor * this.beatPeriod;
    let error = measuredBeat - predicted;
    const half = this.beatPeriod / 2;
    if (error > half) error -= this.beatPeriod;
    if (error < -half) error += this.beatPeriod;
    // Second-order loop: the phase moves a quarter of the way to the measurement, and a consistent
    // error in one direction also bends the period — that's what pulls the tempo from the comb's
    // estimate onto the song's real one (e.g. 163.6 → 166 BPM) instead of drifting against it.
    const beatsToNow = Math.floor((nowSec - this.beatAnchor) / this.beatPeriod);
    this.anchorIndex += beatsToNow;
    this.beatAnchor += beatsToNow * this.beatPeriod + error * 0.25;
    const periodCorrection = Math.max(-0.004, Math.min(0.004, error * 0.02));
    this.beatPeriod = Math.min(60 / MIN_BPM, Math.max(60 / MAX_BPM, this.beatPeriod + periodCorrection));
  }


  // ----- scheduling -----------------------------------------------------------------------------

  /** Everything newly due up to `nowSec` + a short horizon. Call every tick while music plays. */
  collect(nowSec: number): GeneratedLightEvent[] {
    // Two ring spins landing on the same instant (a bar-line spin and an instrument-driven one)
    // would start two overlapping waves through the rings and double the turn — keep the first.
    return this.collectEvents(nowSec).filter((event) => {
      if (event.type !== RING_SPIN) return true;
      // (Spins are scheduled up to SCHEDULE_HORIZON_SECONDS ahead, so the clash can be with any
      // recent one, not just the last emitted.)
      if (this.recentRingSpins.some((time) => Math.abs(event.time - time) < 0.02)) return false;
      this.recentRingSpins.push(event.time);
      if (this.recentRingSpins.length > 8) this.recentRingSpins.shift();
      return true;
    });
  }

  private collectEvents(nowSec: number): GeneratedLightEvent[] {
    // Reactions that can't wait for the next beat (silence starting/ending, drums coming back).
    const events: GeneratedLightEvent[] = this.immediate.map((event) => ({ ...event, time: Math.max(event.time, nowSec) }));
    this.immediate = [];
    if (this.inGap) {
      // Keep dark through the silence: nothing new, and don't replay missed beats afterwards.
      this.pendingOnsets = [];
      this.scheduledThroughTime = Math.max(this.scheduledThroughTime, nowSec + SCHEDULE_HORIZON_SECONDS);
      return events;
    }
    const tracked = this.bpm !== null && this.beatAnchor !== null && this.confidence >= MIN_CONFIDENCE;
    const layered = this.style === 'layered' || !tracked;
    if (layered) {
      this.collectLayered(nowSec, events);
    } else {
      this.offGridAccents(nowSec, events);
      if (this.sustained) this.envelopeLayer(nowSec, events, true);
    }
    if (!tracked) return events;
    const anchor = this.beatAnchor ?? nowSec;
    const halfPeriod = this.beatPeriod / 2;
    const horizon = nowSec + SCHEDULE_HORIZON_SECONDS;
    // Half-beat steps from the anchor beat, never in the past. The beat clock keeps being nudged
    // (and re-anchored) between calls, so "already emitted" is tracked by time: a step closer than
    // ~half a step to the last emitted one is the same step seen again, not a new one.
    for (let step = Math.floor((nowSec - anchor) / halfPeriod) + 1; anchor + step * halfPeriod <= horizon; step++) {
      const time = anchor + step * halfPeriod;
      if (time <= this.scheduledThroughTime + halfPeriod * 0.6) continue;
      // In the layered style the beat clock still runs (bars, tiers, style checks), it just doesn't
      // place the lights itself.
      this.emitStep(this.anchorIndex * 2 + step, time + this.latencySeconds, events, layered);
      this.scheduledThroughTime = time;
    }
    return events;
  }

  /** Bar-level bookkeeping + the style's pattern for one half-beat step. */
  private emitStep(halfBeatIndex: number, time: number, events: GeneratedLightEvent[], bookkeepingOnly = false) {
    const onBeat = halfBeatIndex % 2 === 0;
    const beatIndex = Math.floor(halfBeatIndex / 2);
    const downbeatOffset = this.downbeatOffset();
    const beatInBar = (((beatIndex - downbeatOffset) % 4) + 4) % 4;
    const barIndex = Math.floor((beatIndex - downbeatOffset) / 4);

    if (onBeat) {
      this.beatsSinceTrackStart++;
      this.learnDownbeat(beatIndex, time);
      if (beatInBar === 0) this.startBar(barIndex, time, events);
      // A big jump in how busy the music is (drums dropping out, a drop landing) is followed on
      // the very next beat instead of waiting for the bar line plus the usual hysteresis.
      const fastTarget = tierFor(this.intensityFast);
      if (Math.abs(fastTarget - this.tier) >= 2) this.setTier(fastTarget);
    }
    // Pads/chords without percussion: the beat patterns step aside for the smooth envelope layer
    // (see collect); only a slow ring turn on bar lines keeps the scene alive.
    if (bookkeepingOnly) return;
    if (this.sustained) {
      if (onBeat && beatInBar === 0) ringSpin(events, time, this.random, 15);
      return;
    }

    const context: StepContext = {
      time,
      onBeat,
      beatInBar,
      barIndex,
      tier: this.tier,
      color: this.colorFlip ? 'red' : 'blue',
      other: this.colorFlip ? 'blue' : 'red',
      halfBeat: this.beatPeriod / 2,
      random: this.random,
      accent: this.halfBeatAccent(time),
    };
    switch (this.style) {
      case 'pulse':
        stylePulse(context, events);
        break;
      case 'pop':
        stylePop(context, events);
        break;
      case 'edm':
        styleEdm(context, events);
        break;
      case 'gradient':
        styleGradient(context, events);
        break;
      default:
        styleAmbient(context, events);
    }
  }

  private startBar(barIndex: number, time: number, events: GeneratedLightEvent[]) {
    // Intensity tier: only changes on bar lines, and only after holding for a bar (two for going
    // down), so the show breathes with the song's sections instead of every loud/quiet moment.
    // Judged on the bar's *average* intensity (moment-to-moment loudness is far too jumpy).
    const barIntensity = this.barIntensityFrames > 0 ? this.barIntensitySum / this.barIntensityFrames : this.intensity;
    this.barIntensitySum = 0;
    this.barIntensityFrames = 0;
    const target = tierFor(barIntensity);
    // Up right away; down only after two bars that both want lower (to the higher of the two).
    if (target > this.tier) {
      this.setTier(target);
      this.lowerBars = 0;
    } else if (target < this.tier) {
      this.lowerBars++;
      this.lowerTarget = this.lowerBars === 1 ? target : Math.max(this.lowerTarget, target);
      if (this.lowerBars >= 2) {
        this.setTier(this.lowerTarget);
        this.lowerBars = 0;
      }
    } else {
      this.lowerBars = 0;
    }

    // Style: decided from the sound once ~4 bars are in, and once more after ~32 bars when the
    // averages cover more than an intro — unless the player's genre tags already decided it.
    const decisionDue = this.styleDecisions === 0 ? 16 : this.styleDecisions === 1 ? 128 : Infinity;
    if (this.beatsSinceTrackStart >= decisionDue) {
      this.styleDecisions++;
      if (this.genreStyle === null) {
        const decided = this.styleFromAudio();
        if (this.style === 'layered') this.styleBeforeLayered = decided;
        else this.style = decided;
        this.styleSource = 'audio';
      }
    }
    // Every 4 bars: while the tempo keeps jumping (the grid itself can't be trusted), patterns
    // placed on it would keep changing speed and flashing between the notes — hand over to the
    // layered style, which reacts to each instrument directly; back once the tempo holds.
    if (barIndex % 4 === 0) {
      const unstable = this.tempoUnstable(time);
      if (unstable && this.style !== 'layered' && this.style !== 'ambient') {
        this.styleBeforeLayered = this.style;
        this.style = 'layered';
        this.styleSource = 'audio';
      } else if (!unstable && this.style === 'layered' && this.styleBeforeLayered !== null) {
        this.style = this.styleBeforeLayered;
        this.styleBeforeLayered = null;
      }
    }

    const phraseLength = this.style === 'ambient' ? 4 : this.style === 'pulse' ? 1 : 2;
    if (barIndex % phraseLength === 0) this.colorFlip = !this.colorFlip;

    // Boost colours for the loudest sections (maps flip boost on for choruses/drops).
    const wantBoost = this.tier === 3 && this.style !== 'ambient';
    if (wantBoost !== this.boostOn) {
      this.boostOn = wantBoost;
      events.push({ time, type: BOOST, value: wantBoost ? 1 : 0, floatValue: 1 });
    }

    if (this.dropPending) {
      this.dropPending = false;
      // A drop: everything flashes white at once, the rings zoom and spin hard.
      for (const group of [BACK, RING, LEFT, RIGHT, CENTER]) push(events, time, group, 'white', 'flash', 1.2);
      events.push({ time, type: RING_ZOOM, value: 0, floatValue: 1 });
      ringSpin(events, time, this.random, 90, 3);
    }
  }

  // ----- instruments, texture, silences ---------------------------------------------------------

  /** Per-band levels, envelopes and onsets; percussive vs sustained texture; beat-grid fit. */
  private analyseBands(audio: ArrayLike<number>, log: Float32Array, nowSec: number) {
    let totalFlux = 0;
    for (let band = 0; band < 4; band++) {
      const [from, to] = BAND_RANGES[band] ?? [0, 1];
      let level = 0;
      let flux = 0;
      for (let bin = from; bin < to; bin++) {
        level += Math.min(((audio[bin] ?? 0) + (audio[bin + 64] ?? 0)) * 0.5 * this.gain, 1.5);
        if (this.hasPrevious) flux += Math.max(0, (log[bin] ?? 0) - (this.previousLog[bin] ?? 0));
      }
      level /= to - from;
      flux /= to - from;
      totalFlux += flux;
      this.bandLevel[band] = level;
      const env = this.bandEnv[band] ?? 0;
      // Fast attack, ~0.3 s release: follows notes, smooths single frames.
      this.bandEnv[band] = env + (level - env) * (level > env ? 0.6 : 0.12);
      // Slowly sinking peak: what "full" means for this band right now.
      this.bandPeak[band] = Math.max(level, (this.bandPeak[band] ?? 0) * 0.998);
      const mean = this.bandFluxMean[band] ?? 0;
      const isOnset =
        flux > Math.max(mean * 2.2, 0.02) &&
        level > (this.bandPeak[band] ?? 0) * 0.15 &&
        nowSec - (this.bandLastOnset[band] ?? Number.NEGATIVE_INFINITY) > (BAND_REFRACTORY_SECONDS[band] ?? 0.1);
      this.bandFluxMean[band] = mean + (flux - mean) * 0.02;
      if (isOnset) {
        this.bandLastOnset[band] = nowSec;
        const strength = flux / Math.max(mean, 1e-3);
        this.pendingOnsets.push({ time: nowSec, band, strength });
        if (this.pendingOnsets.length > 64) this.pendingOnsets.shift();
        if ((band === BAND_LOW || band === BAND_MID) && strength > 2.5) this.trackStrongOnsets++;
      }
    }

    // Percussive vs sustained: short-term spectral flux against the track's own long-term level.
    this.fluxFast += (totalFlux - this.fluxFast) * 0.08;
    this.fluxSlow += (totalFlux - this.fluxSlow) * Math.max(1 / (20 * this.fps), 1 / Math.max(this.energyFrames, 1));
    this.highFast += ((this.bandLevel[BAND_HIGH] ?? 0) - this.highFast) * 0.08;
    const ratio = this.fluxFast / Math.max(this.fluxSlow, 1e-4);
    // Thresholds from Ball Pit (mcbaise): its drum-less passages sit at 0.15-0.6 of the track's
    // usual flux, the busy parts at 0.65-1.5.
    const wantSustained = this.sustained ? ratio < 0.8 : ratio < 0.6;
    if (wantSustained !== this.sustained) {
      this.textureCandidateSince ??= nowSec;
      // Into "sustained" after 0.6 s of calm, back to "percussive" after just 0.15 s of hits.
      if (nowSec - this.textureCandidateSince >= (wantSustained ? 0.6 : 0.15)) {
        this.sustained = wantSustained;
        this.textureCandidateSince = null;
        if (!wantSustained && !this.inGap) this.queuePunch(nowSec, 0.9);
      }
    } else {
      this.textureCandidateSince = null;
    }
  }

  private tempoUnstable(nowSec: number) {
    this.tempoRelocks = this.tempoRelocks.filter((time) => nowSec - time < TEMPO_UNSTABLE_WINDOW_SECONDS);
    return this.tempoRelocks.length >= 2;
  }

  /** Silence inside a track (a break, a stop, the gap before a drop): fade the lights out quickly
   *  instead of waiting seconds for the averages to notice, and come back with a hit when sound
   *  returns. Short dips between staccato notes or chopped vocals (0.1-0.3 s of near-silence, all
   *  over tracks like "For" by Sasuke Haraguchi) must *not* black out: a blink of darkness followed
   *  by a flash on every chop is just irritating. So silence only counts once it has held for
   *  GAP_CONFIRM_SECONDS, the lights then fade (not cut) out, and only a real pause gets the punch
   *  on the way back. */
  private detectGap(energy: number, nowSec: number) {
    if (!this.inGap) {
      const quiet = this.recentLevel > 1e-3 && energy < this.recentLevel * 0.12;
      if (!quiet) {
        this.gapCandidateSince = null;
        this.recentLevel += (energy - this.recentLevel) * 0.05;
        return;
      }
      this.gapCandidateSince ??= nowSec;
      if (nowSec - this.gapCandidateSince < GAP_CONFIRM_SECONDS) return;
      this.inGap = true;
      this.gapStart = this.gapCandidateSince;
      this.gapCandidateSince = null;
      this.preGapLevel = this.recentLevel;
      for (const group of [BACK, RING, LEFT, RIGHT, CENTER]) {
        this.immediate.push({ time: nowSec + GAP_FADE_SECONDS, type: group, value: VALUE_BASE.blue + KIND_OFFSET.trans, floatValue: 0 });
      }
    } else if (energy > this.preGapLevel * 0.35) {
      this.inGap = false;
      this.recentLevel = energy;
      if (nowSec - this.gapStart > GAP_PUNCH_SECONDS) this.queuePunch(nowSec, 1);
      else this.lastEnvelopeValue.fill(-1);
    } else if (nowSec - this.gapStart > 0.9 && energy > this.preGapLevel * 0.06) {
      // Not silence after all, just a much quieter passage (a filtered breakdown): leave the gap
      // quietly and let the sustained layer glow along with it.
      this.inGap = false;
      this.recentLevel = energy;
      this.lastEnvelopeValue.fill(-1);
    }
  }

  /** An immediate hit on the centre and ring lights — sound coming back after a gap, or the drums
   *  returning after a sustained passage. */
  private queuePunch(nowSec: number, strength: number) {
    const color: LightColor = this.colorFlip ? 'red' : 'blue';
    this.immediate.push({ time: nowSec, type: CENTER, value: VALUE_BASE.white + KIND_OFFSET.flash, floatValue: strength });
    this.immediate.push({ time: nowSec, type: RING, value: VALUE_BASE[color] + KIND_OFFSET.flash, floatValue: strength });
    this.lastEnvelopeValue.fill(-1);
  }

  /** In the grid styles: strong chord stabs / snares that land *between* grid steps (syncopation,
   *  3-3-2 rhythms) get their own flash on the back lasers, so the lights don't ignore the most
   *  audible part of syncopated music. Hits on the grid are already covered by the pattern. */
  private offGridAccents(nowSec: number, events: GeneratedLightEvent[]) {
    const anchor = this.beatAnchor;
    if (anchor !== null && !this.sustained) {
      const half = this.beatPeriod / 2;
      for (const onset of this.pendingOnsets) {
        if (onset.band !== BAND_MID || onset.strength < 3) continue;
        const position = (onset.time - anchor) / half;
        if (Math.abs(position - Math.round(position)) * half < 0.07) continue;
        const color: LightColor = this.colorFlip ? 'blue' : 'red';
        push(events, Math.max(onset.time + this.latencySeconds, nowSec), BACK, color, 'fade', Math.min(0.5 + 0.12 * onset.strength, 1.1));
      }
    }
    this.pendingOnsets = [];
  }

  /** "Layered" style: each instrument band drives its own light group as it plays, plus the smooth
   *  envelope layer — for music whose hits don't sit on a steady beat grid. */
  private collectLayered(nowSec: number, events: GeneratedLightEvent[]) {
    const [left, right] = this.glideLabels(nowSec);
    for (const onset of this.pendingOnsets) {
      const time = Math.max(onset.time + this.latencySeconds, nowSec);
      const strength = Math.min(0.6 + 0.15 * onset.strength, 1.2);
      if (this.sustained && onset.band !== BAND_LOW) continue;
      if (onset.band === BAND_LOW) {
        push(events, time, RING, left, 'fade', strength);
        this.kickCount++;
        if (this.kickCount % 4 === 0) ringSpin(events, time, this.random, 30);
      } else if (onset.band === BAND_MID) {
        push(events, time, BACK, right, 'fade', strength);
      } else if (onset.band === BAND_HIGH && this.intensityFast > 0.45) {
        this.hatSide = !this.hatSide;
        push(events, time, this.hatSide ? LEFT : RIGHT, this.hatSide ? left : right, 'fade', Math.min(strength, 0.8));
      }
    }
    this.pendingOnsets = [];
    if (!this.layeredLaserSpeedSet) {
      this.layeredLaserSpeedSet = true;
      laserSpeed(events, nowSec, 1, true);
    }
    this.envelopeLayer(nowSec, events, this.sustained);
  }

  /** Lights that follow the music's loudness smoothly (transitions every ~0.12 s) while their
   *  colour glides slowly between the two environment colours. Centre = the tonal body (low-mid +
   *  mid). With `all`, the other groups glow too: ring lights ← low-mid, back lasers ← mid, side
   *  lasers ← highs — used for sustained passages, where nothing else is happening. */
  private envelopeLayer(nowSec: number, events: GeneratedLightEvent[], all: boolean) {
    if (nowSec < this.nextEnvelopeTime) return;
    this.nextEnvelopeTime = nowSec + ENVELOPE_STEP_SECONDS;
    const norm = (band: number) => clamp01((this.bandEnv[band] ?? 0) / Math.max(this.bandPeak[band] ?? 0, 1e-3));
    const body = Math.max(norm(BAND_LOWMID), norm(BAND_MID));
    const time = nowSec + ENVELOPE_STEP_SECONDS;
    const [leftColor, rightColor] = this.glideColors(nowSec);
    const targets: [number, number, Rgb][] = [[CENTER, 0.1 + 0.9 * body, leftColor]];
    if (all) {
      targets.push([RING, 0.05 + 0.7 * norm(BAND_LOWMID), rightColor]);
      targets.push([BACK, 0.05 + 0.6 * norm(BAND_MID), leftColor]);
      targets.push([LEFT, 0.6 * norm(BAND_HIGH), rightColor]);
      targets.push([RIGHT, 0.6 * norm(BAND_HIGH), rightColor]);
    }
    for (const [type, level, color] of targets) {
      // Skip tiny changes: fewer events, and the transition in flight already heads there.
      if (Math.abs(level - (this.lastEnvelopeValue[type] ?? -1)) < 0.04) continue;
      this.lastEnvelopeValue[type] = level;
      events.push({
        time,
        type,
        value: VALUE_BASE.blue + KIND_OFFSET.trans,
        floatValue: level,
        customData: { color: [color[0], color[1], color[2], 1] },
      });
    }
  }

  /** The two environment colours, slowly rotating into each other (HSV mix) — the smooth
   *  "colour to colour" drift of the envelope layer. */
  private glideColors(nowSec: number): [Rgb, Rgb] {
    const colors = this.colorProvider?.() ?? { left: [1, 0, 0] as Rgb, right: [0, 0.28, 1] as Rgb };
    const mix = 0.5 - 0.5 * Math.cos((2 * Math.PI * nowSec) / GLIDE_PERIOD_SECONDS);
    return [mixHsv(colors.left, colors.right, mix), mixHsv(colors.right, colors.left, mix)];
  }

  /** Same idea for classic (non-RGB) events: which side's colour each role uses right now. */
  private glideLabels(nowSec: number): [LightColor, LightColor] {
    const phase = Math.floor(nowSec / (GLIDE_PERIOD_SECONDS / 2)) % 2 === 0;
    return phase ? ['red', 'blue'] : ['blue', 'red'];
  }

  private setTier(tier: number) {
    this.previousTier = this.tier;
    this.tier = tier;
    if (this.tier - this.previousTier >= 2) this.dropPending = true;
  }

  /** Downbeat = the beat position (mod 4) that most consistently carries the strongest bass hit. */
  private learnDownbeat(beatIndex: number, time: number) {
    const frame = this.frameAt(time - this.latencySeconds);
    if (frame === null) return;
    let low = 0;
    for (let offset = -1; offset <= 1; offset++) low += this.lowOnset[(frame + offset + this.capacity) % this.capacity] ?? 0;
    const position = ((beatIndex % 4) + 4) % 4;
    for (let index = 0; index < 4; index++) this.downbeatScore[index] = (this.downbeatScore[index] ?? 0) * 0.97;
    this.downbeatScore[position] = (this.downbeatScore[position] ?? 0) + low;
  }

  private downbeatOffset() {
    let best = 0;
    for (let index = 1; index < 4; index++) if ((this.downbeatScore[index] ?? 0) > (this.downbeatScore[best] ?? 0)) best = index;
    return best;
  }

  /** Ring-buffer slot of the most recent frame at or before `time` (null if not in history). */
  private frameAt(time: number): number | null {
    const count = Math.min(this.frames, this.capacity);
    for (let back = 0; back < count; back++) {
      const slot = (this.frames - 1 - back + this.capacity) % this.capacity;
      if ((this.frameTime[slot] ?? 0) <= time) return slot;
    }
    return null;
  }

  /** Whether the audio right around the previous half-beat had a clear onset — the only way raw
   *  onsets steer the grid: they unlock optional half-beat accents in the busier tiers. */
  private halfBeatAccent(time: number): boolean {
    const frame = this.frameAt(time - this.beatPeriod - this.latencySeconds);
    if (frame === null) return false;
    const value = Math.max(
      this.onset[frame] ?? 0,
      this.onset[(frame + 1) % this.capacity] ?? 0,
      this.onset[(frame - 1 + this.capacity) % this.capacity] ?? 0,
    );
    return value > this.onsetMean * 1.8;
  }

  /** Averages over the track so far: bass/treble share of the spectrum, and loudness dynamics
   *  (90th/10th percentile ratio — compressed rock/funk sits around 3, pop/ambient 5+). */
  private trackCharacter() {
    const frames = Math.max(this.trackActiveFrames, 1);
    const sorted = [...this.trackEnergies].sort((a, b) => a - b);
    const quantile = (q: number) => sorted[Math.floor(q * (sorted.length - 1))] ?? 0;
    return {
      lowShare: this.trackLowShare / frames,
      highShare: this.trackHighShare / frames,
      dynamics: sorted.length > 0 ? quantile(0.9) / Math.max(quantile(0.1), 1e-3) : 1,
      // Strong bass/mid hits per second of actual sound.
      hitRate: this.trackStrongOnsets / Math.max(this.trackActiveFrames / this.fps, 1),
    };
  }

  /** Calibrated on the reference songs (as spectra like Wallpaper Engine's): ambient has almost
   *  nothing in the treble (~4% vs 9-13%); EDM is bass-heavy (~40% of the spectrum in the lowest
   *  bins vs 20-25%); rock is fast and compressed (dynamics < 3.5); funk/groove is mid-tempo and
   *  compressed; everything else lights best as pop. */
  private styleFromAudio(): LightStyle {
    const bpm = this.bpm ?? 120;
    const { lowShare, highShare, dynamics } = this.trackCharacter();
    // (0.045: the ambient reference sits at 0.035, darker-but-busy electronic like Ball Pit at 0.048.)
    // A slow tempo reading alone is not a reason: syncopated tracks (Ball Pit's 3-3-2 groove) are
    // often read at half speed for a while, and a busy song lit as ambient looks dead.
    if (highShare < 0.045 || this.confidence < MIN_CONFIDENCE * 1.1) return 'ambient';
    if (lowShare > 0.33) return 'edm';
    if (bpm >= 150 && dynamics < 3.5) return 'pulse';
    if (bpm >= 100 && bpm <= 135 && dynamics < 3.8) return 'gradient';
    return 'pop';
  }
}

function isMetricallyRelated(a: number, b: number) {
  const ratio = a / b;
  return [0.5, 2, 2 / 3, 1.5, 0.75, 4 / 3, 1 / 3, 3].some((simple) => Math.abs(ratio / simple - 1) < 0.04);
}

function tierFor(intensity: number) {
  return intensity < 0.3 ? 0 : intensity < 0.55 ? 1 : intensity < 0.78 ? 2 : 3;
}

function rgbToHsv([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return [((hue * 60) + 360) % 360, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb([h, s, v]: [number, number, number]): Rgb {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Colour mix along the hue wheel (the short way round), so halfway between red and blue is a
 *  saturated purple rather than a murky grey. */
function mixHsv(from: Rgb, to: Rgb, t: number): Rgb {
  const a = rgbToHsv(from);
  const b = rgbToHsv(to);
  let dh = b[0] - a[0];
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return hsvToRgb([(a[0] + dh * t + 360) % 360, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

// ----- style patterns -------------------------------------------------------------------------------

interface StepContext {
  time: number;
  onBeat: boolean;
  beatInBar: number;
  barIndex: number;
  tier: number;
  color: LightColor;
  other: LightColor;
  halfBeat: number;
  random: () => number;
  accent: boolean;
}

function push(
  events: GeneratedLightEvent[],
  time: number,
  type: number,
  color: LightColor,
  kind: LightKind,
  floatValue = 1,
) {
  events.push({ time, type, value: VALUE_BASE[color] + KIND_OFFSET[kind], floatValue });
}

function off(events: GeneratedLightEvent[], time: number, type: number) {
  events.push({ time, type, value: 0, floatValue: 0 });
}

/** A ring spin with explicit parameters — explicit so it's deterministic (the screensaver's event
 *  trimming relies on that to keep ring angles continuous; see trimListenEvents in main.ts). */
function ringSpin(events: GeneratedLightEvent[], time: number, random: () => number, rotation = 45, count = 1) {
  const direction = random() < 0.5 ? 0 : 1;
  for (let index = 0; index < count; index++) {
    events.push({
      time: time + index * 0.03,
      type: RING_SPIN,
      value: 0,
      floatValue: 1,
      customData: { rotation, step: 5 + Math.round(random() * 10), direction },
    });
  }
}

/** Laser speed + the classic "same speed twice" retrigger that re-randomises their angles. */
function laserSpeed(events: GeneratedLightEvent[], time: number, speed: number, retrigger: boolean) {
  for (const type of [LEFT_SPEED, RIGHT_SPEED]) {
    events.push({ time, type, value: speed, floatValue: 1 });
    if (retrigger && speed > 0) events.push({ time: time + 0.02, type, value: speed, floatValue: 1 });
  }
}

/** Rock-style (Cicada): every group fades on the beat, one colour per bar, rings every bar. */
function stylePulse(c: StepContext, events: GeneratedLightEvent[]) {
  const { time, tier, color } = c;
  if (c.onBeat) {
    const strong = c.beatInBar === 0 || c.beatInBar === 2;
    if (tier === 0) {
      if (strong) push(events, time, RING, color, 'fade');
      if (c.beatInBar === 0) push(events, time, CENTER, color, 'fade');
    } else {
      push(events, time, RING, color, 'fade');
      push(events, time, CENTER, color, 'fade');
      push(events, time, BACK, color, 'fade');
      if (tier >= 2 || strong) {
        push(events, time, LEFT, color, 'fade');
        push(events, time, RIGHT, color, 'fade');
      }
    }
    if (c.beatInBar === 0) {
      if (tier >= 1) ringSpin(events, time, c.random);
      if (tier >= 1 && c.barIndex % 2 === 0) events.push({ time, type: RING_ZOOM, value: 0, floatValue: 1 });
      laserSpeed(events, time, [2, 3, 5, 7][tier] ?? 3, true);
    } else if (c.beatInBar === 2 && tier === 3) {
      ringSpin(events, time, c.random);
    }
  } else if (tier >= 2 && c.accent) {
    push(events, time, BACK, color, 'fade');
    if (tier === 3) push(events, time, c.beatInBar % 2 === 0 ? LEFT : RIGHT, color, 'fade');
  }
}

/** Pop-style (Spoken For): groups spread over 1/3 vs 2/4 and off-beats, flashes, white accents. */
function stylePop(c: StepContext, events: GeneratedLightEvent[]) {
  const { time, tier, color, other } = c;
  if (c.onBeat) {
    const oneThree = c.beatInBar === 0 || c.beatInBar === 2;
    if (tier >= 1 && oneThree) {
      push(events, time, LEFT, color, 'flash');
      push(events, time, RIGHT, color, 'flash');
    }
    if (tier >= 1 && !oneThree) push(events, time, RING, other, 'flash');
    if (tier === 0 ? oneThree : true) push(events, time, CENTER, tier >= 2 ? other : color, tier >= 2 ? 'flash' : 'fade');
    if (tier === 3 && !oneThree) push(events, time, c.beatInBar === 1 ? LEFT : RIGHT, other, 'flash');
    if (tier >= 2 && c.beatInBar === 0 && c.barIndex % 2 === 0) push(events, time, CENTER, 'white', 'flash', 1.2);
    // Rings: every beat when it's busy, every other beat otherwise.
    if (tier >= 2 || (tier === 1 && oneThree)) ringSpin(events, time, c.random, 30);
    if (oneThree) laserSpeed(events, time, tier >= 2 ? 2 + Math.round(c.random() * 2) : 1, c.beatInBar === 0);
  } else if (tier >= 1 || c.beatInBar === 1 || c.beatInBar === 3) {
    // Off-beat back lasers: the signature of this style.
    push(events, time, BACK, color, 'fade');
  }
}

/** EDM-style (Idol): fades with lots of white, kick-driven centre, alternating side lasers,
 *  ring spin sweeps in the loudest parts. */
function styleEdm(c: StepContext, events: GeneratedLightEvent[]) {
  const { time, tier, color, other } = c;
  const white = (fallback: LightColor) => (c.random() < 0.3 ? 'white' : fallback);
  if (c.onBeat) {
    push(events, time, CENTER, color, 'fade');
    if (tier >= 1) push(events, time, RING, white(other), 'fade');
    if (tier >= 1 && (c.beatInBar === 0 || c.beatInBar === 2)) push(events, time, BACK, color, 'fade');
    if (tier >= 2) push(events, time, LEFT, white(color), 'fade');
    if (tier >= 2 && (c.beatInBar === 1 || c.beatInBar === 3)) push(events, time, BACK, 'white', 'fade');
    if (tier === 3) ringSpin(events, time, c.random, 20, 3);
    else if (tier >= 1 && c.beatInBar === 0) ringSpin(events, time, c.random, 45);
    if (c.beatInBar % 2 === 0) laserSpeed(events, time, tier === 3 ? 3 : 1 + (tier >= 2 ? 1 : 0), c.beatInBar === 0);
    if (tier === 0 && c.beatInBar === 0) off(events, time, LEFT);
  } else {
    if (tier >= 1) push(events, time, BACK, other, 'fade', 0.8);
    if (tier >= 2) push(events, time, RIGHT, white(other), 'fade');
    if (tier === 3) {
      push(events, time, BACK, other, 'fade');
      push(events, time, RING, color, 'fade');
    }
  }
}

/** Funk/groove-style (Funk Off): "on" on the beat + a "transition" down after it = pumping
 *  gradients; side lasers strobe on quarters when it's busy. */
function styleGradient(c: StepContext, events: GeneratedLightEvent[]) {
  const { time, tier, color, other } = c;
  const peak = [0.6, 0.9, 1, 1.2][tier] ?? 1;
  const trough = [0.15, 0.2, 0.3, 0.4][tier] ?? 0.3;
  if (c.onBeat) {
    push(events, time, CENTER, color, 'on', peak);
    push(events, time, RING, other, 'on', peak);
    if (tier >= 1) {
      push(events, time, BACK, color, 'on', peak * 0.9);
      push(events, time, LEFT, color, 'on', tier >= 2 ? 1 : 0.7);
      push(events, time, RIGHT, other, 'on', tier >= 2 ? 1 : 0.7);
    }
    if (c.beatInBar % 2 === 0 && tier >= 1) ringSpin(events, time, c.random, 30);
    if (c.beatInBar === 0 && c.barIndex % 8 === 0) events.push({ time, type: RING_ZOOM, value: 0, floatValue: 1 });
    if (tier >= 2 || c.beatInBar === 0) laserSpeed(events, time, 3 + tier, c.beatInBar === 0);
  } else {
    // Ease every lit group down to a glow before the next beat.
    push(events, time, CENTER, color, 'trans', trough);
    push(events, time, RING, other, 'trans', trough);
    if (tier >= 1) push(events, time, BACK, color, 'trans', trough);
    if (tier >= 1) {
      if (tier === 3) {
        off(events, time, LEFT);
        off(events, time, RIGHT);
        push(events, time + c.halfBeat / 2, LEFT, other, 'on');
        push(events, time + c.halfBeat / 2, RIGHT, color, 'on');
      } else {
        push(events, time, LEFT, color, 'trans', trough);
        push(events, time, RIGHT, other, 'trans', trough);
      }
    }
  }
}

/** Ambient-style (Lunar Carver): long, sparse transitions; colour turns every 4 bars; lasers dark. */
function styleAmbient(c: StepContext, events: GeneratedLightEvent[]) {
  const { time, tier, color, other } = c;
  if (!c.onBeat) return;
  const level = 0.3 + 0.2 * tier;
  if (c.beatInBar === 0) {
    const rise = c.barIndex % 2 === 0;
    push(events, time, RING, color, 'trans', rise ? level + 0.3 : level * 0.5);
    push(events, time, BACK, other, 'trans', rise ? level * 0.5 : level + 0.2);
    if (c.barIndex % 4 === 0) {
      ringSpin(events, time, c.random, 20);
      laserSpeed(events, time, 0, false);
      off(events, time, LEFT);
      off(events, time, RIGHT);
    }
  }
  if (c.beatInBar === 0 || (tier >= 2 && c.beatInBar === 2)) {
    push(events, time, CENTER, c.beatInBar === 0 ? color : other, 'trans', level + 0.2 * c.random());
  }
}
