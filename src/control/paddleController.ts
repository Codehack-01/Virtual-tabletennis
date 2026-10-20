import type { Settings } from '../config';
import type { MotionState, TrackingStatus } from '../motion/motionEstimator';
import { ZERO, type Vec3 } from '../motion/vector';
import { BLADE_RADIUS, GRIP_TO_BLADE, TABLE_PHYSICS } from '../physics/ballPhysics';
import { normalize, type Calibration } from './calibration';

/**
 * The volume the paddle grip can move in, in world metres. Table is centred at the
 * origin, length along z, near end (player side) at z = +1.37, surface at y = 0.76.
 */
export const PADDLE_AREA = {
  // A compact zone just beyond the player's end of the table. Neutral is high
  // enough that the complete blade is visible above the near edge.
  center: { x: 0, y: 1.04, z: 1.5 },
  half: { x: 0.67, y: 0.24, z: 0.25 },
};

export interface PaddlePose {
  /** Grip position in world metres. */
  position: Vec3;
  /** Approximate grip velocity in world m/s (2D-derived; not a true 3D measurement). */
  velocity: Vec3;
  /** Position within the calibrated range, -1..1 per axis. */
  normalized: Vec3;
  /** Rotation about the viewing axis, radians (0 = upright). */
  roll: number;
  /** Approximate face tilt derived from forearm depth. */
  pitch: number;
  /** Approximate left/right face angle derived from forearm direction. */
  yaw: number;
  tracked: boolean;
  status: TrackingStatus;
  /** Approximate 3D joints used only for rendering the player's arm. */
  arm: { hand: Vec3; elbow: Vec3; shoulder: Vec3 } | null;
  /** Reserved for scene compatibility; body-driven camera zoom is disabled. */
  playerRetreat: number;
}

const REACQUIRE_BLEND_MS = 40;
const BRIEF_REACQUIRE_BLEND_MS = 80;
const RECALIBRATION_BLEND_MS = 70;

// Stroke gating, in frame-heights/s of the regression velocity. A still wrist
// produces ~0.2–0.4 fh/s of landmark noise; real strokes run 2–5 fh/s. Lead and
// raw-wrist blending only engage above the noise floor, so standing still never
// extrapolates jitter.
const STROKE_BLEND_START = 0.9;
const STROKE_BLEND_FULL = 2.2;
const LEAD_START = 0.6;
const LEAD_FULL = 1.6;
const LATERAL_LEAD_S = 0.025;

// Backhand entry/exit, measured as how far the hand crosses inside the elbow
// (frame heights). The gap between them stops noise near a neutral ready stance
// flipping the blade between forehand and backhand.
const BACKHAND_ENTER = 0.07;
const BACKHAND_EXIT = 0.03;

/** Normalized depth change ignored by default (≈4× the filtered depth noise). */
const DEPTH_DEADBAND = 0.35;

/**
 * Rendered arm (metres). The shoulder stays where the player's body is: its
 * sideways position follows the tracked shoulder (stepping moves it), its
 * height and depth are fixed relative to the paddle zone. The arm reaches from
 * there to the paddle grip with real bone lengths, so the 3D shoulder stays
 * still while the hand moves, like the player's own.
 */
