/** A landmark in normalized image coordinates: x right, y down, both 0..1. */
export interface Landmark {
  x: number;
  y: number;
  /** MediaPipe's relative depth (smaller = closer to camera), roughly in x units. Noisy. */
  z: number;
  visibility: number;
}

/** Raw output of a tracker for one video frame. Coordinates are NOT mirrored. */
export interface PoseFrame {
  /** performance.now() just before inference. */
  timestamp: number;
  /** Camera capture time (performance.now() timebase) when the browser reports it. */
  captureTime?: number;
  imageWidth: number;
  imageHeight: number;
  /** 33 BlazePose landmarks, or null when no person was found. */
  landmarks: Landmark[] | null;
  inferenceMs: number;
}

/**
 * The tracked arm, in display coordinates (mirrored if the preview is mirrored).
 * This is the boundary between the tracking layer and everything downstream:
 * any tracker that can fill this in can replace MediaPipe Pose.
 */
export interface ArmObservation {
  timestamp: number;
  /** imageWidth / imageHeight, needed to measure distances in square units. */
  aspect: number;
  wrist: Landmark | null;
  elbow: Landmark | null;
  shoulder: Landmark | null;
  otherShoulder: Landmark | null;
  /** Same-side and opposite hips, used only to estimate whole-body camera distance. */
  hip: Landmark | null;
  otherHip: Landmark | null;
  /** Face anchors provide an arm-independent scale check for camera distance. */
  leftEye: Landmark | null;
  rightEye: Landmark | null;
  index: Landmark | null;
  pinky: Landmark | null;
}

export interface PoseTracker {
  readonly description: string;
  detect(video: HTMLVideoElement, timestampMs: number): PoseFrame;
  close(): void;
}
