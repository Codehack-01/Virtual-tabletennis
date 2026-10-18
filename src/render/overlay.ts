import type { Hand } from '../config';
import type { Calibration } from '../control/calibration';
import type { MotionEstimator } from '../motion/motionEstimator';
import { mirrorLandmark, POSE } from '../tracking/arm';
import type { PoseFrame } from '../tracking/types';

const CONNECTIONS: [number, number][] = [
  [POSE.leftShoulder, POSE.rightShoulder],
  [POSE.leftShoulder, POSE.leftElbow],
  [POSE.leftElbow, POSE.leftWrist],
  [POSE.rightShoulder, POSE.rightElbow],
  [POSE.rightElbow, POSE.rightWrist],
  [POSE.leftWrist, POSE.leftIndex],
  [POSE.leftWrist, POSE.leftPinky],
  [POSE.rightWrist, POSE.rightIndex],
  [POSE.rightWrist, POSE.rightPinky],
  [POSE.leftShoulder, POSE.leftHip],
  [POSE.rightShoulder, POSE.rightHip],
  [POSE.leftHip, POSE.rightHip],
];

export interface OverlayInput {
  frame: PoseFrame;
  hand: Hand;
  mirror: boolean;
  minVisibility: number;
  estimator: MotionEstimator;
  calibration: Calibration;
}

/** Debug overlay on the webcam preview. Draws in display (mirrored) coordinates. */
export function drawOverlay(ctx: CanvasRenderingContext2D, input: OverlayInput): void {
  const { canvas } = ctx;
  const { frame, hand, mirror, minVisibility, estimator, calibration } = input;
  if (canvas.width !== frame.imageWidth || canvas.height !== frame.imageHeight) {
    canvas.width = frame.imageWidth;
    canvas.height = frame.imageHeight;
  }
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const px = (p: { x: number; y: number }) => [p.x * W, p.y * H] as const;

  // Calibrated neutral point and range box
  const { neutral, range } = calibration;
  const tl = px(estimator.controlToImage({ x: neutral.x - range.left, y: neutral.y + range.up }));
  const br = px(estimator.controlToImage({ x: neutral.x + range.right, y: neutral.y - range.down }));
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = calibration.rangeSet ? 'rgba(255, 209, 102, 0.8)' : 'rgba(255, 209, 102, 0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(tl[0], tl[1], br[0] - tl[0], br[1] - tl[1]);
  ctx.setLineDash([]);
  const [nx, ny] = px(estimator.controlToImage(neutral));
  ctx.beginPath();
  ctx.moveTo(nx - 10, ny);
  ctx.lineTo(nx + 10, ny);
  ctx.moveTo(nx, ny - 10);
  ctx.lineTo(nx, ny + 10);
  ctx.stroke();

  const lm = frame.landmarks?.map((l) => mirrorLandmark(l, mirror));
  if (lm) {
    const active = hand === 'right'
      ? new Set<number>([POSE.rightShoulder, POSE.rightElbow, POSE.rightWrist])
      : new Set<number>([POSE.leftShoulder, POSE.leftElbow, POSE.leftWrist]);
    ctx.lineCap = 'round';
    for (const [a, b] of CONNECTIONS) {
      const la = lm[a];
      const lb = lm[b];
      if (!la || !lb || la.visibility < minVisibility * 0.6 || lb.visibility < minVisibility * 0.6) continue;
      const isActive = active.has(a) && active.has(b);
      ctx.strokeStyle = isActive ? 'rgba(79, 209, 197, 0.95)' : 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = isActive ? 5 : 2;
      ctx.beginPath();
      ctx.moveTo(...px(la));
      ctx.lineTo(...px(lb));
      ctx.stroke();
    }
    for (let i = 11; i <= 24; i++) {
      const l = lm[i];
      if (!l || l.visibility < minVisibility * 0.6) continue;
      ctx.fillStyle = l.visibility >= minVisibility ? 'rgba(255,255,255,0.85)' : 'rgba(255,120,120,0.7)';
      ctx.beginPath();
      ctx.arc(...px(l), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const wrist = lm[hand === 'right' ? POSE.rightWrist : POSE.leftWrist];
    if (wrist) {
      ctx.strokeStyle = wrist.visibility >= minVisibility ? '#ff5d5d' : 'rgba(255,93,93,0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(...px(wrist), 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Filtered wrist + velocity vector (what the paddle controller actually uses)
  const s = estimator.state;
  if (s.status === 'tracking' || s.status === 'holding') {
    const [fx, fy] = px(estimator.controlToImage(s.position));
    ctx.fillStyle = s.status === 'tracking' ? '#7CFC8A' : '#f4a261';
    ctx.beginPath();
    ctx.arc(fx, fy, 6, 0, Math.PI * 2);
    ctx.fill();
    if (s.speed > 0.15) {
      const lead = 0.15; // draw where the wrist would be in 150 ms
      const [vx, vy] = px(estimator.controlToImage({ x: s.position.x + s.velocity.x * lead, y: s.position.y + s.velocity.y * lead }));
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(vx, vy);
      ctx.stroke();
    }
  }
}

export function clearOverlay(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}
