import type { PaddlePose } from '../control/paddleController';
import type { Vec3 } from '../motion/vector';

export const TABLE_PHYSICS = {
  length: 2.74,
  width: 1.525,
  height: 0.76,
  netHeight: 0.1525,
};
export const BALL_RADIUS = 0.02;
export const BLADE_RADIUS = 0.078;
export const GRIP_TO_BLADE = 0.13;

export type BallStatus = 'idle' | 'held' | 'in-play' | 'out';

export interface BallState {
  position: Vec3;
  velocity: Vec3;
  status: BallStatus;
  bounces: number;
  paddleHits: number;
  lastEvent: string;
}

export type BallEventKind = 'launch' | 'table-bounce' | 'net' | 'paddle-hit' | 'out' | 'opponent-hit';
export interface BallPhysicsEvent {
  kind: BallEventKind;
  side?: 'player' | 'opponent';
  speed?: number;
}

export interface OpponentPaddlePose {
  position: Vec3;
  swing: number;
  roll: number;
  pitch: number;
  yaw: number;
  stroke: 'forehand' | 'backhand';
}

const GRAVITY = -9.81;
const FIXED_DT = 1 / 240;
const ASSISTED_RADIUS = 0.14;
const ASSISTED_FRONT = 0.35;
const ASSISTED_BEHIND = 0.12;
// The opening ball is an onboarding feed: it should be playable from the
// calibrated ready stance before a rally asks the player to retreat or smash.
const OPENING_COLLISION_ASSIST = 0.82;
const OPENING_NET_CLEARANCE_ASSIST = 1;
const OPPONENT_READY_POSITION = { x: 0, y: 0.92, z: -1.08 };
// The far player is right-handed and faces the camera, so their forehand is
// seen on the left of the screen. Keep the racket across the body in a compact
// ready stance, then mirror it for a backhand interception on the right.
const OPPONENT_FOREHAND_ROLL = 1.08;
const OPPONENT_BACKHAND_ROLL = -1.08;
const OPPONENT_READY_PITCH = -0.1;
// The CPU picks a strike depth along the ball's predicted path: at its ready
// plane when the bounce leaves the ball at a comfortable height, or further
// back when a deep or high bounce needs time to come down (or to rise).
const OPPONENT_STRIKE_Z_NEAR = -1.0;
const OPPONENT_STRIKE_Z_FAR = -1.6;
const OPPONENT_BLADE_MIN_Y = 0.86;
const OPPONENT_BLADE_MAX_Y = 1.34;
const OPPONENT_LATERAL_SPEED = 2.6;
const OPPONENT_VERTICAL_SPEED = 2.2;
const OPPONENT_DEPTH_SPEED = 2.0;
// Assisted returns may use the whole table, but should not turn a successful
// edge reach into an unavoidable sideline fault because of noisy 2D velocity.
const ASSISTED_LANDING_HALF_WIDTH = TABLE_PHYSICS.width / 2 - BALL_RADIUS - 0.06;

export interface BallAssistance {
  collision: number;
  netClearance: number;
}
const DEFAULT_ASSISTANCE: BallAssistance = { collision: 0.65, netClearance: 0.4 };
export interface BallTuning {
  feedSpeed: number;
  drag: number;
  tableRestitution: number;
  paddleRestitution: number;
  swingTransfer: number;
}
const DEFAULT_TUNING: BallTuning = { feedSpeed: 3.2, drag: 0.12, tableRestitution: 0.88, paddleRestitution: 0.86, swingTransfer: 0.65 };

function initialState(): BallState {
  return {
    position: { x: 0, y: 1.05, z: -1.05 },
    velocity: { x: 0, y: 0, z: 0 },
    status: 'idle',
    bounces: 0,
    paddleHits: 0,
    lastEvent: 'Ready to launch',
  };
}

export function bladeCenter(paddle: PaddlePose): Vec3 {
  const sr = Math.sin(paddle.roll), cr = Math.cos(paddle.roll);
  const sp = Math.sin(paddle.pitch), cp = Math.cos(paddle.pitch);
  const sy = Math.sin(paddle.yaw), cy = Math.cos(paddle.yaw);
  const x1 = -sr * GRIP_TO_BLADE;
  const y1 = cr * GRIP_TO_BLADE;
  const y2 = y1 * cp;
  const z2 = y1 * sp;
  return {
    x: paddle.position.x + x1 * cy + z2 * sy,
    y: paddle.position.y + y2,
    z: paddle.position.z - x1 * sy + z2 * cy,
  };
}