// Measured against the supplied 17:13 reference: the shoulder begins high in
// the upper-left of the court view and the full chain reaches the ready grip
// without pulling that shoulder down toward the table.
// Visual arm proportions. Shorter than a real arm because the camera sits close
// behind the player: full-length bones filled the middle of the screen.
export const ARM_RIG = { upper: 0.24, fore: 0.24, shoulderHeight: 0.24, shoulderDepth: 0.17 };
const SHOULDER_SMOOTH_MS = 85;
const MAX_SHOULDER_SPEED_MPS = 2;
const ELBOW_BEND_SMOOTH_MS = 140;
const MAX_ELBOW_SWING_RAD_PER_S = (360 * Math.PI) / 180;
// The camera delivers ~30 poses/s while the game renders ~60. During a stroke,
// carry the paddle along its velocity between camera frames (at most one frame)
// so it glides instead of stepping.
const MAX_INTERFRAME_MS = 40;
// The glide has its own trigger: the latest frame-to-frame velocity must agree
// in direction with the windowed velocity. That engages on the first frames of
// a real stroke (where the biggest 30 Hz steps are) but not on noise.
const GLIDE_START = 0.4;
const GLIDE_FULL = 1.0;
// Extra grip smoothing that only applies while the hand is still, so landmark
// noise doesn't twitch the arm; it releases as soon as a movement starts.
const REST_SMOOTH_MS = 90;
// Render-rate smoothing while moving. Higher spreads each 30 Hz camera step
// more evenly. This stays below one 30 Hz camera frame, so it softens sample
// replacement without making the paddle trail a deliberate stroke.
const MOVING_SMOOTH_MS = 18;
const REST_RELEASE_START = 0.25;
const REST_RELEASE_FULL = 0.9;
// Above the mapped speed of an ordinary stroke: this clips tracker teleports
// and abrupt prediction corrections without flattening intentional motion.
const MAX_RENDER_SPEED_MPS = 8;
const RAW_WRIST_BLEND_MAX = 0.65;
const MODE_BLEND_MS = 55;
const BLADE_HALF_THICKNESS = 0.007;
const TABLE_CLEARANCE_M = 0.012;
// A low racket just in front of the near edge is technically outside the table
// box, but the camera angle still lets the tabletop cut across it. Treat this
// narrow player-side strip as part of the clearance zone so the blade remains
// visually whole.
const NEAR_EDGE_VISUAL_MARGIN_M = 0.18;


function toWorld(n: Vec3, depth: boolean): Vec3 {
  const { center, half } = PADDLE_AREA;
  return {
    x: center.x + n.x * half.x,
    y: center.y + n.y * half.y,
    z: center.z - (depth ? n.z * half.z : 0), // forward = toward the table = -z
  };
}

export class PaddleController {
  private pose: PaddlePose = {
    position: toWorld(ZERO, false),
    velocity: { ...ZERO },
    normalized: { ...ZERO },
    roll: 0,
    pitch: 0,
    yaw: 0,
    tracked: false,
    status: 'searching',
    arm: null,
    playerRetreat: 0,
  };
  private lastUpdate = 0;
  private blendUntil = 0;
  private lastCalibration: Calibration | null = null;
  private recalibrationBlendUntil = 0;
  private shoulderWorld: Vec3 | null = null;
  private elbowBend: Vec3 | null = null;
  private armReach: number | null = null;
  private backhandLatched = false;
  private backhandBlend = 0;
  private rawWristBlend = 0;
  private glideBlend = 0;
  private restBlend = 1;

