export type CameraErrorKind =
  | 'unsupported'
  | 'insecure-context'
  | 'permission-denied'
  | 'not-found'
  | 'in-use'
  | 'unknown';

export class CameraError extends Error {
  constructor(public kind: CameraErrorKind, message: string) {
    super(message);
  }
}

export interface CameraHandle {
  stream: MediaStream;
  track: MediaStreamTrack;
  label: string;
  deviceId?: string;
  width: number;
  height: number;
  frameRate?: number;
  stop(): void;
}

function toCameraError(err: unknown): CameraError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError(
        'permission-denied',
        'Camera permission was denied. Allow camera access for this site (click the camera icon in the address bar, or check System Settings → Privacy & Security → Camera on macOS), then retry.',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('not-found', 'No camera was found. Connect a webcam and retry.');
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError(
        'in-use',
        'The camera could not be started. It may be in use by another application (Zoom, FaceTime, another tab). Close it and retry.',
      );
    default:
      return new CameraError('unknown', `Could not start the camera: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Throws a CameraError if this browser/context can't use a webcam at all. */
export function checkCameraSupport(): void {
  if (!window.isSecureContext) {
    throw new CameraError(
      'insecure-context',
      'Camera access requires a secure context. Open the app via http://localhost (not an IP address) or HTTPS.',
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('unsupported', 'This browser does not support webcam access (getUserMedia). Use a recent Chrome, Edge, Safari or Firefox.');
  }
}

export async function startCamera(video: HTMLVideoElement, deviceId?: string): Promise<CameraHandle> {
  checkCameraSupport();

  // 640x480 keeps inference cheap; a higher frame rate matters more than resolution here.
  const preferred: MediaStreamConstraints = {
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 60, min: 15 },
    },
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(preferred);
  } catch (err) {
    if (err instanceof Error && err.name === 'OverconstrainedError') {
      // Some cameras reject the frame-rate range; fall back to anything that works.
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { deviceId } : true });
      } catch (err2) {
        throw toCameraError(err2);
      }
    } else {
      throw toCameraError(err);
    }
  }

  const track = stream.getVideoTracks()[0];
  const stop = () => stream.getTracks().forEach((t) => t.stop());
  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    if (!video.videoWidth) {
      await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
    }
  } catch (err) {
    stop();
    throw toCameraError(err);
  }

  const s = track.getSettings();
  return {
    stream,
    track,
    label: track.label || 'Camera',
    deviceId: s.deviceId,
    width: video.videoWidth,
    height: video.videoHeight,
    frameRate: s.frameRate,
    stop,
  };
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}
