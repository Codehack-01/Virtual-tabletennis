import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../config';
import { computeNeutral, computeRange, defaultCalibration, normalize } from '../control/calibration';
import type { ArmObservation, Landmark } from '../tracking/types';
import { MotionEstimator } from './motionEstimator';
import { OneEuroFilter } from './oneEuroFilter';
import { percentile, regressionVelocity } from './vector';

const FRAME_MS = 1000 / 30;

// Deterministic pseudo-random noise
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647 - 0.5) * 2;
  };
}

describe('OneEuroFilter', () => {
  it('reduces jitter on a still signal', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 6, dCutoff: 1 });
    const rnd = noise(1);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 120; i++) {
      const v = 0.5 + rnd() * 0.005;
      raw.push(v);
      out.push(f.filter([v], i * FRAME_MS)[0]);
    }
    const std = (a: number[]) => {
      const tail = a.slice(30);
      const m = tail.reduce((x, y) => x + y, 0) / tail.length;
      return Math.sqrt(tail.reduce((x, y) => x + (y - m) ** 2, 0) / tail.length);
    };
    expect(std(out)).toBeLessThan(std(raw) * 0.5);
  });

  it('tracks a fast movement with little lag when beta is high', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 6, dCutoff: 1 });
    // 2 frame-heights/s ramp, a brisk swing
    let last = 0;
    let truth = 0;
    for (let i = 0; i < 15; i++) {
      truth = i * FRAME_MS * 0.002;
      last = f.filter([truth], i * FRAME_MS)[0];
    }
    // lag in time = (truth - last) / speed
    const lagMs = (truth - last) / 0.002;
    expect(lagMs).toBeLessThan(40);
  });
});

describe('regressionVelocity', () => {
  it('recovers a constant velocity', () => {
    const samples = [0, 1, 2, 3].map((i) => ({ t: i * FRAME_MS, p: { x: i * FRAME_MS * 0.003, y: -i * FRAME_MS * 0.001, z: 0 } }));
    const v = regressionVelocity(samples);
    expect(v.x).toBeCloseTo(3, 5);
    expect(v.y).toBeCloseTo(-1, 5);
  });
});

const lm = (x: number, y: number, visibility = 0.99): Landmark => ({ x, y, z: 0, visibility });

function obs(t: number, wrist: Landmark | null): ArmObservation {
  return {
    timestamp: t,
    aspect: 4 / 3,
    wrist,
    elbow: lm(0.6, 0.6),
    shoulder: lm(0.6, 0.35),
    otherShoulder: lm(0.4, 0.35),
    hip: lm(0.57, 0.68),
    otherHip: lm(0.43, 0.68),
    leftEye: lm(0.47, 0.2),
    rightEye: lm(0.53, 0.2),
    index: null,
    pinky: null,
  };
}

