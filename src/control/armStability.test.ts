import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../config';
import { defaultCalibration } from './calibration';
import { PaddleController } from './paddleController';
import { MotionEstimator } from '../motion/motionEstimator';
import type { Vec3 } from '../motion/vector';
import type { ArmObservation, Landmark } from '../tracking/types';

/*
 * End-to-end stability checks: synthetic landmarks with webcam-like noise go
 * through the real MotionEstimator and PaddleController (camera 30 Hz, render
 * 60 Hz), and we measure how much the rendered arm and paddle move.
 */

const ASPECT = 4 / 3;
const CAMERA_MS = 1000 / 30;
const RENDER_MS = 1000 / 60;

// Mirrored display coordinates. Right-handed table-tennis ready stance: the
// forearm points mostly toward the camera, so its 2D projection is short.
interface Stance { shoulder: number[]; other: number[]; elbow: number[]; wrist: number[] }
const READY: Stance = {
  shoulder: [0.60, 0.42, 0.0], other: [0.42, 0.42, 0.0],
  elbow: [0.65, 0.60, -0.05], wrist: [0.63, 0.62, -0.30],
};

function gaussian(seed: number) {
  let s = seed;
  const u = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

// Roughly MediaPipe Pose lite on a 640×480 webcam: ~2 px x/y jitter, much
// noisier depth, wrist visibility that wanders, occasional larger jumps.
function observe(t: number, p: Stance, g: () => number): ArmObservation {
  const lm = (q: number[], xy: number, z: number, vis: number, visNoise: number): Landmark => {
    const burst = Math.abs(g()) > 2.6 ? 6 : 1;
    return {
      x: q[0] + g() * xy * burst, y: q[1] + g() * xy * burst, z: q[2] + g() * z,
      visibility: Math.max(0, Math.min(1, vis + g() * visNoise)),
    };
  };
  return {
    timestamp: t, aspect: ASPECT,
    wrist: lm(p.wrist, 0.004, 0.04, 0.65, 0.15),
    elbow: lm(p.elbow, 0.0032, 0.04, 0.7, 0.12),
    shoulder: lm(p.shoulder, 0.0024, 0.02, 0.95, 0.02),
    otherShoulder: lm(p.other, 0.0024, 0.02, 0.95, 0.02),
    hip: lm([0.58, 0.85, 0], 0.004, 0.04, 0.8, 0.1),
    otherHip: lm([0.44, 0.85, 0], 0.004, 0.04, 0.8, 0.1),
    leftEye: lm([0.53, 0.25, -0.2], 0.002, 0.04, 0.95, 0.02),
    rightEye: lm([0.49, 0.25, -0.2], 0.002, 0.04, 0.95, 0.02),
    index: lm([p.wrist[0] - 0.01, p.wrist[1] + 0.03, p.wrist[2]], 0.006, 0.04, 0.6, 0.2),
    pinky: lm([p.wrist[0] + 0.01, p.wrist[1] + 0.03, p.wrist[2]], 0.006, 0.04, 0.6, 0.2),
  };
}

interface Sample { t: number; hand: Vec3; elbow: Vec3; shoulder: Vec3; roll: number }

function run(durationMs: number, stanceAt: (t: number) => Stance, seed: number, noisy = true): Sample[] {
  const cal = {
    ...defaultCalibration('camera'),
    neutral: { x: (READY.wrist[0] - 0.5) * ASPECT, y: 0.5 - READY.wrist[1], z: -READY.wrist[2] * ASPECT },
    neutralSet: true,
  };
  const estimator = new MotionEstimator();
  const controller = new PaddleController();
  const g = noisy ? gaussian(seed) : () => 0;
  const out: Sample[] = [];
  let nextCamera = 0;
  for (let t = 0; t <= durationMs; t += RENDER_MS) {
    if (t >= nextCamera) {
      estimator.update(observe(t, stanceAt(t), g), DEFAULT_SETTINGS);
      nextCamera += CAMERA_MS;
    }
    const pose = controller.update(estimator.state, cal, DEFAULT_SETTINGS, t + 1);
    if (pose.arm) out.push({ t, hand: { ...pose.arm.hand }, elbow: { ...pose.arm.elbow }, shoulder: { ...pose.arm.shoulder }, roll: pose.roll });
  }
  return out;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** 95th-percentile and maximum per-frame rotation of a bone, in degrees. */
function boneTurns(samples: Sample[], from: 'hand' | 'elbow', to: 'elbow' | 'shoulder') {
  const dir = (s: Sample) => {
    const v = { x: s[to].x - s[from].x, y: s[to].y - s[from].y, z: s[to].z - s[from].z };
    const n = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / n, y: v.y / n, z: v.z / n };
  };
  const turns = samples.slice(1).map((s, i) => {
    const a = dir(samples[i]);
    const b = dir(s);
    return Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) * 180 / Math.PI;
  }).sort((a, b) => a - b);
  return { p95: turns[Math.floor(turns.length * 0.95)], max: turns[turns.length - 1] };
}

/** 95th-percentile and maximum per-render-frame movement, in centimetres. */
function frameSteps(samples: Sample[], key: 'hand' | 'elbow' | 'shoulder') {
  const steps = samples.slice(1).map((s, i) => dist(s[key], samples[i][key]) * 100).sort((a, b) => a - b);
  return { p95: steps[Math.floor(steps.length * 0.95)], max: steps[steps.length - 1] };
}

