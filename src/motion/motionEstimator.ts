import type { ReferenceFrame, Settings } from '../config';
import type { ArmObservation, Landmark } from '../tracking/types';
import { OneEuroFilter } from './oneEuroFilter';
import { directionLabel, regressionVelocity, vec, ZERO, type DirectionLabel, type TimedSample, type Vec3 } from './vector';

export type TrackingStatus = 'searching' | 'tracking' | 'holding' | 'lost';

/**
 * Control space: x right, y up, z toward the camera ("forward"), measured in
 * image heights (so 0.1 = 10% of the frame height). In 'camera' frame the
 * origin is the image centre; in 'body' frame it is the shoulder midpoint.
 */
export interface MotionState {
  status: TrackingStatus;
  timestamp: number;
  /** Last time the wrist was accepted. */
  lastSeen: number;
  /** Filtered wrist position (control space). Frozen at the last good value while not tracking. */
  position: Vec3;
  /** Last accepted, unfiltered position. */
  rawPosition: Vec3;
  /** Velocity in image heights per second (zero while not tracking). */
  velocity: Vec3;
  /** Speed in the image plane (x/y), plus z if depth is enabled. */
  speed: number;
  /**
   * Speed confirmed by two consecutive camera frames moving the same way. A
   * single glitched landmark spikes `speed` and then reverses; a real stroke
   * doesn't. Use this to decide "the player is moving" for smoothing/prediction.
   */
  strokeSpeed: number;
  /**
   * Velocity of the filtered position between the last two camera frames
   * (control units/s, x/y). Tracks an accelerating stroke more closely than
   * the windowed `velocity`, so it's used to glide between camera frames.
   */
  frameVelocity: Vec3;
  direction: DirectionLabel;
  /** Screen-space angle of the forearm (elbow→wrist), radians CCW from +x. */
  forearmAngle: number | null;
  /** Approximate forearm tilt toward/away from camera, used as a paddle pitch proxy. */
  forearmDepthAngle: number | null;
  /** Shoulder/elbow positions relative to the wrist in control-space units. */
  armOffsets: { elbow: Vec3; shoulder: Vec3 } | null;
  /** Current unfiltered joint offsets, used only for low-latency gesture intent. */
  rawArmOffsets: { elbow: Vec3; shoulder: Vec3 } | null;
  /** Filtered palm-centre offset from the wrist, used for compact wrist strokes. */
  handOffset: Vec3 | null;
  /**
   * Filtered absolute shoulder/elbow positions in control space (z = 0). These
   * drive the rendered arm. Unlike armOffsets they do not carry wrist noise, so
   * a still shoulder stays still even while the wrist landmark jitters.
   */
  shoulderPosition: Vec3 | null;
  elbowPosition: Vec3 | null;
  wristVisibility: number;
  /** Smoothed shoulder width in image heights; 0 if unknown. */
  shoulderWidth: number;
  /** Raw filtered face/torso scales in image heights, calibrated after tracker warm-up. */
  faceScale: number;
  torsoScale: number;
  /** Wrist speed relative to its shoulder; whole-body translation is removed. */
  armRelativeSpeed: number;
  /** Origin of control space, in display-normalized image coordinates. */
  reference: { x: number; y: number };
  aspect: number;
  frame: ReferenceFrame;
  /** True on the first frame after tracking resumes from a gap. */
  justReacquired: boolean;
  /** True when this frame's wrist was accepted (calibration only samples these). */
  acceptedThisFrame: boolean;
}

export interface TrackingStats {
  framesTotal: number;
  framesAccepted: number;
  outliersRejected: number;
  lossEvents: number;
  currentLossMs: number;
  longestLossMs: number;
}

const REACQUIRE_RESET_MS = 150;
const STILL_SPEED = 0.15; // image heights/s
const ARM_JOINT_MIN_VISIBILITY = 0.55;

function visible(l: Landmark | null, min: number): l is Landmark {
  return !!l && l.visibility >= min && l.x > -0.1 && l.x < 1.1 && l.y > -0.1 && l.y < 1.1;
}

