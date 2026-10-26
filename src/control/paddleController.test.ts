import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../config';
import { BLADE_RADIUS, TABLE_PHYSICS, bladeCenter } from '../physics/ballPhysics';
import { MotionEstimator } from '../motion/motionEstimator';
import { defaultCalibration, fitRangeToFrame } from './calibration';
import { ARM_RIG, PADDLE_AREA, PaddleController, solveElbow } from './paddleController';

function trackedMotion(x: number) {
  const motion = MotionEstimator.initialState();
  motion.status = 'tracking';
  motion.position = { x, y: 0, z: 0 };
  motion.rawPosition = { ...motion.position };
  return motion;
}

function distanceCalibration() {
  return { ...defaultCalibration('camera'), neutralFaceScale: 0.3, neutralTorsoScale: 0.3, neutralSet: true };
}

describe('PaddleController handed orientation', () => {
  it('extends a right-handed blade toward the right in ready position', () => {
    const controller = new PaddleController();
    const pose = controller.update(trackedMotion(0), defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(pose.roll).toBeCloseTo(-Math.PI / 2);
    expect(bladeCenter(pose).x).toBeGreaterThan(pose.position.x);
  });

  it('turns a right-handed blade toward the left on a far cross-body reach', () => {
    const controller = new PaddleController();
    const pose = controller.update(trackedMotion(-0.45), defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(pose.roll).toBeCloseTo(Math.PI / 2);
    expect(bladeCenter(pose).x).toBeLessThan(pose.position.x);
  });

  it('keeps movement linear before range calibration', () => {
    const near = new PaddleController().update(trackedMotion(0.1), defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    const far = new PaddleController().update(trackedMotion(0.2), defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(far.position.x).toBeCloseTo(near.position.x * 2);
  });

  it('leads a fast lateral reach without changing camera distance', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0.1);
    motion.velocity.x = 2;
    motion.speed = 2;
    motion.strokeSpeed = 2;
    const pose = controller.update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    const unpredicted = new PaddleController().update(trackedMotion(0.1), defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(pose.position.x).toBeGreaterThan(unpredicted.position.x);
    expect(pose.playerRetreat).toBe(unpredicted.playerRetreat);
    expect(pose.position.z).toBe(unpredicted.position.z);
  });

  it('uses the fresh wrist during a fast stroke instead of trailing the filtered pose', () => {
    const responsiveController = new PaddleController();
    const motion = trackedMotion(0);
    motion.rawPosition.x = 0.3;
    motion.speed = 2.5;
    motion.strokeSpeed = 2.5;
    motion.acceptedThisFrame = true;
    const responsive = responsiveController.update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);

    const filteredOnly = trackedMotion(0);
    filteredOnly.rawPosition.x = 0.3;
    filteredOnly.acceptedThisFrame = true;
    const slow = new PaddleController().update(filteredOnly, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(responsive.position.x).toBeGreaterThan(slow.position.x + 0.1);
  });

  it('literally freezes the rendered hand and arm while tracking is holding', () => {
    const controller = new PaddleController();
    const moving = trackedMotion(0.28);
    moving.velocity.x = 3;
    moving.frameVelocity.x = 3;
    moving.strokeSpeed = 3;
    moving.acceptedThisFrame = true;
    moving.timestamp = 100;
    const live = controller.update(moving, defaultCalibration('camera'), DEFAULT_SETTINGS, 116);
    const hand = { ...live.position };
    const elbow = { ...live.arm!.elbow };

    const stale = trackedMotion(-0.25);
    stale.status = 'holding';
    const held = controller.update(stale, defaultCalibration('camera'), DEFAULT_SETTINGS, 132);
    expect(held.position).toEqual(hand);
    expect(held.arm!.elbow).toEqual(elbow);
    expect(held.velocity).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('eases the catch-up after a one-frame tracking hold', () => {
    const controller = new PaddleController();
    const cal = defaultCalibration('camera');
    const before = { ...controller.update(trackedMotion(0), cal, DEFAULT_SETTINGS, 100).position };
    const heldMotion = trackedMotion(0.3);
    heldMotion.status = 'holding';
    controller.update(heldMotion, cal, DEFAULT_SETTINGS, 116);
    const resumed = trackedMotion(0.3);
    resumed.acceptedThisFrame = true;
    const after = controller.update(resumed, cal, DEFAULT_SETTINGS, 132).position;
    const target = new PaddleController().update(trackedMotion(0.3), cal, DEFAULT_SETTINGS, 100).position;
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.x - before.x).toBeLessThan((target.x - before.x) * 0.35);
  });

  it('limits a tracker teleport to a physically continuous render step', () => {
    const controller = new PaddleController();
    const before = { ...controller.update(trackedMotion(-0.3), defaultCalibration('camera'), DEFAULT_SETTINGS, 100).position };
    const jump = trackedMotion(0.45);
    jump.rawPosition = { ...jump.position };
    jump.acceptedThisFrame = true;
    jump.velocity.x = 20;
    jump.frameVelocity.x = 20;
    jump.strokeSpeed = 20;
    jump.timestamp = 116;
    const after = controller.update(jump, defaultCalibration('camera'), DEFAULT_SETTINGS, 116).position;
    expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)).toBeLessThanOrEqual(8 * 0.016 + 1e-6);
  });

  it('starts the return on the first frame of a direction reversal', () => {
    const controller = new PaddleController();
    const outgoing = trackedMotion(0.24);
    outgoing.rawPosition.x = 0.27;
    outgoing.velocity.x = 2;
    outgoing.frameVelocity.x = 2;
    outgoing.strokeSpeed = 2;
    outgoing.acceptedThisFrame = true;
    outgoing.timestamp = 100;
    const edge = { ...controller.update(outgoing, defaultCalibration('camera'), DEFAULT_SETTINGS, 100).position };

    // Windowed velocity still points outward while the newest camera frame has
    // already begun returning. strokeSpeed is deliberately zero on disagreement.
    const returning = trackedMotion(0.2);
    returning.rawPosition.x = 0.16;
    returning.velocity.x = 1;
    returning.frameVelocity.x = -3;
    returning.strokeSpeed = 0;
    returning.acceptedThisFrame = true;
    returning.timestamp = 116;
    const firstReturn = controller.update(returning, defaultCalibration('camera'), DEFAULT_SETTINGS, 116).position;
    expect(firstReturn.x).toBeLessThan(edge.x - 0.02);
  });

  it('does not add anatomical gain after a measured range calibration', () => {
    const controller = new PaddleController();
    const cal = { ...defaultCalibration('camera'), rangeSet: true };
    const motion = trackedMotion(0.2);
    const pose = controller.update(motion, cal, DEFAULT_SETTINGS, 100);
    // The only adjustment is keeping the reach inside the camera picture.
    expect(pose.normalized.x).toBeCloseTo((0.2 / fitRangeToFrame(cal, motion).right) * DEFAULT_SETTINGS.gain);
  });

  it('reaches the end of the paddle zone with the hand still inside the camera picture', () => {
    // Ready hand right of centre (image x ≈ 0.65), as a right-hander stands.
    const cal = { ...defaultCalibration('camera'), neutral: { x: 0.2, y: 0, z: 0 }, neutralSet: true };
    // Hand at image x 0.88: still 12% inside the picture, clear of the
    // unreliable edge strip, yet already at the paddle's full reach.
    const atRight = trackedMotion((0.88 - 0.5) * (4 / 3));
    const right = new PaddleController().update(atRight, cal, DEFAULT_SETTINGS, 100);
    expect(right.normalized.x).toBeGreaterThan(1.14);
    // The other side keeps its full configured reach where the picture allows it.
    expect(fitRangeToFrame(cal, atRight).left).toBeCloseTo(cal.range.left);
  });

  it('attaches a proportionate rendered arm to the paddle grip', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.shoulderPosition = { x: -0.05, y: 0.2, z: 0 };
    const pose = controller.update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(pose.arm?.hand).toEqual(pose.position);
    const distance = (a: typeof pose.position, b: typeof pose.position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const fore = distance(pose.arm!.hand, pose.arm!.elbow);
    const upper = distance(pose.arm!.elbow, pose.arm!.shoulder);
    expect(fore).toBeGreaterThan(0.15);
    expect(upper).toBeGreaterThan(0.15);
    expect(upper / fore).toBeGreaterThan(0.8);
    expect(upper / fore).toBeLessThan(1.35);
    // The shoulder belongs to the player's body: above and behind the grip.
    expect(pose.arm!.shoulder.y).toBeGreaterThan(pose.arm!.hand.y + 0.18);
    expect(pose.arm!.shoulder.z).toBeGreaterThan(pose.arm!.hand.z + 0.1);
    // ...but stays compact, so the rendered arm doesn't fill the screen centre.
    expect(distance(pose.arm!.hand, pose.arm!.shoulder)).toBeLessThan(0.45);
    // Reference composition: a right-handed arm enters from the upper-left and
    // runs down-right toward the paddle rather than lying across the tabletop.
    expect(pose.arm!.shoulder.x).toBeLessThan(pose.arm!.hand.x);
  });

  it('keeps the complete sideways blade above the near table edge', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.position.y = -0.3;
    motion.rawPosition.y = -0.3;
    const pose = controller.update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    const blade = bladeCenter(pose);
    expect(blade.y - BLADE_RADIUS).toBeGreaterThanOrEqual(TABLE_PHYSICS.height + 0.0119);
    expect(pose.arm!.hand).toEqual(pose.position);
  });

  it('keeps the shoulder still while the hand moves within reach', () => {
    const controller = new PaddleController();
    const cal = defaultCalibration('camera');
    const at = (x: number, t: number) => {
      const motion = trackedMotion(x);
      motion.shoulderPosition = { x: -0.05, y: 0.2, z: 0 };
      return controller.update(motion, cal, DEFAULT_SETTINGS, t);
    };
    const before = { ...at(0, 100).arm!.shoulder };
    let pose = at(-0.12, 116);
    for (let t = 132; t < 800; t += 16) pose = at(-0.12, t);
    expect(Math.hypot(pose.arm!.shoulder.x - before.x, pose.arm!.shoulder.y - before.y)).toBeLessThan(0.02);
    expect(Math.abs(pose.arm!.hand.x - pose.position.x)).toBe(0);
  });

  it('moves the shoulder with the body when the player steps sideways', () => {
    const controller = new PaddleController();
    const cal = defaultCalibration('camera');
    const standing = trackedMotion(0);
    standing.shoulderPosition = { x: -0.05, y: 0.2, z: 0 };
    const stepped = trackedMotion(-0.15);
    stepped.shoulderPosition = { x: -0.2, y: 0.2, z: 0 };
    const initialShoulderX = controller.update(standing, cal, DEFAULT_SETTINGS, 100).arm!.shoulder.x;
    let b = controller.update(stepped, cal, DEFAULT_SETTINGS, 116);
    for (let t = 132; t < 1000; t += 16) b = controller.update(stepped, cal, DEFAULT_SETTINGS, t);
    expect(b.arm!.shoulder.x).toBeLessThan(initialShoulderX - 0.1);
  });

  it('leans the shoulder toward a grip beyond arm reach instead of stretching', () => {
    const motion = trackedMotion(0.45);
    motion.shoulderPosition = { x: -0.3, y: 0.2, z: 0 };
    const pose = new PaddleController().update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    const distance = (a: typeof pose.position, b: typeof pose.position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    expect(pose.arm!.hand).toEqual(pose.position);
    expect(distance(pose.arm!.hand, pose.arm!.shoulder)).toBeLessThanOrEqual(ARM_RIG.upper + ARM_RIG.fore);
    expect(distance(pose.arm!.hand, pose.arm!.elbow)).toBeCloseTo(ARM_RIG.fore);
  });

  it('solves a two-bone chain whose bones keep their lengths', () => {
    const shoulder = { x: 0, y: 1.3, z: 1.9 };
    const hand = { x: 0.2, y: 1.0, z: 1.5 };
    const elbow = solveElbow(shoulder, hand, 0.32, 0.29, { x: 1, y: -1, z: 0 });
    expect(Math.hypot(elbow.x - shoulder.x, elbow.y - shoulder.y, elbow.z - shoulder.z)).toBeCloseTo(0.32);
    expect(Math.hypot(elbow.x - hand.x, elbow.y - hand.y, elbow.z - hand.z)).toBeCloseTo(0.29);
  });

  it('uses the tracked elbow side as the primary bend direction', () => {
    const poseWith = (elbowX: number) => {
      const motion = trackedMotion(0);
      motion.shoulderPosition = { x: -0.08, y: 0.2, z: 0 };
      motion.armOffsets = {
        elbow: { x: elbowX, y: 0, z: 0 },
        shoulder: { x: -0.2, y: 0.2, z: 0 },
      };
      return new PaddleController().update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    };
    const elbowRight = poseWith(0.12).arm!.elbow.x;
    const elbowLeft = poseWith(-0.28).arm!.elbow.x;
    expect(elbowRight).toBeGreaterThan(elbowLeft + 0.15);
  });

  it('glides to a new calibration instead of snapping', () => {
    const controller = new PaddleController();
    const before = defaultCalibration('camera');
    controller.update(trackedMotion(0), before, DEFAULT_SETTINGS, 100);
    controller.update(trackedMotion(0), before, DEFAULT_SETTINGS, 116);
    const start = controller.update(trackedMotion(0), before, DEFAULT_SETTINGS, 132).position.x;
    const after = { ...before, neutral: { x: -0.3, y: 0, z: 0 }, neutralSet: true };
    const target = new PaddleController().update(trackedMotion(0), after, DEFAULT_SETTINGS, 100).position.x;
    const firstFrame = controller.update(trackedMotion(0), after, DEFAULT_SETTINGS, 148).position.x;
    expect(Math.abs(firstFrame - start)).toBeLessThan(Math.abs(target - start) * 0.35);
    let x = firstFrame;
    for (let t = 164; t < 1200; t += 16) x = controller.update(trackedMotion(0), after, DEFAULT_SETTINGS, t).position.x;
    expect(x).toBeCloseTo(target, 3);
  });

  it('preserves a conservative amount of wrist depth by default', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.position.z = 0.15;
    const pose = controller.update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(pose.position.z).toBeLessThan(1.5);
    expect(pose.position.z).toBeGreaterThan(1.35);
  });

  it('uses relative landmark depth to foreshorten the rendered arm', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.armOffsets = {
      elbow: { x: -0.12, y: 0, z: -0.3 },
      shoulder: { x: -0.24, y: 0, z: -0.45 },
    };
    const pose = controller.update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(pose.arm!.elbow.z).toBeGreaterThan(pose.arm!.hand.z);
    expect(Math.abs(pose.arm!.elbow.x - pose.arm!.hand.x)).toBeLessThan(0.29);
  });

  it('does not zoom when the player appears smaller in frame', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.faceScale = 0.2;
    motion.torsoScale = 0.2;
    const pose = controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    expect(pose.playerRetreat).toBe(0);
    expect(pose.position.z).toBeCloseTo(PADDLE_AREA.center.z);
  });

  it('keeps the default stance when shoulder scale is near its baseline', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.faceScale = 0.29;
    motion.torsoScale = 0.29;
    const pose = controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    expect(pose.playerRetreat).toBe(0);
    expect(pose.position.z).toBeCloseTo(PADDLE_AREA.center.z);
  });

  it('does not zoom when the player appears larger in frame', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.faceScale = 0.36;
    motion.torsoScale = 0.36;
    const pose = controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    expect(pose.playerRetreat).toBe(0);
  });

  it('recognizes a compact backhand when the hand crosses inside the elbow', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.armOffsets = {
      elbow: { x: 0.12, y: -0.04, z: 0 },
      shoulder: { x: -0.08, y: 0.08, z: 0 },
    };
    const pose = controller.update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(pose.roll).toBeCloseTo(Math.PI / 2);
    expect(bladeCenter(pose).x).toBeLessThan(pose.position.x);
  });

  it('uses stable filtered joints visually while raw joints retain backhand intent', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.armOffsets = {
      elbow: { x: -0.12, y: -0.04, z: 0 },
      shoulder: { x: -0.28, y: 0.08, z: 0 },
    };
    motion.rawArmOffsets = {
      elbow: { x: 0.12, y: -0.04, z: 0 },
      shoulder: { x: -0.08, y: 0.08, z: 0 },
    };
    const pose = controller.update(motion, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    expect(bladeCenter(pose).x).toBeLessThan(pose.position.x);
  });

  it('turns into a compact backhand within two camera frames', () => {
    const controller = new PaddleController();
    controller.update(trackedMotion(0), defaultCalibration('camera'), DEFAULT_SETTINGS, 100);
    const backhand = trackedMotion(0);
    backhand.armOffsets = {
      elbow: { x: 0.12, y: -0.04, z: 0 },
      shoulder: { x: -0.08, y: 0.08, z: 0 },
    };
    backhand.rawArmOffsets = backhand.armOffsets;
    controller.update(backhand, defaultCalibration('camera'), DEFAULT_SETTINGS, 116);
    const pose = controller.update(backhand, defaultCalibration('camera'), DEFAULT_SETTINGS, 132);
    expect(bladeCenter(pose).x).toBeLessThan(pose.position.x);
  });

  it('keeps gameplay depth fixed after a backward body step', () => {
    const controller = new PaddleController();
    const cal = distanceCalibration();
    const ready = trackedMotion(0);
    ready.faceScale = 0.3;
    ready.torsoScale = 0.3;
    controller.update(ready, cal, DEFAULT_SETTINGS, 100);
    const back = trackedMotion(0);
    back.faceScale = 0.2;
    back.torsoScale = 0.2;
    const pose = controller.update(back, cal, DEFAULT_SETTINGS, 200);
    expect(pose.playerRetreat).toBe(0);
  });

  it('holds the camera when only a torso landmark glitches', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.faceScale = 0.3;
    motion.torsoScale = 0.2;
    const pose = controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    expect(pose.playerRetreat).toBe(0);
  });

  it('never lets an active arm swing update the camera', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.faceScale = 0.2;
    motion.torsoScale = 0.2;
    motion.armRelativeSpeed = 2;
    const pose = controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    expect(pose.playerRetreat).toBe(0);
  });

  it('ignores body scale even when the arm is moving slowly', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.faceScale = 0.2;
    motion.torsoScale = 0.2;
    motion.armRelativeSpeed = 0.1;
    const pose = controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    expect(pose.playerRetreat).toBe(0);
  });

  it('freezes camera distance throughout a simultaneous arm swing', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.armRelativeSpeed = 2;
    motion.timestamp = 100;
    motion.faceScale = 0.26;
    motion.torsoScale = 0.265;
    expect(controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100).playerRetreat).toBe(0);
    motion.timestamp = 160;
    motion.faceScale = 0.23;
    motion.torsoScale = 0.235;
    expect(controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 160).playerRetreat).toBe(0);
    motion.timestamp = 260;
    motion.faceScale = 0.2;
    motion.torsoScale = 0.205;
    expect(controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 260).playerRetreat).toBe(0);

    // Settling the arm still cannot re-enable the removed zoom feature.
    motion.armRelativeSpeed = 0;
    motion.timestamp = 420;
    expect(controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 420).playerRetreat).toBe(0);
  });

  it('does not let noisy palm landmarks steer a stationary wrist', () => {
    const controller = new PaddleController();
    const ready = trackedMotion(0);
    ready.handOffset = { x: 0.05, y: 0, z: 0 };
    controller.update(ready, defaultCalibration('camera'), DEFAULT_SETTINGS, 100);

    const stroke = trackedMotion(0);
    stroke.handOffset = { x: -0.05, y: 0, z: 0 };
    stroke.armRelativeSpeed = 2;
    stroke.acceptedThisFrame = true;
    const pose = controller.update(stroke, defaultCalibration('camera'), DEFAULT_SETTINGS, 133);
    expect(pose.position.x).toBeCloseTo(PADDLE_AREA.center.x);
  });

  it('rejects a brief agreeing scale jump during a stationary swing', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.armRelativeSpeed = 2;
    motion.timestamp = 100;
    motion.faceScale = 0.23;
    motion.torsoScale = 0.235;
    controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    motion.timestamp = 220;
    expect(controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 220).playerRetreat).toBe(0);
  });

  it('does not unlock camera distance while an extended arm is held still', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0.25);
    motion.faceScale = 0.23;
    motion.torsoScale = 0.235;
    motion.armRelativeSpeed = 0;
    motion.timestamp = 100;
    controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    motion.timestamp = 500;
    expect(controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 500).playerRetreat).toBe(0);
  });

  it('treats a slow raised arm as active camera protection', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.position.y = 0.15;
    motion.faceScale = 0.23;
    motion.torsoScale = 0.235;
    motion.armRelativeSpeed = 0.2;
    motion.timestamp = 100;
    controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    motion.timestamp = 240;
    expect(controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 240).playerRetreat).toBe(0);
  });

  it('rejects inconsistent body landmarks during a stationary swing', () => {
    const controller = new PaddleController();
    const motion = trackedMotion(0);
    motion.faceScale = 0.23;
    motion.torsoScale = 0.295;
    motion.armRelativeSpeed = 2;
    motion.timestamp = 100;
    controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 100);
    motion.timestamp = 220;
    expect(controller.update(motion, distanceCalibration(), DEFAULT_SETTINGS, 220).playerRetreat).toBe(0);
  });
});