  update(motion: MotionState, cal: Calibration, settings: Settings, now: number): PaddlePose {
    const firstUpdate = this.lastUpdate === 0;
    const dt = this.lastUpdate ? Math.min(0.1, (now - this.lastUpdate) / 1000) : 0;
    this.lastUpdate = now;
    const previousStatus = this.pose.status;
    if (motion.justReacquired) this.blendUntil = now + REACQUIRE_BLEND_MS * 4;
    else if (motion.status === 'tracking' && previousStatus === 'holding') {
      // A one-frame confidence dip used to freeze the pose and then apply the
      // entire missed movement at once. Ease only that catch-up step.
      this.blendUntil = Math.max(this.blendUntil, now + BRIEF_REACQUIRE_BLEND_MS);
    }
    // A new calibration (e.g. the automatic ready-position capture) moves the
    // whole mapping at once; glide there instead of snapping across the court.
    if (this.lastCalibration && cal !== this.lastCalibration) this.recalibrationBlendUntil = now + RECALIBRATION_BLEND_MS * 4;
    this.lastCalibration = cal;

    const p = this.pose;
    const tracked = motion.status === 'tracking' || motion.status === 'holding';
    p.tracked = tracked;
    p.status = motion.status;

    // A rejected camera sample used to rebuild the target from the old filtered
    // wrist. That recoiled a predicted stroke for one frame, then launched it
    // forward on reacquisition. Holding must literally preserve the last pose.
    if (motion.status === 'holding') {
      p.velocity = { ...ZERO };
      return p;
    }

    if (tracked) {
      // Body-driven camera zoom is intentionally disabled. Face/torso scales
      // remain available in diagnostics, but cannot alter the court view or the
      // paddle's gameplay depth.
      p.playerRetreat = 0;
      const tracking = motion.status === 'tracking';
      const fv = motion.frameVelocity;
      // Rendering must remain responsive through a deliberate reversal. The
      // swing detector requires two velocity samples to agree, so strokeSpeed
      // intentionally falls to zero exactly when the hand changes direction.
      // The latest filtered frame velocity keeps the avatar moving during that
      // transition without weakening the stricter gameplay swing detection.
      const activitySpeed = tracking
        ? Math.max(motion.strokeSpeed, Math.hypot(fv.x, fv.y) * 0.8)
        : 0;
      const leadFactor = tracking ? smoothstep(LEAD_START, LEAD_FULL, activitySpeed) : 0;
      const lead = (settings.predictionMs / 1000) * leadFactor;
      // At rest, retain the filtered landmark. During an intentional stroke,
      // blend toward the accepted raw wrist so the paddle does not trail the
      // camera skeleton by several frames. Depth remains filtered separately.
      const rawBlendTarget = tracking && motion.acceptedThisFrame
        ? RAW_WRIST_BLEND_MAX * smoothstep(STROKE_BLEND_START, STROKE_BLEND_FULL, activitySpeed)
        : 0;
      this.rawWristBlend = firstUpdate
        ? rawBlendTarget
        : smoothScalar(
            this.rawWristBlend,
            rawBlendTarget,
            dt,
            rawBlendTarget > this.rawWristBlend ? 15 : 70,
          );
      // Paddle translation belongs to the tracked wrist. Index/pinky landmarks
      // are useful as gesture hints, but adding their changing palm offset here
      // made grip changes and backhands steer the paddle a second time.
      const responsivePosition = {
        x: motion.position.x + (motion.rawPosition.x - motion.position.x) * this.rawWristBlend,
        y: motion.position.y + (motion.rawPosition.y - motion.position.y) * this.rawWristBlend,
        z: motion.position.z,
      };
      // The webcam pose arrives at camera cadence while the game renders much
      // faster. A small lateral-only lead keeps a quick edge reach attached to
      // the visible hand without predicting height/depth or disturbing the
      // body-distance camera. User-configured prediction is still applied to
      // every axis; this extra lead only compensates the observed side latency.
      // Time since this camera pose was captured, bridged at render rate.
      // The glide uses the latest frame-to-frame velocity, which keeps up with
      // an accelerating stroke; the windowed velocity lags it, which left most
      // of each 30 Hz step to happen in a single render frame.
      const glideTarget = tracking ? smoothstep(GLIDE_START, GLIDE_FULL, Math.hypot(fv.x, fv.y)) : 0;
      this.glideBlend = firstUpdate
        ? glideTarget
        : smoothScalar(
            this.glideBlend,
            glideTarget,
            dt,
            glideTarget > this.glideBlend ? 10 : MODE_BLEND_MS,
          );
      const sinceFrame = Math.max(0, Math.min(MAX_INTERFRAME_MS, now - motion.timestamp)) / 1000 * this.glideBlend;
      const lateralLead = lead + LATERAL_LEAD_S * leadFactor;
      const predicted = {
        x: responsivePosition.x + motion.velocity.x * lateralLead + motion.frameVelocity.x * sinceFrame,
        y: responsivePosition.y + motion.velocity.y * lead + motion.frameVelocity.y * sinceFrame,
        z: responsivePosition.z + motion.velocity.z * lead,
      };
      const n = normalize(predicted, cal, settings.gain);
      // Keep the uncalibrated mapping linear. The previous position-dependent
      // outward gain made equal hand movements produce visibly different avatar
      // speeds. A range calibration is the honest way to learn asymmetric reach.
      // Always preserve a conservative amount of wrist depth so a forward
      // stroke is not misread as a longer 2D arm. The experimental option only
      // unlocks the full calibrated depth range. MediaPipe depth is far noisier
      // than x/y, so small changes are ignored: a still player must not see the
      // paddle wobble toward and away from the table.
      if (!settings.depthEnabled) n.z = Math.max(-0.55, Math.min(0.55, deadband(n.z, DEPTH_DEADBAND) * 0.45));
      const target = toWorld(n, true);
      p.normalized = n;
      if (firstUpdate) {
        p.position = target;
      } else if (now < this.recalibrationBlendUntil) {
        approachLimited(p.position, target, dt, RECALIBRATION_BLEND_MS, MAX_RENDER_SPEED_MPS);
      } else if (now < this.blendUntil) {
        // Ease in after a tracking gap instead of snapping across the screen.
        approachLimited(p.position, target, dt, 70, MAX_RENDER_SPEED_MPS);
      } else {
        // Bridge camera-rate landmark updates at render rate without adding
        // enough latency to make a return feel detached from the hand. While
        // the hand is still, smooth harder so noise doesn't twitch the arm.
        const restTarget = tracking ? 1 - smoothstep(REST_RELEASE_START, REST_RELEASE_FULL, activitySpeed) : 1;
        this.restBlend = firstUpdate
          ? restTarget
          : smoothScalar(this.restBlend, restTarget, dt, restTarget < this.restBlend ? 5 : 80);
        approachLimited(
          p.position,
          target,
          dt,
          MOVING_SMOOTH_MS + REST_SMOOTH_MS * this.restBlend,
          MAX_RENDER_SPEED_MPS,
        );
      }
      const { half } = PADDLE_AREA;
      const { range } = cal;
      const scale = (r1: number, r2: number) => settings.gain / ((r1 + r2) / 2);
      p.velocity = {
        x: motion.velocity.x * scale(range.left, range.right) * half.x,
        y: motion.velocity.y * scale(range.up, range.down) * half.y,
        z: -motion.velocity.z * scale(range.forward, range.back) * half.z * (settings.depthEnabled ? 1 : 0.45),
      };
      // Joints for backhand intent: the current camera frame when available
      // (low latency), otherwise the last filtered offsets.
      const intentRigOffsets = motion.rawArmOffsets ?? motion.armOffsets;
      // The blade extends outward from the tracked grip in the normal ready
      // stance. During a cross-body reach it turns over progressively so its
      // contact surface leads toward the opposite edge.
      const reachBackhand = settings.hand === 'right'
        ? smoothstep(-0.2, -0.72, n.x)
        : smoothstep(0.2, 0.72, n.x);
      // A real backhand is defined by the hand crossing inside the elbow, not
      // only by where the hand lands on screen. This remains valid after the
      // player steps back or rotates their torso and lets a compact backhand
      // work without forcing them to move their whole body sideways.
      if (intentRigOffsets) {
        const elbowCross = settings.hand === 'right' ? intentRigOffsets.elbow.x : -intentRigOffsets.elbow.x;
        if (!this.backhandLatched && elbowCross > BACKHAND_ENTER) this.backhandLatched = true;
        else if (this.backhandLatched && elbowCross < BACKHAND_EXIT) this.backhandLatched = false;
      }
      const targetBackhand = Math.max(reachBackhand, this.backhandLatched ? 1 : 0);
      this.backhandBlend = firstUpdate
        ? targetBackhand
        : smoothScalar(this.backhandBlend, targetBackhand, dt, targetBackhand > this.backhandBlend ? 14 : 70);
      const outwardRoll = settings.hand === 'right' ? -Math.PI / 2 : Math.PI / 2;
      const readyRoll = outwardRoll + (settings.hand === 'right' ? Math.PI : -Math.PI) * this.backhandBlend;
      const forearmAdjustment = settings.rollEnabled && motion.forearmAngle !== null
        ? clampAngle(motion.forearmAngle - Math.PI / 2, 0.55)
        : 0;
      const targetRoll = readyRoll + forearmAdjustment;
      p.roll = firstUpdate ? targetRoll : smoothAngle(p.roll, targetRoll, dt, 18);
      if (settings.faceOrientationEnabled && motion.forearmAngle !== null) {
        p.pitch = clampAngle((motion.forearmDepthAngle ?? 0) * 0.7, 0.65);
        p.yaw = clampAngle(Math.cos(motion.forearmAngle) * 0.38, 0.42);
      } else {
        p.pitch = 0;
        p.yaw = 0;
      }
      constrainPaddleAboveTable(p);
      p.arm = this.solveArm(motion, cal, settings, dt, firstUpdate);
    } else {
      // Tracking loss must never steer the paddle. Keep its last position and
      // make it non-collidable via `tracked = false`; reacquisition blends from
      // this honest last-known pose instead of teleporting through centre court.
      p.velocity = { ...ZERO };
      p.arm = null;
    }
    return p;
  }