export class BallSimulation {
  state: BallState = initialState();
  opponentPaddle: OpponentPaddlePose = {
    position: { ...OPPONENT_READY_POSITION },
    swing: 0,
    roll: OPPONENT_FOREHAND_ROLL,
    pitch: OPPONENT_READY_PITCH,
    yaw: 0,
    stroke: 'forehand',
  };
  private accumulator = 0;
  private previousTime = 0;
  private hitCooldown = 0;
  private events: BallPhysicsEvent[] = [];
  private tuning: BallTuning = { ...DEFAULT_TUNING };
  private openingReturn = false;
  private previousBlade: Vec3 | null = null;
  private previousOpponentBlade: Vec3 | null = null;
  private opponentActive = false;
  private opponentReady = false;

  configure(tuning: BallTuning): void {
    this.tuning = { ...tuning };
  }

  launch(feedSpeed = this.tuning.feedSpeed): void {
    const start = { x: 0, y: 1.08, z: -1.05 };
    // Bounce near the front of the player's half. A deeper bounce is still
    // climbing at the normal ready position, forcing the player to step back
    // before they have even started a rally.
    const targetZ = 0.48;
    const flightTime = (targetZ - start.z) / feedSpeed;
    const targetY = TABLE_PHYSICS.height + BALL_RADIUS;
    // Solve the vertical launch velocity so the first bounce lands well inside
    // the player's half. Slowing z without this calculation made the ball fall
    // beside the net before it ever became playable.
    const launchY = (targetY - start.y - 0.5 * GRAVITY * flightTime ** 2) / flightTime;
    this.state = {
      position: start,
      velocity: { x: 0, y: launchY, z: feedSpeed },
      status: 'in-play',
      bounces: 0,
      paddleHits: 0,
      lastEvent: 'Slow training feed',
    };
    this.accumulator = 0;
    this.previousTime = 0;
    this.hitCooldown = 0;
    this.openingReturn = true;
    this.previousBlade = null;
    this.previousOpponentBlade = null;
    this.opponentReady = false;
    this.events = [{ kind: 'launch', side: 'opponent' }];
  }

  reset(): void {
    this.state = initialState();
    this.accumulator = 0;
    this.previousTime = 0;
    this.hitCooldown = 0;
    this.openingReturn = false;
    this.previousBlade = null;
    this.previousOpponentBlade = null;
    this.opponentActive = false;
    this.opponentReady = false;
    this.opponentPaddle = {
      position: { ...OPPONENT_READY_POSITION }, swing: 0,
      roll: OPPONENT_FOREHAND_ROLL, pitch: OPPONENT_READY_PITCH, yaw: 0, stroke: 'forehand',
    };
    this.events = [];
  }

  consumeEvents(): BallPhysicsEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  holdForServe(): void {
    this.state = {
      position: { x: 0, y: 1.12, z: -1.42 }, velocity: { x: 0, y: 0, z: 0 },
      status: 'held', bounces: 0, paddleHits: 0, lastEvent: 'Ball held for serve',
    };
    this.accumulator = 0;
    this.previousTime = 0;
    this.hitCooldown = 0;
    this.openingReturn = false;
    this.previousBlade = null;
    this.previousOpponentBlade = null;
    this.opponentReady = false;
    this.events = [];
  }

  endPoint(): void {
    if (this.state.status === 'in-play') {
      this.state.status = 'out';
      this.state.velocity = { x: 0, y: 0, z: 0 };
    }
    this.events = [];
    this.opponentReady = false;
  }

  setOpponentActive(active: boolean): void {
    this.opponentActive = active;
    if (!active) this.opponentReady = false;
  }

  setOpponentReady(ready: boolean): void {
    this.opponentReady = this.opponentActive && ready;
  }

