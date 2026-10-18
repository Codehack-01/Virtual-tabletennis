import type { MotionState } from './motionEstimator';
import { directionLabel, type DirectionLabel, type Vec3 } from './vector';

export interface SwingSettings {
  startSpeed: number;
  endSpeed: number;
  minDurationMs: number;
}

export interface SwingEvent {
  id: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  peakSpeed: number;
  direction: DirectionLabel;
  directionVector: Vec3;
  startPosition: Vec3;
  endPosition: Vec3;
  nearMiss: boolean;
}

interface Run {
  startedAt: number;
  qualifiedAt: number | null;
  peakSpeed: number;
  velocitySum: Vec3;
  samples: number;
  startPosition: Vec3;
  lastPosition: Vec3;
}

const NEAR_MISS_RATIO = 0.7;
const END_DEBOUNCE_MS = 70;
const DIRECTION_COSINE = 0.35;

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Stateful speed-threshold detector with hysteresis and direction consistency. */
export class SwingDetector {
  private candidate: Run | null = null;
  private active: Run | null = null;
  private belowSince = 0;
  private nextId = 1;

  get isSwinging(): boolean {
    return this.active !== null;
  }

  reset(): void {
    this.candidate = null;
    this.active = null;
    this.belowSince = 0;
  }

  update(motion: MotionState, settings: SwingSettings): SwingEvent | null {
    const now = motion.timestamp;
    if (motion.status !== 'tracking' || !motion.acceptedThisFrame) return this.finishInterrupted(now);

    if (this.active) {
      this.add(this.active, motion);
      if (motion.speed >= settings.endSpeed) {
        this.belowSince = 0;
        return null;
      }
      if (!this.belowSince) this.belowSince = now;
      if (now - this.belowSince < END_DEBOUNCE_MS) return null;
      return this.finish(this.active, now, false);
    }

    const nearMissSpeed = settings.startSpeed * NEAR_MISS_RATIO;
    if (motion.speed < nearMissSpeed) {
      if (this.candidate) {
        const event = this.candidate.peakSpeed >= nearMissSpeed
          ? this.finish(this.candidate, now, true)
          : null;
        this.candidate = null;
        return event;
      }
      return null;
    }

    if (!this.candidate) this.candidate = this.begin(motion, motion.speed >= settings.startSpeed);
    else {
      const meanDirection = unit(this.candidate.velocitySum);
      const currentDirection = unit(motion.velocity);
      if (dot(meanDirection, currentDirection) < DIRECTION_COSINE) {
        const previous = this.candidate;
        this.candidate = this.begin(motion, motion.speed >= settings.startSpeed);
        return previous.peakSpeed >= nearMissSpeed ? this.finish(previous, now, true) : null;
      }
      this.add(this.candidate, motion);
    }

    if (motion.speed >= settings.startSpeed) {
      if (this.candidate.qualifiedAt === null) this.candidate.qualifiedAt = now;
    } else {
      this.candidate.qualifiedAt = null;
    }
    if (this.candidate.qualifiedAt !== null && now - this.candidate.qualifiedAt >= settings.minDurationMs) {
      this.active = this.candidate;
      this.candidate = null;
      this.belowSince = 0;
    }
    return null;
  }

  private begin(motion: MotionState, qualified: boolean): Run {
    return {
      startedAt: motion.timestamp,
      qualifiedAt: qualified ? motion.timestamp : null,
      peakSpeed: motion.speed,
      velocitySum: { ...motion.velocity },
      samples: 1,
      startPosition: { ...motion.position },
      lastPosition: { ...motion.position },
    };
  }

  private add(run: Run, motion: MotionState): void {
    run.peakSpeed = Math.max(run.peakSpeed, motion.speed);
    run.velocitySum.x += motion.velocity.x;
    run.velocitySum.y += motion.velocity.y;
    run.velocitySum.z += motion.velocity.z;
    run.samples++;
    run.lastPosition = { ...motion.position };
  }

  private finishInterrupted(now: number): SwingEvent | null {
    const run = this.active ?? this.candidate;
    const wasActive = !!this.active;
    this.active = null;
    this.candidate = null;
    this.belowSince = 0;
    return run ? this.finish(run, now, !wasActive) : null;
  }

  private finish(run: Run, now: number, nearMiss: boolean): SwingEvent {
    if (this.active === run) this.active = null;
    this.belowSince = 0;
    const directionVector = unit(run.velocitySum);
    return {
      id: this.nextId++,
      startedAt: run.startedAt,
      endedAt: now,
      durationMs: Math.max(0, now - run.startedAt),
      peakSpeed: run.peakSpeed,
      direction: directionLabel(directionVector, 0.01, true),
      directionVector,
      startPosition: run.startPosition,
      endPosition: run.lastPosition,
      nearMiss,
    };
  }
}