  /** Arm layout used by the reference recording: fixed court-space height and
   * depth, tracked lateral body position, and a two-bone chain to the grip. */
  private solveArm(motion: MotionState, cal: Calibration, settings: Settings, dt: number, snap: boolean): PaddlePose['arm'] {
    const { center, half } = PADDLE_AREA;
    const hand = { ...this.pose.position };
    const side = settings.hand === 'right' ? 1 : -1;
    const xScale = settings.gain / ((cal.range.left + cal.range.right) / 2) * half.x;
    const yScale = settings.gain / ((cal.range.up + cal.range.down) / 2) * half.y;

    let bodyX: number;
    if (motion.shoulderPosition) {
      const n = normalize(motion.shoulderPosition, cal, settings.gain, 3);
      bodyX = toWorld(n, false).x;
    } else {
      bodyX = this.shoulderWorld?.x ?? center.x + side * 0.1;
    }
    const bodyAnchor = { x: bodyX, y: center.y + ARM_RIG.shoulderHeight, z: center.z + ARM_RIG.shoulderDepth };
    let shoulderTarget = bodyAnchor;
    const reach = (ARM_RIG.upper + ARM_RIG.fore) * 0.98;
    const measuredReach = armReachFromTrackedBend(motion.armOffsets, ARM_RIG.upper, ARM_RIG.fore);
    if (measuredReach !== null) {
      const jointMotion = Math.max(motion.strokeSpeed, Math.hypot(motion.frameVelocity.x, motion.frameVelocity.y));
      this.armReach = this.armReach === null || snap
        ? measuredReach
        : smoothScalar(this.armReach, measuredReach, dt, jointMotion > 0.45 ? 120 : 260);
    }
    const trackedReach = this.armReach;
    const toShoulder = sub(bodyAnchor, hand);
    const distance = Math.hypot(toShoulder.x, toShoulder.y, toShoulder.z);
    if (distance > 1e-6 && trackedReach !== null) {
      // Preserve the player's measured elbow angle. Keeping the shoulder fully
      // fixed forced the two-bone chain to straighten at the edge and collapse
      // into an L on return because the gameplay hand mapping is larger than the
      // person's image-space reach. The visual shoulder may lean a little along
      // its body anchor line, while its lateral body tracking remains intact.
      shoulderTarget = add(hand, scale3(toShoulder, trackedReach / distance));
    } else if (distance > reach) {
      shoulderTarget = add(hand, scale3(toShoulder, reach / distance));
    }
    if (!this.shoulderWorld || snap) this.shoulderWorld = shoulderTarget;
    else approachLimited(this.shoulderWorld, shoulderTarget, dt, SHOULDER_SMOOTH_MS, MAX_SHOULDER_SPEED_MPS);
    const shoulder = { ...this.shoulderWorld };

    // Keep every bend preference perpendicular to the shoulder-hand axis so the
    // two-bone solve stays defined as the hand sweeps across the body.
    const axis = normalize3(sub(hand, shoulder));
    const perpendicular = (v: Vec3) => sub(v, scale3(axis, v.x * axis.x + v.y * axis.y + v.z * axis.z));
    const fallbackBend = add(perpendicular({ x: side, y: 0, z: 0 }), perpendicular({ x: 0, y: -1, z: 0 }));
    let bend = fallbackBend;
    // The elbow's displacement from the shoulder-hand midpoint is the observed
    // bend direction. It must lead the IK pole; previously it was only a small
    // nudge on top of a large canned direction, so the avatar could fold unlike
    // the player's arm. armOffsets are already filtered and remain stable when
    // joint confidence briefly dips.
    if (motion.armOffsets) {
      const elbow = motion.armOffsets.elbow;
      const shoulderOffset = motion.armOffsets.shoulder;
      const hint = {
        x: (elbow.x - shoulderOffset.x * 0.5) * xScale,
        y: (elbow.y - shoulderOffset.y * 0.5) * yScale,
        z: Math.max(-0.2, Math.min(0.2, -(elbow.z - shoulderOffset.z * 0.5))),
      };
      const trackedBend = perpendicular(hint);
      if (Math.hypot(trackedBend.x, trackedBend.y, trackedBend.z) > 0.008) {
        bend = add(normalize3(trackedBend), scale3(normalize3(fallbackBend), 0.12));
      }
    }
    const bendTarget = normalize3(perpendicular(bend));
    if (!this.elbowBend || snap) {
      this.elbowBend = bendTarget;
    } else {
      const smoothed = smoothUnitDirection(this.elbowBend, bendTarget, dt, ELBOW_BEND_SMOOTH_MS);
      this.elbowBend = limitTurn(this.elbowBend, smoothed, MAX_ELBOW_SWING_RAD_PER_S * dt);
    }
    const elbow = solveElbow(shoulder, hand, ARM_RIG.upper, ARM_RIG.fore, this.elbowBend);
    return { hand, elbow, shoulder };
  }
}

