import { ASSUMED_SHOULDER_WIDTH_M, type Settings } from '../config';
import {
  computeNeutral,
  computeRange,
  defaultCalibration,
  type Calibration,
} from '../control/calibration';
import { PaddleController, type PaddlePose } from '../control/paddleController';
import { MotionEstimator, type MotionState, type TrackingStats } from '../motion/motionEstimator';
import { SwingDetector, type SwingEvent } from '../motion/swingDetector';
import type { Vec3 } from '../motion/vector';
import { BallSimulation, type BallState } from '../physics/ballPhysics';
import { RallyController, type RallySnapshot } from '../game/rallyController';
import { clearOverlay, drawOverlay } from '../render/overlay';
import { PaddleScene } from '../render/paddleScene';
import { ImpactAudio } from '../audio/impactAudio';
import { extractArm } from '../tracking/arm';
import { CameraError, startCamera, type CameraHandle } from '../tracking/camera';
import { createPoseTracker } from '../tracking/poseTracker';
import type { PoseFrame, PoseTracker } from '../tracking/types';
import { CounterRate, RollingWindow } from './metrics';

export type EnginePhase = 'idle' | 'starting' | 'running' | 'error';

export interface EngineError {
  kind: string;
  message: string;
}

export type CalibrationStep = 'neutral-countdown' | 'neutral-capture' | 'range-countdown' | 'range-capture';

const STEP_DURATION: Record<CalibrationStep, number> = {
  'neutral-countdown': 3000,
  'neutral-capture': 1500,
  'range-countdown': 2000,
  'range-capture': 6000,
};

interface CalibrationRun {
  step: CalibrationStep;
  stepStart: number;
  /** Continue with range capture after neutral? */
  full: boolean;
  samples: Vec3[];
  faceScales: number[];
  torsoScales: number[];
  framesSeen: number;
}

export interface EngineSnapshot {
  phase: EnginePhase;
  error: EngineError | null;
  loadingMessage: string;
  trackerDescription: string;
  trackerLoading: boolean;
  warnings: string[];
  camera: { label: string; width: number; height: number; frameRate?: number; deviceId?: string } | null;
  metrics: {
    cameraFps: number;
    processedFps: number;
    renderFps: number;
    inferenceMeanMs: number;
    inferenceP95Ms: number;
    captureToResultMs: number | null;
    droppedFrames: number;
    trackedPercent: number;
    peakSpeed1s: number;
  };
  motion: MotionState;
  /** Speed converted to m/s using an assumed shoulder width (very approximate). */
  approxSpeedMs: number | null;
  paddle: PaddlePose;
  stats: TrackingStats;
  calibration: Calibration;
  calibrationRun: { step: CalibrationStep; remainingMs: number } | null;
  calibrationMessage: string;
  swing: {
    active: boolean;
    total: number;
    nearMisses: number;
    flashUntil: number;
    events: SwingEvent[];
  };
  ball: BallState;
  rally: RallySnapshot;
}

export interface EngineElements {
  video: HTMLVideoElement;
  overlay: HTMLCanvasElement;
  sceneContainer: HTMLElement;
}

/**
 * Owns the realtime pipeline:
 *   webcam → pose tracker → motion estimator → paddle controller → renderer
 * Everything here runs outside React. The UI polls getSnapshot() a few times
 * per second for display only.
 */
export class Engine {
  private camera: CameraHandle | null = null;
  private tracker: PoseTracker | null = null;
  private trackerLoading = false;
  private trackerDescription = '';
  private warnings: string[] = [];
  private estimator = new MotionEstimator();
  private swingDetector = new SwingDetector();
  private swingEvents: SwingEvent[] = [];
  private swingTotal = 0;
  private nearMissTotal = 0;
  private swingFlashUntil = 0;
  private paddle = new PaddleController();
  private ball = new BallSimulation();
  private rally = new RallyController();
  private audio = new ImpactAudio();
  private paddlePose: PaddlePose;
  private scene: PaddleScene | null = null;
  private overlayCtx: CanvasRenderingContext2D | null;
  private phase: EnginePhase = 'idle';
  private error: EngineError | null = null;
  private loadingMessage = '';
  private running = false;
  private rafId = 0;
  private vfcId = 0;
  private readonly hasVfc: boolean;
  private lastVideoTime = -1;
  private lastPresentedFrames = -1;
  private droppedFrames = 0;
  private calRun: CalibrationRun | null = null;
  private calMessage = '';
  private autoNeutralStarted = false;
  private disposed = false;