describe('MotionEstimator', () => {
  it('holds the paddle when the hand leaves the picture at the side', () => {
    const settings = { ...DEFAULT_SETTINGS, holdMs: 250 };
    const m = new MotionEstimator();
    let t = 0;
    for (let i = 0; i < 6; i++, t += FRAME_MS) m.update(obs(t, lm(0.93, 0.55)), settings);
    // Hand goes out of frame; body (shoulders) still clearly visible.
    for (; t < 1000; t += FRAME_MS) m.update(obs(t, lm(1.05, 0.55, 0.05)), settings);
    expect(m.state.status).toBe('holding');
    for (; t < 2000; t += FRAME_MS) m.update(obs(t, lm(1.05, 0.55, 0.05)), settings);
    expect(m.state.status).toBe('lost');
  });

  it('still reports a loss promptly when the hand vanishes mid-picture', () => {
    const settings = { ...DEFAULT_SETTINGS, holdMs: 250 };
    const m = new MotionEstimator();
    let t = 0;
    for (let i = 0; i < 6; i++, t += FRAME_MS) m.update(obs(t, lm(0.5, 0.55)), settings);
    for (; t < 500; t += FRAME_MS) m.update(obs(t, null), settings);
    expect(m.state.status).toBe('lost');
  });

  const settings: Settings = { ...DEFAULT_SETTINGS, holdMs: 200 };

  it('converts to control space: x right, y up, origin at image centre', () => {
    const m = new MotionEstimator();
    const s = m.update(obs(0, lm(0.75, 0.25)), settings);
    expect(s.status).toBe('tracking');
    expect(s.rawPosition.x).toBeCloseTo(0.25 * (4 / 3));
    expect(s.rawPosition.y).toBeCloseTo(0.25);
  });

  it('accepts the lower-confidence wrist of a bent ready arm when elbow and shoulder are visible', () => {
    const m = new MotionEstimator();
    const s = m.update(obs(0, lm(0.58, 0.52, 0.35)), settings);
    expect(s.status).toBe('tracking');
    expect(s.acceptedThisFrame).toBe(true);
    expect(s.armOffsets).not.toBeNull();
    expect(s.armOffsets!.elbow.x).toBeGreaterThan(0);
    expect(s.armOffsets!.shoulder.y).toBeGreaterThan(0);
    expect(s.rawArmOffsets).not.toBeNull();
    expect(s.rawArmOffsets!.elbow.x).toBeGreaterThan(0);
  });

  it('keeps tracking through a small wrist-confidence dip when the arm remains visible', () => {
    const m = new MotionEstimator();
    m.update(obs(0, lm(0.58, 0.52, 0.9)), settings);
    const s = m.update(obs(FRAME_MS, lm(0.6, 0.5, 0.22)), settings);
    expect(s.status).toBe('tracking');
    expect(s.acceptedThisFrame).toBe(true);
  });

  it('tracks the palm centre relative to the wrist', () => {
    const m = new MotionEstimator();
    const frame = obs(0, lm(0.58, 0.52));
    frame.index = lm(0.54, 0.49);
    frame.pinky = lm(0.56, 0.5);
    const s = m.update(frame, settings);
    expect(s.handOffset).not.toBeNull();
    expect(s.handOffset!.x).toBeLessThan(0);
    expect(s.handOffset!.y).toBeGreaterThan(0);
  });

  it('does not change body distance when only the playing arm moves', () => {
    const m = new MotionEstimator();
    const ready = m.update(obs(0, lm(0.58, 0.52)), settings);
    const readyFaceScale = ready.faceScale;
    const readyTorsoScale = ready.torsoScale;
    const extended = m.update(obs(FRAME_MS, lm(0.95, 0.3)), settings);
    expect(readyFaceScale).toBeGreaterThan(0);
    expect(extended.faceScale).toBeCloseTo(readyFaceScale, 8);
    expect(extended.torsoScale).toBeCloseTo(readyTorsoScale, 8);
  });

  it('rejects a torso landmark glitch when face scale does not agree', () => {
    const m = new MotionEstimator();
    const first = obs(0, lm(0.58, 0.52));
    const baseline = m.update(first, settings);
    const baselineFace = baseline.faceScale;
    const baselineTorso = baseline.torsoScale;
    const glitched = obs(FRAME_MS, lm(0.58, 0.52));
    glitched.hip = lm(0.59, 0.5);
    glitched.otherHip = lm(0.41, 0.5);
    const result = m.update(glitched, settings);
    expect(result.faceScale).toBeCloseTo(baselineFace, 8);
    expect(result.torsoScale).not.toBeCloseTo(baselineTorso, 4);
  });

  it('accepts a real step back when face and torso both become smaller', () => {
    const m = new MotionEstimator();
    const baseline = m.update(obs(0, lm(0.58, 0.52)), settings);
    const baselineFace = baseline.faceScale;
    const baselineTorso = baseline.torsoScale;
    let result = m.state;
    for (let i = 1; i <= 12; i++) {
      const farther = obs(i * FRAME_MS, lm(0.58, 0.52));
      farther.leftEye = lm(0.48, 0.22);
      farther.rightEye = lm(0.52, 0.22);
      farther.shoulder = lm(0.57, 0.38);
      farther.otherShoulder = lm(0.43, 0.38);
      farther.hip = lm(0.55, 0.6);
      farther.otherHip = lm(0.45, 0.6);
      result = m.update(farther, settings);
    }
    expect(result.faceScale).toBeLessThan(baselineFace * 0.85);
    expect(result.torsoScale).toBeLessThan(baselineTorso * 0.85);
  });

  it('goes holding then lost when the wrist disappears, and recovers', () => {
    const m = new MotionEstimator();
    let t = 0;
    for (let i = 0; i < 5; i++, t += FRAME_MS) m.update(obs(t, lm(0.5, 0.5)), settings);
    expect(m.update(obs(t, null), settings).status).toBe('holding');
    t += 300;
    expect(m.update(obs(t, lm(0.5, 0.5, 0.1)), settings).status).toBe('lost');
    t += FRAME_MS;
    const s = m.update(obs(t, lm(0.7, 0.5)), settings);
    expect(s.status).toBe('tracking');
    expect(s.justReacquired).toBe(true);
    // filter was reset, so no smoothing across the gap
    expect(s.position.x).toBeCloseTo(0.2 * (4 / 3));
    expect(m.stats.lossEvents).toBe(1);
  });

  it('rejects a single-frame teleport but accepts a jump that persists', () => {
    const m = new MotionEstimator();
    let t = 0;
    for (let i = 0; i < 5; i++, t += FRAME_MS) m.update(obs(t, lm(0.5, 0.5)), settings);
    // 0.5 image widths in one frame ≈ 20 frame-heights/s > 15 limit
    expect(m.update(obs(t, lm(1.0, 0.5)), settings).acceptedThisFrame).toBe(false);
    t += FRAME_MS;
    expect(m.update(obs(t, lm(0.5, 0.5)), settings).acceptedThisFrame).toBe(true);
    t += FRAME_MS;
    expect(m.stats.outliersRejected).toBe(1);
    // A teleport that then sits still is held a few frames (it might be the
    // tracker mistaking the paddle for the hand), but is accepted if it persists.
    let framesUntilAccepted = 0;
    while (!m.update(obs(t, lm(1.0, 0.5)), settings).acceptedThisFrame && framesUntilAccepted < 20) {
      t += FRAME_MS;
      framesUntilAccepted++;
    }
    expect(framesUntilAccepted).toBeLessThanOrEqual(6);
  });

  it('ignores a one-frame wrist jump even when the hand was already drifting that way', () => {
    // Real footage: hand drifting slowly upward, then the tracker puts the wrist
    // at chest height for one frame (1 → 7 frame-heights/s in 1/30 s).
    const m = new MotionEstimator();
    let t = 0;
    for (let i = 0; i < 8; i++, t += FRAME_MS) m.update(obs(t, lm(0.5, 0.95 - i * 0.008)), settings);
    expect(m.update(obs(t, lm(0.5, 0.67)), settings).acceptedThisFrame).toBe(false);
    t += FRAME_MS;
    expect(m.update(obs(t, lm(0.5, 0.88)), settings).acceptedThisFrame).toBe(true);
  });

  it('reports direction and zero velocity once tracking is lost', () => {
    const m = new MotionEstimator();
    let t = 0;
    let s = m.update(obs(t, lm(0.3, 0.5)), settings);
    for (let i = 1; i < 6; i++) {
      t += FRAME_MS;
      s = m.update(obs(t, lm(0.3 + i * 0.03, 0.5)), settings);
    }
    expect(s.direction).toBe('right');
    expect(s.velocity.x).toBeGreaterThan(1);
    t += FRAME_MS;
    s = m.update(obs(t, null), settings);
    expect(s.speed).toBe(0);
  });
});

