import type { Rgb } from '../core/colors';

/**
 * Random but harmonious light colors for the screensaver ("listen") mode's generated show.
 *
 * Picking two random RGB colors mostly produces a mess — muddy pairs, one side glaring and the
 * other barely visible, or two near-identical hues where left/right lights can't be told apart. So
 * instead of picking colors freely, this picks them the way a designer would, then checks them:
 *
 * 1. The two hues follow a classic color-wheel harmony relative to each other — complementary
 *    (180°), split-complementary (150°/210°), triadic (120°/240°) or tetradic (90°/270°) — with a
 *    little jitter so it doesn't feel mechanical.
 * 2. Both are built in OKLCH, a perceptual color space, at the same lightness. In plain HSV a
 *    "fully saturated" blue is far darker than a "fully saturated" yellow, which is exactly what
 *    makes random pairs look unbalanced; equal OKLCH lightness means both sides read as equally
 *    bright.
 * 3. The pair is validated: no murky olive/mustard hues, both colors must stay vivid after fitting
 *    into the displayable (sRGB) range, they must be clearly different hues, and the new palette
 *    must not be too close to the
 *    previous one (otherwise a "change" on track switch could look like nothing happened).
 *    Candidates that fail are thrown away and a new one is tried; after enough failures it falls
 *    back to the classic red/blue.
 */

interface Oklch {
  l: number;
  c: number;
  h: number; // degrees
}

const LIGHTNESS = 0.66;
const TARGET_CHROMA = 0.25;
const MAX_CHROMA_RATIO = 1.4;
const MIN_CHROMA = 0.1;
const MIN_HUE_SEPARATION = 60;
const MIN_DISTANCE_FROM_PREVIOUS = 40;
const MAX_ATTEMPTS = 60;

// Hue offsets (degrees) of the second color relative to the first, each a classic harmony.
const HARMONY_OFFSETS = [180, 150, 210, 120, 240, 90, 270] as const;
const HUE_JITTER = 10;

export interface LightPalette {
  left: Rgb;
  right: Rgb;
  /** OKLCH hue of the left color — pass back in as `previous` so the next palette differs. */
  leftHue: number;
  rightHue: number;
}

// Yellows at the shared lightness come out as mustard/olive/khaki — at equal perceived brightness
// they simply can't be vivid, and next to a clean second color they read as dirty.
const MURKY_HUE_MIN = 88;
const MURKY_HUE_MAX = 128;

function isMurkyHue(hue: number): boolean {
  return hue >= MURKY_HUE_MIN && hue <= MURKY_HUE_MAX;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

function linearToSrgb(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** OKLCH → linear sRGB (Björn Ottosson's OKLab matrices). May be out of [0,1] = out of gamut. */
function oklchToLinearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function inGamut(rgb: readonly number[]): boolean {
  return rgb.every((channel) => channel >= -1e-4 && channel <= 1 + 1e-4);
}

/** Highest chroma (up to TARGET_CHROMA) at which this lightness/hue is still displayable. */
function fitChroma(l: number, h: number): number {
  let low = 0;
  let high = TARGET_CHROMA;
  if (inGamut(oklchToLinearSrgb({ l, c: high, h }))) return high;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    if (inGamut(oklchToLinearSrgb({ l, c: mid, h }))) low = mid;
    else high = mid;
  }
  return low;
}

function toSrgb(color: Oklch): [number, number, number] {
  const linear = oklchToLinearSrgb(color);
  return [
    linearToSrgb(Math.min(Math.max(linear[0], 0), 1)),
    linearToSrgb(Math.min(Math.max(linear[1], 0), 1)),
    linearToSrgb(Math.min(Math.max(linear[2], 0), 1)),
  ];
}

const FALLBACK: LightPalette = { left: [1, 0, 0], right: [0, 0.282353, 1], leftHue: 29, rightHue: 264 };

export function randomHarmoniousPalette(previous: LightPalette | null, random: () => number = Math.random): LightPalette {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const leftHue = random() * 360;
    const offset = HARMONY_OFFSETS[Math.floor(random() * HARMONY_OFFSETS.length)] ?? 180;
    const rightHue = (leftHue + offset + (random() * 2 - 1) * HUE_JITTER + 360) % 360;

    // Validation, see the module comment.
    if (isMurkyHue(leftHue) || isMurkyHue(rightHue)) continue;
    if (hueDistance(leftHue, rightHue) < MIN_HUE_SEPARATION) continue;
    if (
      previous !== null &&
      hueDistance(leftHue, previous.leftHue) < MIN_DISTANCE_FROM_PREVIOUS &&
      hueDistance(rightHue, previous.rightHue) < MIN_DISTANCE_FROM_PREVIOUS
    ) {
      continue;
    }
    // Each side goes as vivid as it can, but at most MAX_CHROMA_RATIO times the other one, so
    // neither looks washed-out next to the other.
    const leftFit = fitChroma(LIGHTNESS, leftHue);
    const rightFit = fitChroma(LIGHTNESS, rightHue);
    if (Math.min(leftFit, rightFit) < MIN_CHROMA) continue;
    const cap = Math.min(leftFit, rightFit) * MAX_CHROMA_RATIO;

    const left = toSrgb({ l: LIGHTNESS, c: Math.min(leftFit, cap), h: leftHue });
    const right = toSrgb({ l: LIGHTNESS, c: Math.min(rightFit, cap), h: rightHue });
    // Lights look best at full intensity: scale both by the same factor so the brightest channel of
    // the pair reaches 1 — same factor keeps the two sides balanced against each other.
    const scale = 1 / Math.max(...left, ...right);
    return {
      left: left.map((channel) => channel * scale) as unknown as Rgb,
      right: right.map((channel) => channel * scale) as unknown as Rgb,
      leftHue,
      rightHue,
    };
  }
  return FALLBACK;
}
