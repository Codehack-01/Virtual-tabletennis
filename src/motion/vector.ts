export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export interface TimedSample {
  t: number;
  p: Vec3;
}

/**
 * Least-squares velocity (units/s) over a set of timed samples.
 * Fitting a line is less noisy than differencing the last two frames.
 */
export function regressionVelocity(samples: TimedSample[]): Vec3 {
  const n = samples.length;
  if (n < 2) return { ...ZERO };
  let mt = 0;
  const m = vec();
  for (const s of samples) {
    mt += s.t;
    m.x += s.p.x;
    m.y += s.p.y;
    m.z += s.p.z;
  }
  mt /= n;
  m.x /= n;
  m.y /= n;
  m.z /= n;
  let den = 0;
  const num = vec();
  for (const s of samples) {
    const dt = s.t - mt;
    den += dt * dt;
    num.x += dt * (s.p.x - m.x);
    num.y += dt * (s.p.y - m.y);
    num.z += dt * (s.p.z - m.z);
  }
  if (den === 0) return { ...ZERO };
  // samples are in ms → convert slope to per-second
  return { x: (num.x / den) * 1000, y: (num.y / den) * 1000, z: (num.z / den) * 1000 };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export type DirectionLabel = 'still' | 'left' | 'right' | 'up' | 'down' | 'forward' | 'back';

/** Coarse direction name of a control-space velocity (x right, y up, z forward). */
export function directionLabel(v: Vec3, stillSpeed: number, includeDepth: boolean): DirectionLabel {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = includeDepth ? Math.abs(v.z) : 0;
  if (Math.max(ax, ay, az) < stillSpeed) return 'still';
  if (az > ax && az > ay) return v.z > 0 ? 'forward' : 'back';
  if (ax >= ay) return v.x > 0 ? 'right' : 'left';
  return v.y > 0 ? 'up' : 'down';
}