describe('calibration', () => {
  it('normalizes asymmetric ranges to ±1', () => {
    const cal = { ...defaultCalibration('camera'), neutral: { x: 0.1, y: 0, z: 0 } };
    cal.range = { ...cal.range, left: 0.2, right: 0.4 };
    expect(normalize({ x: 0.5, y: 0, z: 0 }, cal).x).toBeCloseTo(1);
    expect(normalize({ x: -0.1, y: 0, z: 0 }, cal).x).toBeCloseTo(-1);
    expect(normalize({ x: 5, y: 0, z: 0 }, cal).x).toBeCloseTo(1.15); // clamped
  });

  it('computes neutral as a robust median', () => {
    const samples = [0.1, 0.11, 0.09, 0.1, 0.9].map((x) => ({ x, y: 0, z: 0 }));
    expect(computeNeutral(samples).neutral.x).toBeCloseTo(0.1);
  });

  it('computes range from percentiles and mirrors a side that was barely reached', () => {
    const samples = [];
    for (let i = 0; i <= 100; i++) samples.push({ x: (i / 100) * 0.4, y: -0.3 + (i / 100) * 0.6, z: 0 });
    const { range, warnings } = computeRange(samples, { x: 0, y: 0, z: 0 }, defaultCalibration('camera').range);
    expect(range.right).toBeCloseTo(percentile(samples.map((s) => s.x), 0.97));
    expect(range.left).toBeCloseTo(range.right); // mirrored
    expect(range.up).toBeCloseTo(0.282, 2);
    expect(warnings.length).toBe(1);
  });
});
