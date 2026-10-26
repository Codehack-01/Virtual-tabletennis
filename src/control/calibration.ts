import type { ReferenceFrame } from '../config';
import { percentile, type Vec3 } from '../motion/vector';

/** All values in control-space units (image heights). Ranges are positive distances from neutral. */
export interface Calibration {
  frame: ReferenceFrame;
  neutral: Vec3;
  /** Stable raw body measurements captured after tracker warm-up. */
  neutralFaceScale: number;
  neutralTorsoScale: number;
  range: { left: number; right: number; down: number; up: number; back: number; forward: number };
  neutralSet: boolean;
  rangeSet: boolean;
}

const MIN_RANGE = 0.06;

export function defaultCalibration(frame: ReferenceFrame): Calibration {
  return {
    frame,
    // camera: screen centre. body: a bit below the shoulder line (roughly elbow height).
    neutral: frame === 'camera' ? { x: 0, y: 0, z: 0 } : { x: 0, y: -0.2, z: 0 },
    neutralFaceScale: 0,
    neutralTorsoScale: 0,
    range: { left: 0.45, right: 0.45, down: 0.3, up: 0.3, back: 0.15, forward: 0.15 },
    neutralSet: false,
    rangeSet: false,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Map a control-space point to -1..1 per axis (0 = neutral, ±1 = edge of calibrated range). */
export function normalize(p: Vec3, cal: Calibration, gain = 1, limit = 1.15): Vec3 {
  const dx = p.x - cal.neutral.x;
  const dy = p.y - cal.neutral.y;
  const dz = p.z - cal.neutral.z;
  const { range } = cal;
  return {
    x: clamp((gain * dx) / (dx >= 0 ? range.right : range.left), -limit, limit),
    y: clamp((gain * dy) / (dy >= 0 ? range.up : range.down), -limit, limit),
    z: clamp((gain * dz) / (dz >= 0 ? range.forward : range.back), -limit, limit),
  };
}

export interface NeutralResult {
  neutral: Vec3;
  /** Standard deviation of the samples (image heights) — how still the user was. */
  spread: number;
}

export function computeNeutral(samples: Vec3[]): NeutralResult {
  const neutral = {
    x: percentile(samples.map((s) => s.x), 0.5),
    y: percentile(samples.map((s) => s.y), 0.5),
    z: percentile(samples.map((s) => s.z), 0.5),
  };
  const variance = samples.reduce((acc, s) => acc + (s.x - neutral.x) ** 2 + (s.y - neutral.y) ** 2, 0) / Math.max(1, samples.length);
  return { neutral, spread: Math.sqrt(variance) };
}

export interface RangeResult {
  range: Calibration['range'];
  warnings: string[];
}

/**
 * Uses the 3rd/97th percentiles rather than min/max so a single glitchy frame
 * can't blow up the range. A side the user barely reached mirrors the other side.
 */
export function computeRange(samples: Vec3[], neutral: Vec3, fallback: Calibration['range']): RangeResult {
  const warnings: string[] = [];
  const axis = (key: 'x' | 'y' | 'z', neg: string, pos: string, fbNeg: number, fbPos: number) => {
    const vals = samples.map((s) => s[key]);
    let lo = neutral[key] - percentile(vals, 0.03);
    let hi = percentile(vals, 0.97) - neutral[key];
    if (lo < MIN_RANGE && hi < MIN_RANGE) {
      warnings.push(`Very little ${neg}/${pos} movement detected; kept previous ${neg}/${pos} range.`);
      return [fbNeg, fbPos];
    }
    if (lo < MIN_RANGE) {
      warnings.push(`Barely moved ${neg}; mirrored the ${pos} range.`);
      lo = hi;
    }
    if (hi < MIN_RANGE) {
      warnings.push(`Barely moved ${pos}; mirrored the ${neg} range.`);
      hi = lo;
    }
    return [lo, hi];
  };
  const [left, right] = axis('x', 'left', 'right', fallback.left, fallback.right);
  const [down, up] = axis('y', 'down', 'up', fallback.down, fallback.up);
  const zVals = samples.map((s) => s.z);
  // Depth is noisy and optional; only accept it if there was real movement.
  const zBack = Math.max(MIN_RANGE, neutral.z - percentile(zVals, 0.03));
  const zFwd = Math.max(MIN_RANGE, percentile(zVals, 0.97) - neutral.z);
  return { range: { left, right, down, up, back: zBack, forward: zFwd }, warnings };
}

/** Fraction of the camera picture kept clear at each edge (see fitRangeToFrame). */
export const FRAME_EDGE_MARGIN = 0.12;
const MIN_FITTED_RANGE = 0.2;

/**
 * Tracking is worst at the edge of the camera picture: the hand (and paddle) is
 * partly cut off, landmarks guess and jump, and it's easy to leave the frame.
 * Shrink each side's range, if needed, so the paddle's full reach (normalized
 * `limit`) is reached with the wrist still `margin` inside the picture. Wherever
 * the player stands, the ends of the paddle zone never need the frame edge, and
 * the unreliable edge strip only ever maps onto the clamped end of the reach.
 */
export function fitRangeToFrame(
  cal: Calibration,
  view: { aspect: number; reference: { x: number; y: number } },
  limit = 1.15,
  margin = FRAME_EDGE_MARGIN,
): Calibration['range'] {
  const leftEdge = (margin - view.reference.x) * view.aspect;
  const rightEdge = (1 - margin - view.reference.x) * view.aspect;
  const topEdge = view.reference.y - margin;
  const bottomEdge = view.reference.y - (1 - margin);
  const fit = (configured: number, available: number) =>
    Math.max(MIN_FITTED_RANGE, Math.min(configured, available / limit));
  const { neutral, range } = cal;
  return {
    ...range,
    left: fit(range.left, neutral.x - leftEdge),
    right: fit(range.right, rightEdge - neutral.x),
    up: fit(range.up, topEdge - neutral.y),
    down: fit(range.down, neutral.y - bottomEdge),
  };
}