// Before the fix the forearm turned ~2.4° per frame (up to 6°) at rest;
// after it ~0.4° (up to 1.5°).
const BONE_TURN_P95_DEG = 1.2;
const BONE_TURN_MAX_DEG = 3;

describe('rendered arm stability', () => {
  for (const seed of [7, 11, 23]) {
    it(`stays steady while the player holds a ready stance (noise seed ${seed})`, () => {
      const samples = run(6000, () => READY, seed).filter((s) => s.t > 1000);
      // Before the stroke gating the grip moved ~5.5 cm per frame at rest.
      expect(frameSteps(samples, 'hand').p95).toBeLessThan(1.5);
      expect(frameSteps(samples, 'hand').max).toBeLessThan(5);
      // Bones hang from the grip; a flinch is a bone suddenly rotating.
      expect(boneTurns(samples, 'hand', 'elbow').p95).toBeLessThan(BONE_TURN_P95_DEG);
      expect(boneTurns(samples, 'hand', 'elbow').max).toBeLessThan(BONE_TURN_MAX_DEG);
      expect(boneTurns(samples, 'elbow', 'shoulder').p95).toBeLessThan(BONE_TURN_P95_DEG);
      expect(boneTurns(samples, 'elbow', 'shoulder').max).toBeLessThan(BONE_TURN_MAX_DEG);
      // The blade must never flip between forehand and backhand from noise.
      const rolls = samples.map((s) => s.roll);
      expect(Math.max(...rolls) - Math.min(...rolls)).toBeLessThan(0.05);
    });
  }

  it('does not whip or stutter through a fast cross-body swing', () => {
    // Wrist sweeps from the forehand side to the backhand side in 250 ms, with
    // the elbow following partway: the case where the arm used to whip round.
    const start = 1500;
    const stanceAt = (t: number): Stance => {
      const k = Math.max(0, Math.min(1, (t - start) / 250));
      const e = k * k * (3 - 2 * k);
      return {
        ...READY,
        wrist: [0.72 - 0.30 * e, 0.60 - 0.04 * Math.sin(Math.PI * e), READY.wrist[2]],
        elbow: [0.68 - 0.10 * e, READY.elbow[1], READY.elbow[2]],
      };
    };
    const samples = run(2200, stanceAt, 7).filter((s) => s.t > start - 100 && s.t < start + 500);
    // The paddle sweeps ~90 cm here, so the forearm genuinely rotates a lot;
    // before the fixes single frames turned it ~60° (elbow flipping sides).
    expect(boneTurns(samples, 'hand', 'elbow').max).toBeLessThan(30);
    expect(boneTurns(samples, 'elbow', 'shoulder').max).toBeLessThan(20);
    // The shoulder belongs to the body: a swing must not drag it across court.
    const shoulderXs = samples.map((s) => s.shoulder.x);
    expect(Math.max(...shoulderXs) - Math.min(...shoulderXs)).toBeLessThan(0.2);
    // The paddle should glide every render frame mid-swing, not step at the
    // camera's 30 Hz (move, stall, move, stall).
    const steps = samples.slice(1).map((s, i) => dist(s.hand, samples[i].hand) * 100);
    const stalls = steps.filter((d, i) => i > 0 && steps[i - 1] > 0.5 && d < steps[i - 1] * 0.3).length;
    expect(stalls).toBeLessThanOrEqual(2);
  });

  it('moves continuously while an extended arm is raised and lowered', () => {
    const start = 1200;
    const stanceAt = (t: number): Stance => {
      const phase = Math.max(0, Math.min(1, (t - start) / 1200));
      const vertical = Math.sin(phase * Math.PI * 2) * 0.12;
      return {
        ...READY,
        wrist: [0.74, READY.wrist[1] - vertical, READY.wrist[2]],
        elbow: [0.68, READY.elbow[1] - vertical * 0.48, READY.elbow[2]],
      };
    };
    const samples = run(2700, stanceAt, 0, false).filter((s) => s.t >= start && s.t <= start + 1300);
    expect(frameSteps(samples, 'hand').max).toBeLessThan(4);
    expect(frameSteps(samples, 'shoulder').max).toBeLessThan(3.5);
    expect(boneTurns(samples, 'elbow', 'shoulder').max).toBeLessThan(12);
  });

  it('keeps up with a fast forehand stroke', () => {
    // Wrist travels 0.12 image widths right in 150 ms: well inside the paddle
    // area, so the measurement isn't flattered by edge clamping.
    const start = 1500;
    const stanceAt = (t: number): Stance => {
      const k = Math.max(0, Math.min(1, (t - start) / 150));
      const e = k * k * (3 - 2 * k);
      return { ...READY, wrist: [READY.wrist[0] + 0.12 * e, READY.wrist[1], READY.wrist[2]] };
    };
    const samples = run(2500, stanceAt, 0, false);
    const before = samples.find((s) => s.t >= start - 20)!.hand.x;
    const after = samples[samples.length - 1].hand.x;
    const halfway = samples.find((s) => s.hand.x >= before + (after - before) * 0.5)!;
    // The true wrist is halfway at start+75 ms. Only the camera's 33 ms frame
    // cadence and filtering should separate the paddle from it.
    expect(halfway.t - (start + 75)).toBeLessThan(45);
  });
});