  private cameraFrames = new CounterRate(1000);
  private fallbackFrameCount = 0;
  private processedFrames = new RollingWindow(1000);
  private renderFrames = new RollingWindow(1000);
  private inference = new RollingWindow(2000);
  private captureLatency = new RollingWindow(2000);
  private trackedFrames = new RollingWindow(3000);
  private speeds = new RollingWindow(1000);

  constructor(
    private els: EngineElements,
    private settings: Settings,
    private calibration: Calibration,
    private onCalibrationChange: (c: Calibration) => void,
  ) {
    this.overlayCtx = els.overlay.getContext('2d');
    this.hasVfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    this.paddlePose = this.paddle.update(this.estimator.state, calibration, settings, performance.now());
  }

  // ---------- lifecycle ----------

  /** Build the court without touching camera permissions or loading ML assets. */
  initializeScene(): void {
    if (this.scene || this.disposed) return;
    try {
      this.scene = new PaddleScene(this.els.sceneContainer, this.settings.environment);
      this.scene.render(this.paddlePose, this.ball.state, this.rally.state, this.ball.opponentPaddle);
    } catch (err) {
      this.fail('webgl', err);
    }
  }

  async start(deviceId?: string): Promise<void> {
    this.audio.unlock();
    this.stopLoops();
    this.camera?.stop();
    this.camera = null;
    this.error = null;
    this.phase = 'starting';
    this.loadingMessage = 'Requesting camera access…';

    this.initializeScene();
    if (!this.scene) return;

    // Load the model while the permission prompt is up.
    const trackerPromise = this.tracker ? Promise.resolve() : this.loadTracker();
    try {
      this.camera = await startCamera(this.els.video, deviceId);
    } catch (err) {
      return this.fail(err instanceof CameraError ? err.kind : 'camera', err);
    }
    if (this.disposed) return this.camera.stop();
    this.camera.track.addEventListener('ended', () => {
      if (this.disposed) return;
      this.stopLoops();
      this.phase = 'error';
      this.error = { kind: 'camera-ended', message: 'The camera stopped (unplugged, or taken over by another app). Click Retry to restart it.' };
    });

    this.loadingMessage = 'Loading pose tracking model…';
    await trackerPromise;
    if (!this.tracker) {
      // loadTracker already reported the error; don't leave the camera on.
      this.camera?.stop();
      this.camera = null;
      return;
    }

    this.estimator.reset();
    this.swingDetector.reset();
    this.autoNeutralStarted = this.calibration.neutralSet;
    this.loadingMessage = '';
    this.phase = 'running';
    this.running = true;
    this.lastPresentedFrames = -1;
    this.droppedFrames = 0;
    this.cameraFrames.clear();
    if (this.hasVfc) this.vfcId = this.els.video.requestVideoFrameCallback(this.onVideoFrame);
    this.rafId = requestAnimationFrame(this.renderLoop);
  }

  private async loadTracker(): Promise<void> {
    this.trackerLoading = true;
    try {
      const { tracker, warnings } = await createPoseTracker(this.settings.model, this.settings.delegate);
      if (this.disposed) return tracker.close();
      this.tracker?.close();
      this.tracker = tracker;
      this.trackerDescription = tracker.description;
      this.warnings = warnings;
    } catch (err) {
      this.fail('model', err);
    } finally {
      this.trackerLoading = false;
    }
  }

  /** Swap model/delegate without restarting the camera. */
  async reloadTracker(): Promise<void> {
    const old = this.tracker;
    this.tracker = null; // pauses processing; rendering continues
    old?.close();
    await this.loadTracker();
    this.estimator.reset();
  }

  private fail(kind: string, err: unknown) {
    this.stopLoops();
    this.camera?.stop();
    this.camera = null;
    this.phase = 'error';
    this.error = { kind, message: err instanceof Error ? err.message : String(err) };
    this.loadingMessage = '';
  }

