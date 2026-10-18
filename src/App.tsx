import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, loadJSON, saveJSON, type ReferenceFrame, type Settings } from './config';
import { defaultCalibration, type Calibration } from './control/calibration';
import { Engine, type EngineSnapshot } from './engine/engine';
import { checkCameraSupport, listCameras } from './tracking/camera';
import { CalibrationPanel, CalibrationPrompt } from './ui/CalibrationPanel';
import { DebugPanel } from './ui/DebugPanel';
import { SettingsPanel } from './ui/SettingsPanel';
import './App.css';

// v5 restores the low-latency gameplay profile and discards the conservative
// control values that made the paddle trail the player's wrist.
const SETTINGS_KEY = 'ttpoc.settings.v5';
// v5 stores stable raw face/torso medians instead of a first-frame ratio.
const CALIBRATION_KEY = 'ttpoc.calibration.v5';
const UI_POLL_MS = 200;

function loadCalibration(frame: ReferenceFrame): Calibration {
  const saved = loadJSON<Calibration | null>(CALIBRATION_KEY, null);
  return saved && saved.frame === frame ? saved : defaultCalibration(frame);
}

function preflightProblems(): string[] {
  const problems: string[] = [];
  try {
    checkCameraSupport();
  } catch (err) {
    problems.push((err as Error).message);
  }
  const canvas = document.createElement('canvas');
  if (!canvas.getContext('webgl2') && !canvas.getContext('webgl')) {
    problems.push('WebGL is unavailable, so the 3D paddle view cannot render. Enable hardware acceleration in your browser settings.');
  }
  return problems;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS));
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [problems] = useState(preflightProblems);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const engine = getEngine();
    engine.initializeScene();
    setSnap(engine.getSnapshot());
    const id = setInterval(() => {
      if (engineRef.current) setSnap(engineRef.current.getSnapshot());
    }, UI_POLL_MS);
    return () => {
      clearInterval(id);
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [settingsOpen]);

  const getEngine = () => {
    if (!engineRef.current) {
      engineRef.current = new Engine(
        { video: videoRef.current!, overlay: overlayRef.current!, sceneContainer: sceneRef.current! },
        settings,
        loadCalibration(settings.frame),
        (c) => saveJSON(CALIBRATION_KEY, c),
      );
    }
    return engineRef.current;
  };

  const start = async (deviceId?: string) => {
    const engine = getEngine();
    const done = engine.start(deviceId);
    setSnap(engine.getSnapshot());
    await done;
    setSnap(engine.getSnapshot());
    setCameras(await listCameras()); // labels are only available after permission
  };

  const updateSettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveJSON(SETTINGS_KEY, next);
    engineRef.current?.updateSettings(next);
  };

  const phase = snap?.phase ?? 'idle';
  const status = snap?.motion.status;

  return (
    <div className="app">
      <header>
        <h1>Table Tennis · Motion Control PoC</h1>
        <div className="header-status">
          {phase === 'running' && status && <span className={`pill ${status}`}>{status}</span>}
          {snap && phase === 'running' && (
            <span className="fps">
              cam {snap.metrics.cameraFps.toFixed(0)} · track {snap.metrics.processedFps.toFixed(0)} · render {snap.metrics.renderFps.toFixed(0)} fps · inference{' '}
              {snap.metrics.inferenceMeanMs.toFixed(1)} ms
            </span>
          )}
          <button className="icon-button" aria-label="Open settings and diagnostics" title="Settings and diagnostics" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>

      <main>
        <div className="left">
          {/* Match the camera's aspect ratio so the overlay lines up with the video. */}
          <div className="video-wrap" style={snap?.camera ? { aspectRatio: `${snap.camera.width} / ${snap.camera.height}` } : undefined}>
            <video ref={videoRef} className={settings.mirror ? 'mirrored' : undefined} playsInline muted />
            <canvas ref={overlayRef} className="overlay" style={{ display: settings.showOverlay ? undefined : 'none' }} />
            {snap && <CalibrationPrompt snap={snap} />}
            {phase !== 'running' && (
              <div className="start-card">
                {phase === 'starting' ? (
                  <p>{snap?.loadingMessage || 'Starting…'}</p>
                ) : (
                  <>
                    {phase === 'error' && snap?.error && <p className="error">{snap.error.message}</p>}
                    {problems.map((p) => (
                      <p key={p} className="error">{p}</p>
                    ))}
                    <button className="primary big" onClick={() => start()}>
                      {phase === 'error' ? 'Retry' : 'Enable camera'}
                    </button>
                    <p className="privacy">Video is processed locally in your browser. Nothing is recorded or uploaded.</p>
                  </>
                )}
              </div>
            )}
            {phase === 'running' && snap?.trackerLoading && <div className="loading-badge">Loading model…</div>}
          </div>
          {snap && (
            <CalibrationPanel
              snap={snap}
              onFull={() => engineRef.current?.startCalibration(true)}
              onNeutral={() => engineRef.current?.startCalibration(false)}
              onRange={() => engineRef.current?.startRangeCalibration()}
              onCancel={() => engineRef.current?.cancelCalibration()}
              onReset={() => engineRef.current?.resetCalibration()}
            />
          )}
          <p className="tips">
            Tips: sit or stand 1–2 m back so your head, shoulders and paddle arm are in frame. Light from the front, not behind you.
            Short sleeves or a contrasting top help.
          </p>
        </div>

        <div className="center">
          <div className="scene-wrap">
            <div className="scene" ref={sceneRef} />
            {snap && phase === 'running' && (
              <div className="scoreboard">
                {snap.rally.phase === 'idle' ? (
                  <p>Contact drill · one slow ball</p>
                ) : (
                  <>
                    <p>You {snap.rally.playerScore} · {snap.rally.opponentScore} CPU</p>
                    <p>{snap.rally.message}</p>
                  </>
                )}
              </div>
            )}
          </div>
          {snap && phase === 'running' && (
            <div className="ball-controls">
              <button className="primary" onClick={() => engineRef.current?.launchBall()}>Feed one ball</button>
              <button className="primary" onClick={() => engineRef.current?.startRally()}>
                {snap.rally.phase === 'idle' ? 'Start rally' : 'Restart match'}
              </button>
              <button onClick={() => engineRef.current?.resetBall()}>Clear ball</button>
              <span className={`ball-status ${snap.ball.status}`}>
                {snap.rally.phase !== 'idle'
                  ? snap.rally.message
                  : snap.ball.status === 'idle' ? 'Set your paddle, then feed a ball' : snap.ball.lastEvent}
              </span>
            </div>
          )}
        </div>
      </main>

      {settingsOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSettingsOpen(false);
        }}>
          <aside className="settings-drawer" role="dialog" aria-modal="true" aria-label="Settings and diagnostics">
            <div className="drawer-header">
              <div><span className="eyebrow">Control panel</span><h2>Settings & diagnostics</h2></div>
              <button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button>
            </div>
            <SettingsPanel
              settings={settings}
              onChange={updateSettings}
              cameras={cameras}
              currentCameraId={snap?.camera?.deviceId}
              onCameraChange={(id) => start(id)}
            />
            {snap && phase === 'running' && <DebugPanel snap={snap} />}
          </aside>
        </div>
      )}
    </div>
  );
}