/**
 * Keep the complete rotated blade readable above the tabletop/near edge. The
 * tracked point is the grip, so constraining only that point still lets the
 * circular blade pass through the table when it is rolled sideways.
 */
export function constrainPaddleAboveTable(pose: PaddlePose): number {
  const rotate = (v: Vec3): Vec3 => {
    const cr = Math.cos(pose.roll);
    const sr = Math.sin(pose.roll);
    const cp = Math.cos(pose.pitch);
    const sp = Math.sin(pose.pitch);
    const cy = Math.cos(pose.yaw);
    const sy = Math.sin(pose.yaw);
    // Same intrinsic XYZ order used by Three.js for the paddle group.
    const x1 = cr * v.x - sr * v.y;
    const y1 = sr * v.x + cr * v.y;
    const z1 = v.z;
    const x2 = x1;
    const y2 = cp * y1 - sp * z1;
    const z2 = sp * y1 + cp * z1;
    return {
      x: cy * x2 + sy * z2,
      y: y2,
      z: -sy * x2 + cy * z2,
    };
  };
  const offset = rotate({ x: 0, y: GRIP_TO_BLADE, z: 0 });
  const centre = add(pose.position, offset);
  const ex = rotate({ x: 1, y: 0, z: 0 });
  const ey = rotate({ x: 0, y: 1, z: 0 });
  const ez = rotate({ x: 0, y: 0, z: 1 });
  const extent = (axis: keyof Vec3) => BLADE_RADIUS * Math.hypot(ex[axis], ey[axis])
    + BLADE_HALF_THICKNESS * Math.abs(ez[axis]);
  const extentX = extent('x');
  const extentY = extent('y');
  const extentZ = extent('z');
  const halfWidth = TABLE_PHYSICS.width / 2;
  const halfLength = TABLE_PHYSICS.length / 2;
  const overlapsWidth = centre.x + extentX >= -halfWidth && centre.x - extentX <= halfWidth;
  const overlapsDepth = centre.z + extentZ >= -halfLength
    && centre.z - extentZ <= halfLength + NEAR_EDGE_VISUAL_MARGIN_M;
  if (!overlapsWidth || !overlapsDepth) return 0;
  const minimumY = centre.y - extentY;
  const safeY = TABLE_PHYSICS.height + TABLE_CLEARANCE_M;
  if (minimumY >= safeY) return 0;
  const correction = safeY - minimumY;
  pose.position.y += correction;
  if (pose.velocity.y < 0) pose.velocity.y = 0;
  return correction;
}