  private stopLoops() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.hasVfc && this.vfcId) this.els.video.cancelVideoFrameCallback(this.vfcId);
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoops();
    this.camera?.stop();
    this.tracker?.close();
    this.tracker = null;
    this.scene?.dispose();
    this.scene = null;
    this.audio.dispose();
  }

  // ---------- settings / calibration ----------

  updateSettings(next: Settings): void {
    const prev = this.settings;
    this.settings = next;
    if (prev.frame !== next.frame) {
      // Calibration is measured in frame-specific coordinates; it no longer applies.
      this.setCalibration(defaultCalibration(next.frame));
      this.calMessage = 'Reference frame changed — calibration reset. Please recalibrate.';
      this.estimator.reset();
    }
    if (prev.hand !== next.hand || prev.mirror !== next.mirror) this.estimator.reset();
    if (prev.hand !== next.hand || prev.mirror !== next.mirror) this.swingDetector.reset();
    if (!next.showOverlay && this.overlayCtx) clearOverlay(this.overlayCtx);
    if (prev.environment !== next.environment && this.scene) {
      this.scene.setEnvironment(next.environment);
      // Redraw now: the render loop only runs once the camera is on.
      if (this.phase !== 'running') this.scene.render(this.paddlePose, this.ball.state, this.rally.state, this.ball.opponentPaddle);
    }
    if ((prev.model !== next.model || prev.delegate !== next.delegate) && this.phase === 'running') {
      void this.reloadTracker();
    }
  }

  private setCalibration(c: Calibration) {
    this.calibration = c;
    this.onCalibrationChange(c);
  }

  startCalibration(full: boolean): void {
    if (this.phase !== 'running') return;
    this.calRun = { step: 'neutral-countdown', stepStart: performance.now(), full, samples: [], faceScales: [], torsoScales: [], framesSeen: 0 };
    this.calMessage = '';
  }

  startRangeCalibration(): void {
    if (this.phase !== 'running') return;
    this.calRun = { step: 'range-countdown', stepStart: performance.now(), full: false, samples: [], faceScales: [], torsoScales: [], framesSeen: 0 };
    this.calMessage = '';
  }

  cancelCalibration(): void {
    this.calRun = null;
    this.calMessage = 'Calibration cancelled.';
  }

  resetCalibration(): void {
    this.calRun = null;
    this.setCalibration(defaultCalibration(this.settings.frame));
    this.calMessage = 'Calibration reset to defaults.';
  }

  launchBall(): void {
    this.audio.unlock();
    this.configureBall();
    // Contact drill: one readable ball, no CPU/rally/scoring automation.
    this.rally.reset(this.ball);
    this.ball.launch(Math.min(2.8, this.settings.feedSpeed));
  }

  startRally(): void {
    this.audio.unlock();
    this.configureBall();
    this.rally.start(this.ball);
  }

  resetBall(): void {
    this.rally.reset(this.ball);
  }

  private advanceCalibration(motion: MotionState, now: number) {
    const run = this.calRun;
    if (!run) return;
    const elapsed = now - run.stepStart;
    const capturing = run.step === 'neutral-capture' || run.step === 'range-capture';
    if (capturing) {
      run.framesSeen++;
      if (motion.acceptedThisFrame) {
        run.samples.push({ ...motion.rawPosition });
        if (motion.faceScale > 0) run.faceScales.push(motion.faceScale);
        if (motion.torsoScale > 0) run.torsoScales.push(motion.torsoScale);
      }
    }
    if (elapsed < STEP_DURATION[run.step]) return;

    const coverage = run.framesSeen ? run.samples.length / run.framesSeen : 0;
    const next = (step: CalibrationStep) => {
      run.step = step;
      run.stepStart = now;
      run.samples = [];
      run.faceScales = [];
      run.torsoScales = [];
      run.framesSeen = 0;
    };

    switch (run.step) {
      case 'neutral-countdown':
        return next('neutral-capture');
      case 'range-countdown':
        return next('range-capture');
      case 'neutral-capture': {
        if (run.samples.length < 8 || coverage < 0.6) {
          this.calRun = null;
          this.calMessage = `Neutral failed: your wrist was only tracked in ${Math.round(coverage * 100)}% of frames. Make sure your arm is in view and well lit, then retry.`;
          return;
        }
        const { neutral, spread } = computeNeutral(run.samples);
        const median = (values: number[], fallback: number) => {
          const sorted = [...values].sort((a, b) => a - b);
          return sorted.length ? sorted[Math.floor(sorted.length / 2)] : fallback;
        };
        const neutralFaceScale = median(run.faceScales, this.calibration.neutralFaceScale);
        const neutralTorsoScale = median(run.torsoScales, this.calibration.neutralTorsoScale);
        this.setCalibration({ ...this.calibration, neutral, neutralFaceScale, neutralTorsoScale, neutralSet: true });
        this.calMessage = `Neutral set (movement during capture: ${(spread * 100).toFixed(1)}% of frame height${spread > 0.03 ? ' — try holding stiller' : ''}).`;
        if (run.full) {
          next('range-countdown');
          run.full = true;
          return;
        }
        this.calRun = null;
        return;
      }
      case 'range-capture': {
        if (run.samples.length < 20 || coverage < 0.5) {
          this.calRun = null;
          this.calMessage = `Range failed: wrist tracked in only ${Math.round(coverage * 100)}% of frames. Move a little slower, keep your arm in view, and retry.`;
          return;
        }
        const { range, warnings } = computeRange(run.samples, this.calibration.neutral, this.calibration.range);
        this.setCalibration({ ...this.calibration, range, rangeSet: true });
        // In a full run, keep the neutral feedback (e.g. "hold stiller") visible too.
        this.calMessage = [run.full ? this.calMessage : '', 'Range set.', ...warnings].filter(Boolean).join(' ');
        this.calRun = null;
        return;
      }
    }
  }

  // ---------- realtime loops ----------

  private onVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
    if (!this.running) return;
    const newFrames = this.lastPresentedFrames >= 0 ? Math.max(1, meta.presentedFrames - this.lastPresentedFrames) : 1;
    // Frames the camera delivered that we never saw because the previous inference was still running.
    this.droppedFrames += newFrames - 1;
    this.lastPresentedFrames = meta.presentedFrames;
    this.cameraFrames.push(performance.now(), meta.presentedFrames);
    this.processFrame(meta.captureTime);
    this.vfcId = this.els.video.requestVideoFrameCallback(this.onVideoFrame);
  };

  private renderLoop = () => {
    if (!this.running) return;
    const video = this.els.video;
    if (!this.hasVfc && video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      this.cameraFrames.push(performance.now(), ++this.fallbackFrameCount);
      this.processFrame();
    }
    const now = performance.now();
    this.renderFrames.push(now);
    this.paddlePose = this.paddle.update(this.estimator.state, this.calibration, this.settings, now);
    this.configureBall();
    this.ball.update(now, this.paddlePose, { collision: this.settings.collisionAssist, netClearance: this.settings.netClearanceAssist });
    const ballEvents = this.ball.consumeEvents();
    this.audio.play(ballEvents);
    if (this.rally.state.phase !== 'idle') {
      const previousPoint = this.rally.state.lastPoint?.id;
      this.rally.update(now, this.ball, ballEvents);
      const point = this.rally.state.lastPoint;
      // Only the match result has a sound; individual points stay silent.
      if (point && point.id !== previousPoint && point.gameOver) this.audio.playGameOver(point.winner === 'player');
    }
    this.scene?.render(this.paddlePose, this.ball.state, this.rally.state, this.ball.opponentPaddle);
    this.rafId = requestAnimationFrame(this.renderLoop);
  };

  private configureBall(): void {
    this.ball.configure({
      feedSpeed: this.settings.feedSpeed,
      drag: this.settings.ballDrag,
      tableRestitution: this.settings.tableRestitution,
      paddleRestitution: this.settings.paddleRestitution,
      swingTransfer: this.settings.swingTransfer,
      cpuErrorRate: this.settings.cpuErrorRate,
    });
  }

  private processFrame(captureTime?: number) {
    const video = this.els.video;
    const now = performance.now();
    if (!this.tracker || video.readyState < 2 || !video.videoWidth) return;

    let frame: PoseFrame;
    try {
      frame = this.tracker.detect(video, now);
    } catch (err) {
      // A single failed inference shouldn't kill the session; surface it and carry on.
      this.warnings = [`Tracker error: ${err instanceof Error ? err.message : String(err)}`];
      return;
    }
    const done = performance.now();
    this.processedFrames.push(done);
    this.inference.push(done, frame.inferenceMs);
    if (captureTime && captureTime > 0 && done - captureTime < 1000 && done > captureTime) {
      this.captureLatency.push(done, done - captureTime);
    }

    const s = this.settings;
    const arm = extractArm(frame, s.hand, s.mirror);
    const motion = this.estimator.update(arm, s);
    if (motion.acceptedThisFrame && !this.calibration.neutralSet && !this.calRun && !this.autoNeutralStarted) {
      this.autoNeutralStarted = true;
      this.calRun = { step: 'neutral-countdown', stepStart: done, full: false, samples: [], faceScales: [], torsoScales: [], framesSeen: 0 };
      this.calMessage = 'Hold your normal bent-arm ready position while the game sets the paddle centre.';
    }
    const swing = this.swingDetector.update(motion, {
      startSpeed: s.swingStartSpeed,
      endSpeed: Math.min(s.swingEndSpeed, s.swingStartSpeed),
      minDurationMs: s.swingMinDurationMs,
    });
    if (swing) {
      this.swingEvents = [swing, ...this.swingEvents].slice(0, 12);
      if (swing.nearMiss) this.nearMissTotal++;
      else {
        this.swingTotal++;
        this.swingFlashUntil = done + 350;
      }
    }
    this.trackedFrames.push(done, motion.acceptedThisFrame ? 1 : 0);
    if (motion.acceptedThisFrame) this.speeds.push(done, motion.speed);
    this.advanceCalibration(motion, done);

    if (this.overlayCtx && s.showOverlay) {
      drawOverlay(this.overlayCtx, {
        frame,
        hand: s.hand,
        mirror: s.mirror,
        minVisibility: s.minVisibility,
        estimator: this.estimator,
        calibration: this.calibration,
      });
    }
  }

  // ---------- UI ----------

  getSnapshot(): EngineSnapshot {
    const now = performance.now();
    const motion = this.estimator.state;
    const cam = this.camera;
    return {
      phase: this.phase,
      error: this.error,
      loadingMessage: this.loadingMessage,
      trackerDescription: this.trackerDescription,
      trackerLoading: this.trackerLoading,
      warnings: this.warnings,
      camera: cam ? { label: cam.label, width: cam.width, height: cam.height, frameRate: cam.frameRate, deviceId: cam.deviceId } : null,
      metrics: {
        cameraFps: this.cameraFrames.rate(),
        processedFps: this.processedFrames.rate(now),
        renderFps: this.renderFrames.rate(now),
        inferenceMeanMs: this.inference.mean(now),
        inferenceP95Ms: this.inference.percentile(now, 0.95),
        captureToResultMs: this.captureLatency.mean(now) || null,
        droppedFrames: this.droppedFrames,
        trackedPercent: this.trackedFrames.mean(now) * 100,
        peakSpeed1s: this.speeds.max(now),
      },
      motion: { ...motion, position: { ...motion.position }, velocity: { ...motion.velocity } },
      approxSpeedMs: motion.shoulderWidth > 0.02 ? (motion.speed / motion.shoulderWidth) * ASSUMED_SHOULDER_WIDTH_M : null,
      paddle: { ...this.paddlePose, normalized: { ...this.paddlePose.normalized } },
      stats: { ...this.estimator.stats },
      calibration: this.calibration,
      calibrationRun: this.calRun
        ? { step: this.calRun.step, remainingMs: Math.max(0, STEP_DURATION[this.calRun.step] - (now - this.calRun.stepStart)) }
        : null,
      calibrationMessage: this.calMessage,
      swing: {
        active: this.swingDetector.isSwinging,
        total: this.swingTotal,
        nearMisses: this.nearMissTotal,
        flashUntil: this.swingFlashUntil,
        events: this.swingEvents.map((event) => ({
          ...event,
          directionVector: { ...event.directionVector },
          startPosition: { ...event.startPosition },
          endPosition: { ...event.endPosition },
        })),
      },
      ball: {
        ...this.ball.state,
        position: { ...this.ball.state.position },
        velocity: { ...this.ball.state.velocity },
      },
      rally: this.rally.state,
    };
  }
}
