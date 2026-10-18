import { describe, expect, it } from 'vitest';
import { MotionEstimator, type MotionState } from './motionEstimator';
import { SwingDetector } from './swingDetector';

const SETTINGS = { startSpeed: 2, endSpeed: 0.8, minDurationMs: 60 };

function motion(t: number, speed: number, x = speed): MotionState {
  return {
    ...MotionEstimator.initialState(),
    status: 'tracking',
    acceptedThisFrame: true,
    timestamp: t,
    speed,
    velocity: { x, y: 0, z: 0 },
    position: { x: t / 1000, y: 0, z: 0 },
  };
}

describe('SwingDetector', () => {
  it('detects one sustained swing and waits for the end threshold', () => {
    const detector = new SwingDetector();
    for (const t of [0, 30, 60, 90]) expect(detector.update(motion(t, 2.5), SETTINGS)).toBeNull();
    expect(detector.isSwinging).toBe(true);
    expect(detector.update(motion(120, 0.5), SETTINGS)).toBeNull();
    const event = detector.update(motion(200, 0.4), SETTINGS);
    expect(event?.nearMiss).toBe(false);
    expect(event?.direction).toBe('right');
    expect(event?.peakSpeed).toBe(2.5);
    expect(detector.isSwinging).toBe(false);
  });

  it('logs a 70–100% attempt as a near miss', () => {
    const detector = new SwingDetector();
    detector.update(motion(0, 1.5), SETTINGS);
    detector.update(motion(30, 1.7), SETTINGS);
    const event = detector.update(motion(60, 0.2), SETTINGS);
    expect(event?.nearMiss).toBe(true);
    expect(event?.peakSpeed).toBe(1.7);
  });

  it('does not convert a sharp direction reversal into a swing', () => {
    const detector = new SwingDetector();
    detector.update(motion(0, 2.5), SETTINGS);
    const event = detector.update(motion(40, 2.5, -2.5), SETTINGS);
    expect(event?.nearMiss).toBe(true);
    expect(detector.isSwinging).toBe(false);
  });

  it('ends an active swing when tracking is lost', () => {
    const detector = new SwingDetector();
    detector.update(motion(0, 2.5), SETTINGS);
    detector.update(motion(70, 2.5), SETTINGS);
    const lost = { ...motion(90, 0), status: 'lost' as const, acceptedThisFrame: false };
    expect(detector.update(lost, SETTINGS)?.nearMiss).toBe(false);
  });
});