/** Shoulder-hand distance implied by the tracked elbow angle and rig lengths. */
function armReachFromTrackedBend(
  offsets: MotionState['armOffsets'],
  upper: number,
  fore: number,
): number | null {
  if (!offsets) return null;
  const elbow = offsets.elbow;
  const toHand = scale3(elbow, -1);
  const toShoulder = sub(offsets.shoulder, elbow);
  const handLength = Math.hypot(toHand.x, toHand.y, toHand.z);
  const shoulderLength = Math.hypot(toShoulder.x, toShoulder.y, toShoulder.z);
  if (handLength < 0.025 || shoulderLength < 0.025) return null;
  const cosine = Math.max(-1, Math.min(1,
    (toHand.x * toShoulder.x + toHand.y * toShoulder.y + toHand.z * toShoulder.z)
      / (handLength * shoulderLength),
  ));
  const distance = Math.sqrt(Math.max(0, upper * upper + fore * fore - 2 * upper * fore * cosine));
  return Math.max(Math.abs(upper - fore) + 0.03, Math.min(upper + fore - 0.015, distance));
}

/** Rotate unit vector `from` toward `to` by at most `maxRadians`. */
function limitTurn(from: Vec3, to: Vec3, maxRadians: number): Vec3 {
  const cos = Math.max(-1, Math.min(1, from.x * to.x + from.y * to.y + from.z * to.z));
  const angle = Math.acos(cos);
  if (angle <= maxRadians || angle < 1e-6) return to;
  const t = maxRadians / angle;
  return normalize3(add(scale3(from, 1 - t), scale3(to, t)));
}