export class MotionEstimator {
  private posFilter = new OneEuroFilter({ minCutoff: 1, beta: 6, dCutoff: 1 });
  // Depth is much noisier than screen-space position and must not become more
  // responsive merely because the hand is moving quickly left/right.
  private depthFilter = new OneEuroFilter({ minCutoff: 0.35, beta: 0.8, dCutoff: 0.7 });
  // The reference must move slowly: torso rotation during a swing shouldn't drag the paddle.
  private refFilter = new OneEuroFilter({ minCutoff: 0.5, beta: 0, dCutoff: 1 });
  // Distance must react within a return, unlike the deliberately slow body
  // origin above. One Euro smoothing preserves a quiet stance but opens up as
  // soon as shoulder scale changes quickly during a step.
  private shoulderScaleFilter = new OneEuroFilter({ minCutoff: 1.8, beta: 12, dCutoff: 1.5 });
  private torsoScaleFilter = new OneEuroFilter({ minCutoff: 1.8, beta: 12, dCutoff: 1.5 });
  private faceScaleFilter = new OneEuroFilter({ minCutoff: 1.8, beta: 12, dCutoff: 1.5 });
  private angleFilter = new OneEuroFilter({ minCutoff: 2, beta: 2, dCutoff: 1 });
  // Long rendered bones magnify tiny joint errors. Keep them quiet at rest,
  // while a high beta opens the filter during an intentional arm movement.
  private armFilter = new OneEuroFilter({ minCutoff: 0.45, beta: 5, dCutoff: 1 });
  private handFilter = new OneEuroFilter({ minCutoff: 1.5, beta: 8, dCutoff: 1 });
  // Rendered-arm joints. The shoulder barely moves during a stroke, so it can
  // be filtered heavily. The elbow uses the wrist's own filter settings so the
  // forearm direction (elbow − wrist) doesn't skew from mismatched lag mid-swing.
  private shoulderJointFilter = new OneEuroFilter({ minCutoff: 0.6, beta: 1.5, dCutoff: 1 });
  private elbowJointFilter = new OneEuroFilter({ minCutoff: 1, beta: 6, dCutoff: 1 });
  private history: TimedSample[] = [];
  private lastAccepted: TimedSample | null = null;
  private consecutiveOutliers = 0;
  private everSeen = false;
  private refKnown = false;
  private lossStart = 0;
  private lastArmRelative: TimedSample | null = null;
  private previousVelocity: Vec3 | null = null;

  state: MotionState = MotionEstimator.initialState();
  stats: TrackingStats = { framesTotal: 0, framesAccepted: 0, outliersRejected: 0, lossEvents: 0, currentLossMs: 0, longestLossMs: 0 };

  static initialState(): MotionState {
    return {
      status: 'searching',
      timestamp: 0,
      lastSeen: 0,
      position: { ...ZERO },
      rawPosition: { ...ZERO },
      velocity: { ...ZERO },
      speed: 0,
      strokeSpeed: 0,
      frameVelocity: { ...ZERO },
      direction: 'still',
      forearmAngle: null,
      forearmDepthAngle: null,
      armOffsets: null,
      rawArmOffsets: null,
      handOffset: null,
      shoulderPosition: null,
      elbowPosition: null,
      wristVisibility: 0,
      shoulderWidth: 0,
      faceScale: 0,
      torsoScale: 0,
      armRelativeSpeed: 0,
      reference: { x: 0.5, y: 0.5 },
      aspect: 4 / 3,
      frame: 'camera',
      justReacquired: false,
      acceptedThisFrame: false,
    };
  }

  reset(): void {
    this.posFilter.reset();
    this.depthFilter.reset();
    this.refFilter.reset();
    this.shoulderScaleFilter.reset();
    this.torsoScaleFilter.reset();
    this.faceScaleFilter.reset();
    this.angleFilter.reset();
    this.armFilter.reset();
    this.handFilter.reset();
    this.shoulderJointFilter.reset();
    this.elbowJointFilter.reset();
    this.history = [];
    this.lastAccepted = null;
    this.lastArmRelative = null;
    this.previousVelocity = null;
    this.consecutiveOutliers = 0;
    this.everSeen = false;
    this.refKnown = false;
    this.state = MotionEstimator.initialState();
    this.stats = { framesTotal: 0, framesAccepted: 0, outliersRejected: 0, lossEvents: 0, currentLossMs: 0, longestLossMs: 0 };
  }

