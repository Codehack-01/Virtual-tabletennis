import type { Hand } from '../config';
import type { ArmObservation, Landmark, PoseFrame } from './types';

// BlazePose indices. "left"/"right" are the person's own sides.
export const POSE = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftEye: 2,
  rightEye: 5,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftHip: 23,
  rightHip: 24,
} as const;

const ARM_INDICES = {
  left: { shoulder: POSE.leftShoulder, other: POSE.rightShoulder, hip: POSE.leftHip, otherHip: POSE.rightHip, elbow: POSE.leftElbow, wrist: POSE.leftWrist, index: POSE.leftIndex, pinky: POSE.leftPinky },
  right: { shoulder: POSE.rightShoulder, other: POSE.leftShoulder, hip: POSE.rightHip, otherHip: POSE.leftHip, elbow: POSE.rightElbow, wrist: POSE.rightWrist, index: POSE.rightIndex, pinky: POSE.rightPinky },
};

export function mirrorLandmark(l: Landmark, mirror: boolean): Landmark {
  return mirror ? { ...l, x: 1 - l.x } : l;
}

export function extractArm(frame: PoseFrame, hand: Hand, mirror: boolean): ArmObservation {
  const lm = frame.landmarks;
  const idx = ARM_INDICES[hand];
  const get = (i: number) => (lm && lm[i] ? mirrorLandmark(lm[i], mirror) : null);
  const index = get(idx.index);
  const pinky = get(idx.pinky);
  return {
    timestamp: frame.timestamp,
    aspect: frame.imageWidth / Math.max(1, frame.imageHeight),
    wrist: get(idx.wrist),
    elbow: get(idx.elbow),
    shoulder: get(idx.shoulder),
    otherShoulder: get(idx.other),
    hip: get(idx.hip),
    otherHip: get(idx.otherHip),
    leftEye: get(POSE.leftEye),
    rightEye: get(POSE.rightEye),
    index,
    pinky,
  };
}
