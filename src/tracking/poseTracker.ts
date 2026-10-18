import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Delegate, ModelVariant } from '../config';
import type { PoseFrame, PoseTracker } from './types';

// Local copies are produced by scripts/setup-assets.mjs; the remote URLs are a fallback.
const BASE = import.meta.env.BASE_URL;
const LOCAL_WASM = `${BASE}mediapipe/wasm`;
const REMOTE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm';
const localModel = (m: ModelVariant) => `${BASE}models/pose_landmarker_${m}.task`;
const remoteModel = (m: ModelVariant) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`;

class MediaPipePoseTracker implements PoseTracker {
  private lastTimestamp = -1;

  constructor(private landmarker: PoseLandmarker, readonly description: string) {}

  detect(video: HTMLVideoElement, timestampMs: number): PoseFrame {
    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const ts = Math.max(timestampMs, this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(video, ts);
    const inferenceMs = performance.now() - t0;
    const pose = result.landmarks[0];
    return {
      timestamp: timestampMs,
      imageWidth: video.videoWidth,
      imageHeight: video.videoHeight,
      landmarks: pose ? pose.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 1 })) : null,
      inferenceMs,
    };
  }

  close(): void {
    this.landmarker.close();
  }
}

export interface TrackerLoadResult {
  tracker: PoseTracker;
  warnings: string[];
}

/**
 * Loads MediaPipe Pose Landmarker. Tries local assets + the preferred delegate first,
 * then falls back to CPU and to remote assets, collecting a warning for each fallback.
 */
export async function createPoseTracker(model: ModelVariant, delegate: Delegate): Promise<TrackerLoadResult> {
  const delegates: Delegate[] = delegate === 'GPU' ? ['GPU', 'CPU'] : ['CPU'];
  const sources = [
    { name: 'local', wasm: LOCAL_WASM, model: localModel(model) },
    { name: 'remote', wasm: REMOTE_WASM, model: remoteModel(model) },
  ];
  const warnings: string[] = [];
  let lastError: unknown;

  for (const source of sources) {
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(source.wasm);
    } catch (err) {
      lastError = err;
      warnings.push(`Could not load ${source.name} WASM runtime.`);
      continue;
    }
    for (const d of delegates) {
      try {
        const landmarker = await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: source.model, delegate: d },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        });
        return { tracker: new MediaPipePoseTracker(landmarker, `Pose ${model} · ${d} · ${source.name} assets`), warnings };
      } catch (err) {
        lastError = err;
        warnings.push(`Pose ${model} failed with ${d} delegate from ${source.name} assets.`);
      }
    }
  }
  throw new Error(
    `Could not load the pose tracking model. ${lastError instanceof Error ? lastError.message : ''} ` +
      'If you are offline, run `npm run setup:assets` while online first.',
  );
}