  /** Convert a control-space point back to display-normalized image coordinates (for overlays). */
  controlToImage(p: { x: number; y: number }): { x: number; y: number } {
    const { reference, aspect } = this.state;
    return { x: reference.x + p.x / aspect, y: reference.y - p.y };
  }

  update(obs: ArmObservation, settings: Settings): MotionState {
    const t = obs.timestamp;
    const s = this.state;
    const prevStatus = s.status;
    this.posFilter.params = { minCutoff: settings.minCutoff, beta: settings.beta, dCutoff: settings.dCutoff };
    this.elbowJointFilter.params = this.posFilter.params;
    this.stats.framesTotal++;

    s.timestamp = t;
    s.aspect = obs.aspect;
    s.frame = settings.frame;
    s.justReacquired = false;
    s.acceptedThisFrame = false;
    s.rawArmOffsets = null;
    s.wristVisibility = obs.wrist?.visibility ?? 0;

    // --- Reference frame (shoulders) ---
    const shouldersOk = visible(obs.shoulder, settings.minVisibility) && visible(obs.otherShoulder, settings.minVisibility);
    if (shouldersOk) {
      const a = obs.shoulder!;
      const b = obs.otherShoulder!;
      const width = Math.hypot((a.x - b.x) * obs.aspect, a.y - b.y);
      const [rx, ry] = this.refFilter.filter([(a.x + b.x) / 2, (a.y + b.y) / 2], t);
      const [fastWidth] = this.shoulderScaleFilter.filter([width], t);
      s.shoulderWidth = fastWidth;
      if (settings.frame === 'body') s.reference = { x: rx, y: ry };
      this.refKnown = true;
    }
    // Camera distance requires agreement between two independent, arm-free
    // measurements. Real forward/backward movement scales face and torso
    // together. A swing, body twist, head turn, or bad hip landmark changes one
    // much more than the other, so the last valid distance is held.
    const torsoOk = shouldersOk
      && visible(obs.hip, settings.minVisibility)
      && visible(obs.otherHip, settings.minVisibility);
    // Face points remain useful farther from the webcam even when their
    // confidence is lower than the threshold required for paddle collisions.
    const faceVisibility = Math.min(0.35, settings.minVisibility);
    const faceOk = visible(obs.leftEye, faceVisibility)
      && visible(obs.rightEye, faceVisibility);
    if (torsoOk && faceOk) {
      const side = Math.hypot(
        (obs.shoulder!.x - obs.hip!.x) * obs.aspect,
        obs.shoulder!.y - obs.hip!.y,
      );
      const otherSide = Math.hypot(
        (obs.otherShoulder!.x - obs.otherHip!.x) * obs.aspect,
        obs.otherShoulder!.y - obs.otherHip!.y,
      );
      const eyeSpan = Math.hypot(
        (obs.leftEye!.x - obs.rightEye!.x) * obs.aspect,
        obs.leftEye!.y - obs.rightEye!.y,
      );
      const [torsoScale] = this.torsoScaleFilter.filter([(side + otherSide) / 2], t);
      const [faceScale] = this.faceScaleFilter.filter([eyeSpan], t);
      s.torsoScale = torsoScale;
      s.faceScale = faceScale;
    }
    if (settings.frame === 'camera') s.reference = { x: 0.5, y: 0.5 };

    // --- Rendered-arm joints (absolute, control space) ---
    const jointMin = Math.max(settings.minVisibility, ARM_JOINT_MIN_VISIBILITY);
    const toControl = (l: Landmark) => [(l.x - s.reference.x) * obs.aspect, s.reference.y - l.y];
    if (visible(obs.shoulder, jointMin)) {
      const [x, y] = this.shoulderJointFilter.filter(toControl(obs.shoulder!), t);
      s.shoulderPosition = vec(x, y, 0);
    }
    if (visible(obs.elbow, jointMin)) {
      const [x, y] = this.elbowJointFilter.filter(toControl(obs.elbow!), t);
      s.elbowPosition = vec(x, y, 0);
    }

    // --- Wrist acceptance ---
    // In a realistic ready stance the wrist overlaps the torso and its landmark
    // confidence drops. Accept that real wrist coordinate when the rest of the
    // same arm is clearly present; never invent a wrist from the elbow.
    const armContextVisible = visible(obs.elbow, Math.max(0.2, settings.minVisibility))
      && visible(obs.shoulder, Math.max(0.2, settings.minVisibility));
    // When the rest of the same arm remains confidently tracked, tolerate a
    // small wrist-confidence dip from motion blur or torso overlap. This avoids
    // a single HOLDING frame in the middle of an otherwise continuous stroke.
    const wristVisibility = armContextVisible
      ? Math.max(0.15, settings.minVisibility - 0.1)
      : settings.minVisibility;
    let accepted = armContextVisible
      && visible(obs.wrist, wristVisibility)
      && (settings.frame === 'camera' || this.refKnown);
    let raw: Vec3 = { ...ZERO };
    if (accepted) {
      const w = obs.wrist!;
      raw = {
        x: (w.x - s.reference.x) * obs.aspect,
        y: s.reference.y - w.y,
        // MediaPipe z: more negative = closer to camera. Relative to the shoulder to cancel body lean.
        z: obs.shoulder ? -(w.z - obs.shoulder.z) * obs.aspect * settings.depthGain : 0,
      };
      // Reject single-frame teleports (landmark glitches), but never more than 2 in a row:
      // if the jump persists, it's real.
      const last = this.lastAccepted;
      if (last && t - last.t < 200 && t > last.t) {
        const jumpSpeed = Math.hypot(raw.x - last.p.x, raw.y - last.p.y) / ((t - last.t) / 1000);
        if (jumpSpeed > settings.maxPlausibleSpeed && this.consecutiveOutliers < 2) {
          this.consecutiveOutliers++;
          this.stats.outliersRejected++;
          accepted = false;
        }
      }
    }

    if (accepted) {
      this.consecutiveOutliers = 0;
      const gap = t - s.lastSeen;
      if (!this.everSeen || (prevStatus !== 'tracking' && gap > REACQUIRE_RESET_MS)) {
        // Don't smooth across a gap: the old filter state is stale.
        this.posFilter.reset();
        this.depthFilter.reset();
        this.armFilter.reset();
        this.handFilter.reset();
        this.history = [];
        this.lastArmRelative = null;
        this.previousVelocity = null;
        s.justReacquired = this.everSeen;
      }
      if (prevStatus === 'holding' || prevStatus === 'lost') {
        this.stats.longestLossMs = Math.max(this.stats.longestLossMs, t - this.lossStart);
      }
      this.stats.currentLossMs = 0;
      this.everSeen = true;
      this.stats.framesAccepted++;

      const [fx, fy] = this.posFilter.filter([raw.x, raw.y], t);
      const [fz] = this.depthFilter.filter([raw.z], t);
      const frameDt = (t - s.lastSeen) / 1000;
      s.frameVelocity = prevStatus === 'tracking' && frameDt > 0 && frameDt < 0.1
        ? { x: (fx - s.position.x) / frameDt, y: (fy - s.position.y) / frameDt, z: 0 }
        : { ...ZERO };
      s.position = vec(fx, fy, fz);
      s.rawPosition = raw;
      s.lastSeen = t;
      s.status = 'tracking';
      s.acceptedThisFrame = true;
      this.lastAccepted = { t, p: raw };

      this.history.push({ t, p: raw });
      const cutoff = t - settings.velocityWindowMs;
      while (this.history.length > 2 && this.history[0].t < cutoff) this.history.shift();
      const v = regressionVelocity(this.history);
      if (!settings.depthEnabled) v.z = 0;
      s.velocity = v;
      s.speed = Math.hypot(v.x, v.y, v.z);
      const prev = this.previousVelocity;
      const agrees = prev !== null && prev.x * v.x + prev.y * v.y + prev.z * v.z > 0;
      s.strokeSpeed = agrees ? Math.min(s.speed, Math.hypot(prev!.x, prev!.y, prev!.z)) : 0;
      this.previousVelocity = { ...v };
      s.direction = directionLabel(v, STILL_SPEED, settings.depthEnabled);

      if (obs.shoulder) {
        const relative = {
          x: (obs.wrist!.x - obs.shoulder.x) * obs.aspect,
          y: obs.shoulder.y - obs.wrist!.y,
          z: 0,
        };
        const previous = this.lastArmRelative;
        if (previous && t > previous.t && t - previous.t < 200) {
          const seconds = (t - previous.t) / 1000;
          s.armRelativeSpeed = Math.hypot(relative.x - previous.p.x, relative.y - previous.p.y) / seconds;
        } else {
          s.armRelativeSpeed = 0;
        }
        this.lastArmRelative = { t, p: relative };
      }

      if (visible(obs.elbow, settings.minVisibility)) {
        const e = obs.elbow!;
        const ang = Math.atan2(e.y - obs.wrist!.y, (obs.wrist!.x - e.x) * obs.aspect);
        const [c, sn] = this.angleFilter.filter([Math.cos(ang), Math.sin(ang)], t);
        s.forearmAngle = Math.atan2(sn, c);
        const dx = (obs.wrist!.x - e.x) * obs.aspect;
        const dy = e.y - obs.wrist!.y;
        const dz = -(obs.wrist!.z - e.z) * obs.aspect;
        s.forearmDepthAngle = Math.atan2(dz, Math.max(0.02, Math.hypot(dx, dy)));
        // Keep the last stable rig bend when elbow/shoulder confidence dips.
        // The wrist uses a lower threshold so a bent ready hand remains usable.
        if (visible(obs.elbow, Math.max(settings.minVisibility, ARM_JOINT_MIN_VISIBILITY))
          && visible(obs.shoulder, Math.max(settings.minVisibility, ARM_JOINT_MIN_VISIBILITY))) {
          const w = obs.wrist!;
          const offset = (joint: Landmark): Vec3 => ({
            x: (joint.x - w.x) * obs.aspect,
            y: w.y - joint.y,
            z: -(joint.z - w.z) * obs.aspect * settings.depthGain,
          });
          const elbowOffset = offset(obs.elbow!);
          const shoulderOffset = offset(obs.shoulder!);
          s.rawArmOffsets = { elbow: elbowOffset, shoulder: shoulderOffset };
          const filtered = this.armFilter.filter([
            elbowOffset.x, elbowOffset.y, elbowOffset.z,
            shoulderOffset.x, shoulderOffset.y, shoulderOffset.z,
          ], t);
          s.armOffsets = {
            elbow: vec(filtered[0], filtered[1], filtered[2]),
            shoulder: vec(filtered[3], filtered[4], filtered[5]),
          };
        }
      }
      if (visible(obs.index, 0.2) && visible(obs.pinky, 0.2)) {
        const w = obs.wrist!;
        const centre = {
          x: (obs.index!.x + obs.pinky!.x) / 2,
          y: (obs.index!.y + obs.pinky!.y) / 2,
          z: (obs.index!.z + obs.pinky!.z) / 2,
        };
        const filtered = this.handFilter.filter([
          (centre.x - w.x) * obs.aspect,
          w.y - centre.y,
          -(centre.z - w.z) * obs.aspect * settings.depthGain,
        ], t);
        s.handOffset = vec(filtered[0], filtered[1], filtered[2]);
      }
    } else {
      if (!this.everSeen) {
        s.status = 'searching';
      } else {
        if (prevStatus === 'tracking') {
          this.lossStart = s.lastSeen;
          this.stats.lossEvents++;
        }
        const lostFor = t - s.lastSeen;
        this.stats.currentLossMs = lostFor;
        s.status = lostFor <= settings.holdMs ? 'holding' : 'lost';
      }
      // No fresh data → no motion. Stale velocity would cause phantom swings later.
      s.velocity = { ...ZERO };
      s.speed = 0;
      s.strokeSpeed = 0;
      s.frameVelocity = { ...ZERO };
      this.previousVelocity = null;
      s.direction = 'still';
    }
    return s;
  }
}
