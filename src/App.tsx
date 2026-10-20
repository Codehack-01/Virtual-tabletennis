import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, loadJSON, saveJSON, type ReferenceFrame, type Settings } from './config';
import { defaultCalibration, type Calibration } from './control/calibration';
import { Engine, type EngineSnapshot } from './engine/engine';
import { checkCameraSupport, listCameras } from './tracking/camera';
import { CalibrationPanel, CalibrationPrompt } from './ui/CalibrationPanel';
import { DebugPanel } from './ui/DebugPanel';
import { GameOverScreen } from './ui/GameOverScreen';
import { Scoreboard } from './ui/Scoreboard';
import { SettingsPanel } from './ui/SettingsPanel';
import '@fontsource/russo-one/400.css';
import '@fontsource/teko/500.css';
import '@fontsource/teko/600.css';
import './App.css';
import './ui/game.css';

// v5 restores the low-latency gameplay profile and discards the conservative
// control values that made the paddle trail the player's wrist.
const SETTINGS_KEY = 'ttpoc.settings.v5';
// v5 stores stable raw face/torso medians instead of a first-frame ratio.
const CALIBRATION_KEY = 'ttpoc.calibration.v5';
// Fast enough that score animations land with the point sound.
const UI_POLL_MS = 100;

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

type DockIconName = 'feed' | 'play' | 'reset' | 'calibrate' | 'settings' | 'outdoor' | 'indoor';

function DockIcon({ name }: { name: DockIconName }) {
  return (
    <svg className="dock-icon" viewBox="0 0 24 24" aria-hidden="true">
      {name === 'feed' && (
        <>
          <circle cx="12" cy="6.5" r="3" />
          <path d="M12 11v8M8.8 15.8 12 19l3.2-3.2" />
        </>
      )}
      {name === 'play' && <path className="icon-fill" d="M8.4 6.6c0-1 1.1-1.6 1.95-1.05l8.15 5.4a1.27 1.27 0 0 1 0 2.1l-8.15 5.4A1.26 1.26 0 0 1 8.4 17.4V6.6Z" />}
      {name === 'reset' && (
        <>
          <path d="M5.3 8.1A7.5 7.5 0 1 1 5 15.4" />
          <path d="M5.3 4.8v3.4h3.4" />
        </>
      )}
      {name === 'calibrate' && (
        <>
          <circle cx="12" cy="12" r="4.1" />
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
          <circle className="icon-fill" cx="12" cy="12" r="1.25" />
        </>
      )}
      {name === 'outdoor' && (
        <>
          <circle cx="12" cy="12" r="3.6" />
          <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" />
        </>
      )}
      {name === 'indoor' && (
        <>
          <path d="M3.5 10.5 12 4.5l8.5 6V19.5h-17Z" />
          <path d="M8 19.5v-5h8v5M8 14.5h8" />
        </>
      )}
      {name === 'settings' && (
        <>
          <path d="M4 7h3M11 7h9M4 17h9M17 17h3" />
          <circle cx="9" cy="7" r="2" />
          <circle cx="15" cy="17" r="2" />
        </>
      )}
    </svg>
  );
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
  const rallyActive = snap?.rally.phase !== 'idle';

  return (
    <div className="app">
      <div className="scene-wrap">
        <div className="scene" ref={sceneRef} />

        <div className="camera-card">
          <div className="camera-label"><span className="live-dot" /> Player camera</div>
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
                    {problems.map((p) => <p key={p} className="error">{p}</p>)}
                    <button className="primary" onClick={() => start()}>
                      {phase === 'error' ? 'Retry camera' : 'Enable camera'}
                    </button>
                    <p className="privacy">Processed privately on this device</p>
                  </>
                )}
              </div>
            )}
            {phase === 'running' && snap?.trackerLoading && <div className="loading-badge">Loading model…</div>}
          </div>
        </div>

        {snap && phase === 'running' && snap.rally.phase !== 'game-over' && <Scoreboard rally={snap.rally} />}

        {snap && phase === 'running' && (
          <div className="performance-hud">
            {status && <span className={`pill ${status}`}>{status}</span>}
            <span>{snap.metrics.processedFps.toFixed(0)} tracking fps</span>
          </div>
        )}

        <div className="control-dock" role="toolbar" aria-label="Game controls">
          <button className="dock-button" data-label="Feed ball" aria-label="Feed one ball" onClick={() => engineRef.current?.launchBall()} disabled={phase !== 'running'}>
            <DockIcon name="feed" />
          </button>
          <button className="dock-button dock-primary" data-label={rallyActive ? 'Restart match' : 'Start match'} aria-label={rallyActive ? 'Restart match' : 'Start match'} onClick={() => engineRef.current?.startRally()} disabled={phase !== 'running'}>
            <DockIcon name="play" />
          </button>
          <button className="dock-button" data-label="Reset ball" aria-label="Clear the current ball" onClick={() => engineRef.current?.resetBall()} disabled={phase !== 'running'}>
            <DockIcon name="reset" />
          </button>
          <span className="dock-divider" />
          <button
            className="dock-button"
            data-label={settings.environment === 'outdoor' ? 'Indoor court' : 'Outdoor court'}
            aria-label={settings.environment === 'outdoor' ? 'Switch to the indoor court' : 'Switch to the outdoor court'}
            onClick={() => updateSettings({ environment: settings.environment === 'outdoor' ? 'indoor' : 'outdoor' })}
          >
            <DockIcon name={settings.environment === 'outdoor' ? 'indoor' : 'outdoor'} />
          </button>
          <button className="dock-button" data-label="Calibrate" aria-label="Calibrate tracking" onClick={() => engineRef.current?.startCalibration(true)} disabled={phase !== 'running'}>
            <DockIcon name="calibrate" />
          </button>
          <button className="dock-button" data-label="Settings" aria-label="Open settings and diagnostics" onClick={() => setSettingsOpen(true)}>
            <DockIcon name="settings" />
          </button>
        </div>

        {snap && phase === 'running' && (
          <div className={`game-message ${snap.ball.status}`}>
            {rallyActive ? snap.rally.message : snap.ball.status === 'idle' ? 'Set your paddle, then feed a ball' : snap.ball.lastEvent}
          </div>
        )}

        {snap && phase === 'running' && snap.rally.phase === 'game-over' && (
          <GameOverScreen
            rally={snap.rally}
            onRematch={() => engineRef.current?.startRally()}
            onExit={() => engineRef.current?.resetBall()}
          />
        )}
      </div>

      {settingsOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSettingsOpen(false);
        }}>
          <aside className="settings-drawer" role="dialog" aria-modal="true" aria-label="Settings and diagnostics">
            <div className="drawer-header">
              <div><span className="eyebrow">Control panel</span><h2>Settings & diagnostics</h2></div>
              <button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button>
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
            <SettingsPanel
              settings={settings}
              onChange={updateSettings}
              cameras={cameras}
              currentCameraId={snap?.camera?.deviceId}
              onCameraChange={(id) => start(id)}
            />
            <p className="tips">Stay 1–2 m from the camera with your head, shoulders, and paddle arm in frame. Light yourself from the front.</p>
            {snap && phase === 'running' && <DebugPanel snap={snap} />}
          </aside>
        </div>
      )}
    </div>
  );
}