  opponentReturn(): void {
    const s = this.state;
    if (s.status !== 'in-play') return;
    // Aim the bounce modestly across court. Lateral momentum continues after
    // the bounce, so the old ±0.35 m bounce target could carry the ball beyond
    // the player's blade by the time it reached the actual strike zone.
    // Because the lower drive bounces earlier, it has more distance to keep
    // travelling sideways afterward. Aim the bounce nearer the centre so an
    // angled CPU contact does not become an unreachable post-bounce hook.
    const targetX = Math.max(-0.14, Math.min(0.14, -s.position.x * 0.12));
    // Physical CPU contact now happens behind the far edge of the table. Use a
    // firmer, shallower drive to an earlier bounce; retaining the old slow
    // speed from this greater distance forced every return into a tall lob.
    const targetZ = 0.48;
    const returnSpeed = Math.max(3.6, this.tuning.feedSpeed * 1.15);
    const travelTime = Math.max(0.42, Math.min(0.95, (targetZ - s.position.z) / returnSpeed));
    const targetY = TABLE_PHYSICS.height + BALL_RADIUS;
    s.velocity.x = (targetX - s.position.x) / travelTime;
    s.velocity.z = (targetZ - s.position.z) / travelTime;
    s.velocity.y = (targetY - s.position.y - 0.5 * GRAVITY * travelTime ** 2) / travelTime;
    s.position.z += 0.025;
    s.lastEvent = 'Opponent return';
    this.hitCooldown = 0.08;
    this.openingReturn = false;
    this.opponentReady = false;
    this.opponentPaddle.swing = 1;
    this.events.push({ kind: 'opponent-hit', side: 'opponent', speed: Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z) });
  }

  /** Advance using a 240 Hz fixed timestep, independent of render/camera FPS. */
  update(nowMs: number, paddle: PaddlePose, assistance: BallAssistance = DEFAULT_ASSISTANCE): BallState {
    if (!this.previousTime) {
      this.previousTime = nowMs;
      return this.state;
    }
    const elapsed = Math.min(0.05, Math.max(0, (nowMs - this.previousTime) / 1000));
    this.previousTime = nowMs;
    if (this.state.status !== 'in-play') return this.state;
    this.accumulator += elapsed;
    while (this.accumulator >= FIXED_DT) {
      this.step(FIXED_DT, paddle, assistance);
      this.accumulator -= FIXED_DT;
    }
    return this.state;
  }

  /** Public for deterministic physics tests. */
  step(dt: number, paddle: PaddlePose, assistance: BallAssistance = DEFAULT_ASSISTANCE): void {
    const s = this.state;
    if (s.status !== 'in-play') return;
    const previous = { ...s.position };
    this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    this.updateOpponentPaddle(dt);

    const drag = Math.exp(-this.tuning.drag * dt);
    s.velocity.x *= drag;
    s.velocity.y = s.velocity.y * drag + GRAVITY * dt;
    s.velocity.z *= drag;
    s.position.x += s.velocity.x * dt;
    s.position.y += s.velocity.y * dt;
    s.position.z += s.velocity.z * dt;

    const currentBlade = paddle.tracked ? bladeCenter(paddle) : null;
    this.collidePaddle(previous, paddle, assistance, currentBlade);
    this.collideOpponentPaddle(previous);
    this.collideTable(previous);
    this.collideNet(previous);
    // Never bridge a tracking gap: reacquisition must not create a collision
    // along the line from the last-known pose to the newly detected hand.
    this.previousBlade = currentBlade;

    if (s.position.y < -0.25 || Math.abs(s.position.x) > 2.2 || Math.abs(s.position.z) > 3.2) {
      s.status = 'out';
      s.lastEvent = 'Ball out — launch again';
      this.events.push({ kind: 'out' });
    }
  }

  /**
   * Where the incoming ball crosses the plane z = zPlane, following its
   * parabola through a table bounce if it lands first. Drag is ignored: over
   * the ~0.5 s of a return it shifts the crossing by only a few millimetres.
   */
  private predictCrossing(zPlane: number): { x: number; y: number; bounced: boolean } | null {
    const s = this.state;
    if (s.velocity.z >= -0.05 || s.position.z <= zPlane) return null;
    const surface = TABLE_PHYSICS.height + BALL_RADIUS;
    let p = { ...s.position };
    let v = { ...s.velocity };
    let bounced = false;
    for (let leg = 0; leg < 3; leg++) {
      const tPlane = (zPlane - p.z) / v.z;
      // Time until the ball falls back to the table surface on this arc.
      const a = 0.5 * GRAVITY;
      const disc = v.y * v.y - 4 * a * (p.y - surface);
      const tSurface = disc >= 0 ? (-v.y - Math.sqrt(disc)) / (2 * a) : Infinity;
      const zAtSurface = p.z + v.z * tSurface;
      const landsOnTable = tSurface > 1e-4 && tSurface < tPlane
        && Math.abs(p.x + v.x * tSurface) <= TABLE_PHYSICS.width / 2 && Math.abs(zAtSurface) <= TABLE_PHYSICS.length / 2;
      if (!landsOnTable) {
        return { x: p.x + v.x * tPlane, y: p.y + v.y * tPlane + a * tPlane * tPlane, bounced };
      }
      p = { x: p.x + v.x * tSurface, y: surface, z: zAtSurface };
      v = { x: v.x * 0.985, y: -(v.y + 2 * a * tSurface) * this.tuning.tableRestitution, z: v.z * 0.985 };
      bounced = true;
    }
    return null;
  }

  private updateOpponentPaddle(dt: number): void {
    const paddle = this.opponentPaddle;
    paddle.swing = Math.max(0, paddle.swing - dt * 7);
    if (!this.opponentActive) {
      paddle.position.x = moveToward(paddle.position.x, 0, 2.4 * dt);
      paddle.position.y = moveToward(paddle.position.y, 0.92, 1.8 * dt);
      paddle.position.z = moveToward(paddle.position.z, OPPONENT_READY_POSITION.z, OPPONENT_DEPTH_SPEED * dt);
      paddle.roll = moveToward(paddle.roll, OPPONENT_FOREHAND_ROLL, 5 * dt);
      paddle.pitch = moveToward(paddle.pitch, OPPONENT_READY_PITCH, 3 * dt);
      paddle.yaw = moveToward(paddle.yaw, 0, 3 * dt);
      this.previousOpponentBlade = null;
      return;
    }

    const s = this.state;
    let targetBladeX = -Math.sin(OPPONENT_FOREHAND_ROLL) * GRIP_TO_BLADE;
    let targetBladeY = OPPONENT_READY_POSITION.y + Math.cos(OPPONENT_FOREHAND_ROLL) * GRIP_TO_BLADE;
    let targetZ = OPPONENT_READY_POSITION.z;
    let targetRoll = OPPONENT_FOREHAND_ROLL;
    let targetPitch = OPPONENT_READY_PITCH;
    let targetYaw = 0;
    if (s.status === 'in-play' && s.velocity.z < -0.15) {
      // Scan strike depths from the ready plane backward and take the first
      // where the ball has already bounced and sits at a hittable height. A
      // real player steps back for a deep or high ball instead of reaching
      // for it on the rise or letting it pass overhead.
      let best: { x: number; y: number; z: number; miss: number } | null = null;
      for (let z = OPPONENT_READY_POSITION.z; z >= OPPONENT_STRIKE_Z_FAR - 1e-6; z -= 0.05) {
        const crossing = this.predictCrossing(z);
        if (!crossing) continue;
        const miss = !crossing.bounced ? 1
          : Math.max(0, OPPONENT_BLADE_MIN_Y - crossing.y, crossing.y - OPPONENT_BLADE_MAX_Y);
        if (!best || miss < best.miss) best = { ...crossing, z, miss };
        if (miss === 0) break;
      }
      if (!best) {
        const near = this.predictCrossing(OPPONENT_STRIKE_Z_NEAR);
        if (near) best = { ...near, z: OPPONENT_STRIKE_Z_NEAR, miss: 1 };
      }
      if (best) {
        targetBladeX = Math.max(-0.72, Math.min(0.72, best.x));
        targetBladeY = Math.max(OPPONENT_BLADE_MIN_Y, Math.min(OPPONENT_BLADE_MAX_Y, best.y));
        targetZ = best.z;
      }
      // A right-handed opponent uses a forehand on screen-left and crosses
      // into a backhand on screen-right. A small centre deadband stops the
      // racket from flipping sides when prediction noise straddles zero.
      if (targetBladeX < -0.04) paddle.stroke = 'forehand';
      else if (targetBladeX > 0.08) paddle.stroke = 'backhand';
      targetRoll = paddle.stroke === 'forehand' ? OPPONENT_FOREHAND_ROLL : OPPONENT_BACKHAND_ROLL;
      targetPitch = Math.max(-0.24, Math.min(0.12, OPPONENT_READY_PITCH + s.velocity.y * 0.035));
      targetYaw = Math.max(-0.18, Math.min(0.18, -s.velocity.x * 0.045));
    }
    paddle.roll = moveToward(paddle.roll, targetRoll, 7.5 * dt);
    paddle.pitch = moveToward(paddle.pitch, targetPitch, 4.5 * dt);
    paddle.yaw = moveToward(paddle.yaw, targetYaw, 4.5 * dt);
    // Solve the grip position from the desired blade position. This is what
    // makes the racket rotate around a hand instead of sliding an upright bat
    // directly onto every ball.
    const bladeOffsetX = -Math.sin(paddle.roll) * GRIP_TO_BLADE;
    const bladeOffsetY = Math.cos(paddle.roll) * Math.cos(paddle.pitch) * GRIP_TO_BLADE;
    // Positioning starts as soon as the ball is on its way, from the predicted
    // bounce, so the CPU is set before the ball arrives. Hitting still waits
    // for the legal bounce (opponentReady).
    paddle.position.x = moveToward(paddle.position.x, targetBladeX - bladeOffsetX, OPPONENT_LATERAL_SPEED * dt);
    paddle.position.y = moveToward(paddle.position.y, targetBladeY - bladeOffsetY, OPPONENT_VERTICAL_SPEED * dt);
    paddle.position.z = moveToward(paddle.position.z, targetZ, OPPONENT_DEPTH_SPEED * dt);
  }

  private opponentBladeCenter(): Vec3 {
    const paddle = this.opponentPaddle;
    const sr = Math.sin(paddle.roll), cr = Math.cos(paddle.roll);
    const sp = Math.sin(paddle.pitch), cp = Math.cos(paddle.pitch);
    const sy = Math.sin(paddle.yaw), cy = Math.cos(paddle.yaw);
    const x1 = -sr * GRIP_TO_BLADE;
    const y1 = cr * GRIP_TO_BLADE;
    const y2 = y1 * cp;
    const z2 = -y1 * sp;
    return {
      x: paddle.position.x + x1 * cy + z2 * sy,
      y: paddle.position.y + y2,
      z: paddle.position.z - x1 * sy + z2 * cy,
    };
  }

  private collideOpponentPaddle(previous: Vec3): void {
    const s = this.state;
    const blade = this.opponentBladeCenter();
    if (!this.opponentActive || !this.opponentReady || this.hitCooldown > 0 || s.velocity.z >= 0) {
      this.previousOpponentBlade = blade;
      return;
    }
    const previousBlade = this.previousOpponentBlade ?? blade;
    const nearZ = Math.min(previousBlade.z, blade.z) - BALL_RADIUS - 0.025;
    const farZ = Math.max(previousBlade.z, blade.z) + BALL_RADIUS + 0.025;
    if (previous.z < nearZ || s.position.z > farZ) {
      this.previousOpponentBlade = blade;
      return;
    }
    const dz = s.position.z - previous.z;
    const targetZ = Math.max(nearZ, Math.min(farZ, blade.z + BALL_RADIUS));
    const alpha = Math.max(0, Math.min(1, Math.abs(dz) > 1e-8 ? (targetZ - previous.z) / dz : 0));
    const ballX = previous.x + (s.position.x - previous.x) * alpha;
    const ballY = previous.y + (s.position.y - previous.y) * alpha;
    const sweepX = blade.x - previousBlade.x;
    const sweepY = blade.y - previousBlade.y;
    const sweepLengthSq = sweepX * sweepX + sweepY * sweepY;
    const sweepT = sweepLengthSq > 1e-8
      ? Math.max(0, Math.min(1, ((ballX - previousBlade.x) * sweepX + (ballY - previousBlade.y) * sweepY) / sweepLengthSq))
      : 1;
    const contactX = previousBlade.x + sweepX * sweepT;
    const contactY = previousBlade.y + sweepY * sweepT;
    this.previousOpponentBlade = blade;
    if (Math.hypot(ballX - contactX, ballY - contactY) > BLADE_RADIUS + BALL_RADIUS) return;
    s.position = { x: ballX, y: ballY, z: blade.z + BALL_RADIUS + 0.002 };
    this.opponentReturn();
  }

  private collidePaddle(previous: Vec3, paddle: PaddlePose, assistance: BallAssistance, blade: Vec3 | null): void {
    const s = this.state;
    if (!paddle.tracked || !blade || this.hitCooldown > 0 || s.velocity.z <= 0) return;
    const previousBlade = this.previousBlade ?? blade;
    const requestedCollisionAssist = Math.max(0, Math.min(1, assistance.collision));
    const assist = this.openingReturn
      ? Math.max(requestedCollisionAssist, OPENING_COLLISION_ASSIST)
      : requestedCollisionAssist;
    const contactRadius = BLADE_RADIUS + (ASSISTED_RADIUS - BLADE_RADIUS) * assist;
    const contactFront = 0.025 + (ASSISTED_FRONT - 0.025) * assist;
    const contactBehind = 0.015 + (ASSISTED_BEHIND - 0.015) * assist;
    const nearZ = Math.min(previousBlade.z, blade.z) - contactFront - BALL_RADIUS;
    const farZ = Math.max(previousBlade.z, blade.z) + contactBehind + BALL_RADIUS;
    if (previous.z > farZ || s.position.z < nearZ) return;
    const dz = s.position.z - previous.z;
    const targetZ = Math.min(farZ, Math.max(nearZ, blade.z - BALL_RADIUS));
    const alpha = Math.min(1, Math.max(0, Math.abs(dz) > 1e-8 ? (targetZ - previous.z) / dz : 0));
    const x = previous.x + (s.position.x - previous.x) * alpha;
    const y = previous.y + (s.position.y - previous.y) * alpha;
    // Test against the blade's actual path since the previous physics sample.
    // This catches a fast edge swing without inventing a larger stationary
    // paddle around the player's hand.
    const sweepX = blade.x - previousBlade.x;
    const sweepY = blade.y - previousBlade.y;
    const sweepLengthSq = sweepX * sweepX + sweepY * sweepY;
    const sweepT = sweepLengthSq > 1e-8
      ? Math.max(0, Math.min(1, ((x - previousBlade.x) * sweepX + (y - previousBlade.y) * sweepY) / sweepLengthSq))
      : 1;
    const contactBlade = {
      x: previousBlade.x + sweepX * sweepT,
      y: previousBlade.y + sweepY * sweepT,
      z: previousBlade.z + (blade.z - previousBlade.z) * sweepT,
    };
    if (Math.hypot(x - contactBlade.x, y - contactBlade.y) > contactRadius + BALL_RADIUS) return;

    s.position = { x, y, z: contactBlade.z - BALL_RADIUS - 0.002 };
    const minimumReturnSpeed = this.openingReturn ? 3 : 2.2;
    const outgoingZ = -Math.max(minimumReturnSpeed, Math.abs(s.velocity.z) * this.tuning.paddleRestitution + Math.max(0, -paddle.velocity.z) * this.tuning.swingTransfer);
    const faceLift = Math.sin(paddle.pitch) * Math.abs(outgoingZ) * 0.75;
    const faceSide = Math.sin(paddle.yaw) * Math.abs(outgoingZ) * 0.65;
    const transferredY = s.velocity.y * 0.55 + paddle.velocity.y * 0.9 + faceLift;
    // Aim for modest clearance over the net. Without paddle pitch/yaw yet,
    // preserving a descending incoming y velocity makes nearly every return hit it.
    const timeToNet = Math.max(0.08, s.position.z / Math.abs(outgoingZ));
    const netClearanceY = TABLE_PHYSICS.height + TABLE_PHYSICS.netHeight + BALL_RADIUS + 0.08;
    const requiredNetLift = (netClearanceY - s.position.y - 0.5 * GRAVITY * timeToNet ** 2) / timeToNet;
    // Aim through a legal landing point rather than merely scraping over the
    // net. The first return gets full onboarding help; later returns blend this
    // target by the configured gameplay assistance. Previously only the first
    // contact used this calculation, so every neutral follow-up fell back onto
    // the player's half even though the paddle had made a valid contact.
    const returnTargetZ = -0.65;
    const timeToTargetBounce = Math.max(0.2, (s.position.z - returnTargetZ) / Math.abs(outgoingZ));
    const tableSurface = TABLE_PHYSICS.height + BALL_RADIUS;
    const requiredTargetLift = (tableSurface - s.position.y - 0.5 * GRAVITY * timeToTargetBounce ** 2) / timeToTargetBounce;
    const requiredLift = Math.max(requiredNetLift, requiredTargetLift);
    const requestedNetAssist = Math.max(0, Math.min(1, assistance.netClearance));
    const netAssist = this.openingReturn
      ? Math.max(requestedNetAssist, OPENING_NET_CLEARANCE_ASSIST)
      : Math.max(requestedNetAssist, Math.min(1, requestedCollisionAssist + 0.25));
    // A fast lateral reach should move the blade to the ball, not launch the
    // ball sideways with the full tracked wrist velocity. Keep deliberate face
    // angle authoritative while damping noisy lateral translation. A small
    // centre bias near the sidelines prevents assisted edge contacts from
    // turning into automatic wide faults.
    const lateralTranslation = paddle.velocity.x * this.tuning.swingTransfer * 0.4;
    const sidelineRecovery = -s.position.x * 0.45 * requestedCollisionAssist;
    const rawOutgoingX = s.velocity.x * 0.55 + lateralTranslation + faceSide + sidelineRecovery;
    const predictedLandingX = s.position.x + rawOutgoingX * timeToTargetBounce;
    const legalLandingX = Math.max(-ASSISTED_LANDING_HALF_WIDTH, Math.min(ASSISTED_LANDING_HALF_WIDTH, predictedLandingX));
    // Default assistance fully corrects only an otherwise-wide landing. Lower
    // realism presets retain progressively more of the player's face angle.
    const placementAssist = Math.min(1, requestedCollisionAssist + 0.35);
    const guidedLandingX = predictedLandingX + (legalLandingX - predictedLandingX) * placementAssist;
    // Webcam strokes are mostly upward brushes, and the tracked wrist's
    // vertical speed transfers almost fully, so a strong swing used to launch
    // most returns over the far end. The same assistance that adds missing
    // lift now also trims lift beyond what still lands deep on the table.
    const liftedY = transferredY + Math.max(0, requiredLift - transferredY) * netAssist;
    const deepLandingZ = -(TABLE_PHYSICS.length / 2 - 0.12);
    const timeToDeepBounce = Math.max(0.2, (s.position.z - deepLandingZ) / Math.abs(outgoingZ));
    const maximumLift = (tableSurface - s.position.y - 0.5 * GRAVITY * timeToDeepBounce ** 2) / timeToDeepBounce;
    s.velocity = {
      x: (guidedLandingX - s.position.x) / timeToTargetBounce,
      y: liftedY - Math.max(0, liftedY - Math.max(maximumLift, requiredNetLift)) * netAssist,
      z: outgoingZ,
    };
    s.paddleHits++;
    s.lastEvent = `Paddle hit #${s.paddleHits}`;
    this.events.push({ kind: 'paddle-hit', side: 'player', speed: Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z) });
    this.hitCooldown = 0.08;
    this.openingReturn = false;
  }

  private collideTable(previous: Vec3): void {
    const s = this.state;
    const surface = TABLE_PHYSICS.height + BALL_RADIUS;
    const onTable = Math.abs(s.position.x) <= TABLE_PHYSICS.width / 2 + BALL_RADIUS && Math.abs(s.position.z) <= TABLE_PHYSICS.length / 2 + BALL_RADIUS;
    if (!onTable || s.velocity.y >= 0 || previous.y < surface || s.position.y > surface) return;
    const impactSpeed = Math.abs(s.velocity.y);
    s.position.y = surface;
    s.velocity.y = Math.abs(s.velocity.y) * this.tuning.tableRestitution;
    s.velocity.x *= 0.985;
    s.velocity.z *= 0.985;
    s.bounces++;
    s.lastEvent = `Table bounce #${s.bounces}`;
    this.events.push({ kind: 'table-bounce', side: s.position.z >= 0 ? 'player' : 'opponent', speed: impactSpeed });
  }

  private collideNet(previous: Vec3): void {
    const s = this.state;
    const crossed = (previous.z < 0 && s.position.z >= 0) || (previous.z > 0 && s.position.z <= 0);
    if (!crossed || Math.abs(s.position.x) > TABLE_PHYSICS.width / 2 + 0.15) return;
    if (s.position.y - BALL_RADIUS > TABLE_PHYSICS.height + TABLE_PHYSICS.netHeight) return;
    s.position.z = previous.z < 0 ? -BALL_RADIUS : BALL_RADIUS;
    s.velocity.z *= -0.35;
    s.velocity.x *= 0.75;
    s.lastEvent = 'Net contact';
    this.events.push({ kind: 'net' });
  }
}

function moveToward(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}