/** Elbow position for a two-bone chain from shoulder to hand, bent toward `pole`. */
export function solveElbow(shoulder: Vec3, hand: Vec3, upper: number, fore: number, pole: Vec3): Vec3 {
  const axis = sub(hand, shoulder);
  const rawDistance = Math.hypot(axis.x, axis.y, axis.z);
  const u = rawDistance > 1e-6 ? scale3(axis, 1 / rawDistance) : { x: 0, y: -1, z: 0 };
  const d = Math.max(Math.abs(upper - fore) + 1e-3, Math.min(upper + fore - 1e-3, rawDistance));
  const along = (upper * upper - fore * fore + d * d) / (2 * d);
  const radius = Math.sqrt(Math.max(0, upper * upper - along * along));
  const poleAlong = pole.x * u.x + pole.y * u.y + pole.z * u.z;
  let bend = sub(pole, scale3(u, poleAlong));
  if (Math.hypot(bend.x, bend.y, bend.z) < 1e-4) bend = Math.abs(u.y) < 0.9 ? { x: 0, y: -1, z: 0 } : { x: 1, y: 0, z: 0 };
  return add(shoulder, add(scale3(u, along), scale3(normalize3(bend), radius)));
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale3(v: Vec3, k: number): Vec3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

function normalize3(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z);
  return n > 1e-9 ? scale3(v, 1 / n) : { x: 0, y: -1, z: 0 };
}

function clampAngle(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

/** Zero inside ±width, then linear so that ±1 still maps to ±1. */
function deadband(value: number, width: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= width) return 0;
  return Math.sign(value) * (magnitude - width) / (1 - width);
}

function smoothstep(start: number, end: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

function smoothUnitDirection(current: Vec3 | null, target: Vec3, dtSeconds: number, timeConstantMs: number): Vec3 {
  if (!current || dtSeconds <= 0) return target;
  const k = 1 - Math.exp(-(dtSeconds * 1000) / timeConstantMs);
  const mixed = {
    x: current.x + (target.x - current.x) * k,
    y: current.y + (target.y - current.y) * k,
    z: current.z + (target.z - current.z) * k,
  };
  const magnitude = Math.max(0.001, Math.hypot(mixed.x, mixed.y, mixed.z));
  return { x: mixed.x / magnitude, y: mixed.y / magnitude, z: mixed.z / magnitude };
}

function smoothAngle(current: number, target: number, dtSeconds: number, timeConstantMs: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const k = dtSeconds <= 0 ? 1 : 1 - Math.exp(-(dtSeconds * 1000) / timeConstantMs);
  return current + delta * k;
}

function approachLimited(
  current: Vec3,
  target: Vec3,
  dtSeconds: number,
  timeConstantMs: number,
  maxSpeed: number,
): void {
  if (!isFinite(timeConstantMs) || dtSeconds <= 0) return;
  const k = 1 - Math.exp(-(dtSeconds * 1000) / Math.max(1, timeConstantMs));
  let dx = (target.x - current.x) * k;
  let dy = (target.y - current.y) * k;
  let dz = (target.z - current.z) * k;
  const distance = Math.hypot(dx, dy, dz);
  const maxDistance = maxSpeed * dtSeconds;
  if (distance > maxDistance && distance > 1e-9) {
    const scale = maxDistance / distance;
    dx *= scale;
    dy *= scale;
    dz *= scale;
  }
  current.x += dx;
  current.y += dy;
  current.z += dz;
}

function smoothScalar(current: number, target: number, dtSeconds: number, timeConstantMs: number): number {
  if (dtSeconds <= 0) return target;
  const k = 1 - Math.exp(-(dtSeconds * 1000) / Math.max(1, timeConstantMs));
  return current + (target - current) * k;
}
