import { DEFAULT_SETTINGS, type Settings } from '../config';

type NumericKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

interface SliderSpec {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  help: string;
}

const SMOOTHING: SliderSpec[] = [
  { key: 'minCutoff', label: 'Smoothing at rest (min cutoff)', min: 0.05, max: 5, step: 0.05, unit: 'Hz', help: 'Lower = steadier when still, but slow movements lag more.' },
  { key: 'beta', label: 'Speed responsiveness (beta)', min: 0, max: 30, step: 0.5, help: 'Higher = less lag during fast swings. Too high lets jitter through while moving.' },
  { key: 'dCutoff', label: 'Speed estimate cutoff', min: 0.1, max: 5, step: 0.1, unit: 'Hz', help: 'Rarely needs changing.' },
  { key: 'predictionMs', label: 'Prediction', min: 0, max: 60, step: 5, unit: 'ms', help: 'Extrapolates along the velocity to hide latency. Overshoots when you stop suddenly.' },
];

const MAPPING: SliderSpec[] = [
  { key: 'gain', label: 'Gain', min: 0.5, max: 2.5, step: 0.05, unit: '×', help: '>1 = less arm movement needed to reach the edges.' },
  { key: 'velocityWindowMs', label: 'Velocity window', min: 33, max: 250, step: 1, unit: 'ms', help: 'Longer = smoother speed readings, slower to react.' },
];

const ROBUSTNESS: SliderSpec[] = [
  { key: 'minVisibility', label: 'Min wrist visibility', min: 0.1, max: 0.95, step: 0.05, help: 'A lower value recognizes a bent ready arm near your torso. Raise it only if the paddle follows false wrist positions.' },
  { key: 'maxPlausibleSpeed', label: 'Glitch speed limit', min: 3, max: 40, step: 1, unit: 'fh/s', help: 'Single-frame jumps faster than this (frame-heights/s) are ignored.' },
  { key: 'holdMs', label: 'Hold after loss', min: 0, max: 1000, step: 25, unit: 'ms', help: 'Paddle freezes this long before treating the wrist as lost.' },
  { key: 'returnToNeutralMs', label: 'Return to neutral', min: 100, max: 3000, step: 50, unit: 'ms', help: 'How quickly a lost paddle drifts back to neutral.' },
];

const SWING: SliderSpec[] = [
  { key: 'swingStartSpeed', label: 'Swing start speed', min: 0.5, max: 6, step: 0.1, unit: 'fh/s', help: 'A movement must exceed this speed before it can count as a swing.' },
  { key: 'swingEndSpeed', label: 'Swing end speed', min: 0.2, max: 4, step: 0.1, unit: 'fh/s', help: 'Lower than the start threshold so a swing does not flicker on and off.' },
  { key: 'swingMinDurationMs', label: 'Minimum fast motion', min: 30, max: 250, step: 10, unit: 'ms', help: 'Rejects brief tracking spikes; lower detects shorter snaps.' },
];

const PADDLE_CONTROL: SliderSpec[] = [
  { key: 'collisionAssist', label: 'Collision assistance', min: 0, max: 1, step: 0.05, help: '0 = physical paddle size; 1 = maximum webcam latency and hitbox assistance.' },
  { key: 'netClearanceAssist', label: 'Net-clearance assistance', min: 0, max: 1, step: 0.05, help: 'Adds only the missing lift: 0 = your swing controls everything; 1 = guaranteed clearance.' },
];

const PHYSICS: SliderSpec[] = [
  { key: 'cpuErrorRate', label: 'Opponent mistakes', min: 0, max: 0.4, step: 0.01, help: 'Base chance the opponent misses, nets or hits long on each return. Fast and wide shots raise it. 0 = never misses.' },
  { key: 'feedSpeed', label: 'Opponent shot speed', min: 2.2, max: 5.5, step: 0.1, unit: 'm/s', help: 'Speed of serves and predictable CPU returns.' },
  { key: 'ballDrag', label: 'Air drag', min: 0, max: 0.4, step: 0.01, help: 'Higher values slow the ball more during flight.' },
  { key: 'tableRestitution', label: 'Table bounce', min: 0.5, max: 1, step: 0.01, help: 'Vertical speed retained after a table bounce.' },
  { key: 'paddleRestitution', label: 'Paddle rebound', min: 0.5, max: 1.2, step: 0.01, help: 'Incoming speed retained by the paddle.' },
  { key: 'swingTransfer', label: 'Swing transfer', min: 0.2, max: 1.4, step: 0.05, help: 'How strongly your tracked paddle velocity affects the outgoing shot.' },
];

const PRESETS: Record<string, Partial<Settings>> = {
  Responsive: { minCutoff: 1.5, beta: 12, predictionMs: 15 },
  Balanced: { minCutoff: DEFAULT_SETTINGS.minCutoff, beta: DEFAULT_SETTINGS.beta, predictionMs: 0 },
  Smooth: { minCutoff: 0.5, beta: 2, predictionMs: 0 },
};

const DIFFICULTY: Record<string, Partial<Settings>> = {
  Easy: { cpuErrorRate: 0.22, feedSpeed: 2.7, collisionAssist: 0.9, netClearanceAssist: 0.75, ballDrag: 0.15, tableRestitution: 0.84, paddleRestitution: 0.8, swingTransfer: 0.55 },
  Balanced: { cpuErrorRate: 0.12, feedSpeed: 3.2, collisionAssist: 0.65, netClearanceAssist: 0.4, ballDrag: 0.12, tableRestitution: 0.88, paddleRestitution: 0.86, swingTransfer: 0.65 },
  Realistic: { cpuErrorRate: 0.06, feedSpeed: 4.2, collisionAssist: 0.2, netClearanceAssist: 0.05, ballDrag: 0.08, tableRestitution: 0.9, paddleRestitution: 0.92, swingTransfer: 0.85 },
};

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  cameras: MediaDeviceInfo[];
  currentCameraId?: string;
  onCameraChange: (deviceId: string) => void;
}

export function SettingsPanel({ settings, onChange, cameras, currentCameraId, onCameraChange }: Props) {
  const slider = (s: SliderSpec) => (
    <label key={s.key} className="slider" title={s.help}>
      <span>
        {s.label}
        <output>
          {Number(settings[s.key]).toFixed(s.step < 0.1 ? 2 : s.step < 1 ? 1 : 0)}
          {s.unit ? ` ${s.unit}` : ''}
        </output>
      </span>
      <input type="range" min={s.min} max={s.max} step={s.step} value={settings[s.key]} onChange={(e) => onChange({ [s.key]: Number(e.target.value) })} />
      <small>{s.help}</small>
    </label>
  );

  return (
    <div className="settings">
      <section>
        <h3>Input</h3>
        <div className="grid2">
          <label>
            Paddle hand
            <select value={settings.hand} onChange={(e) => onChange({ hand: e.target.value as Settings['hand'] })}>
              <option value="right">Right</option>
              <option value="left">Left</option>
            </select>
          </label>
          <label title="camera: stepping sideways moves the paddle (like real footwork). body: only arm movement relative to your shoulders counts.">
            Reference
            <select value={settings.frame} onChange={(e) => onChange({ frame: e.target.value as Settings['frame'] })}>
              <option value="camera">Camera (body + arm)</option>
              <option value="body">Body (arm only)</option>
            </select>
          </label>
          <label title="lite is faster; full is more accurate but slower.">
            Pose model
            <select value={settings.model} onChange={(e) => onChange({ model: e.target.value as Settings['model'] })}>
              <option value="lite">Lite (fast)</option>
              <option value="full">Full (accurate)</option>
            </select>
          </label>
          <label>
            Processing
            <select value={settings.delegate} onChange={(e) => onChange({ delegate: e.target.value as Settings['delegate'] })}>
              <option value="GPU">GPU</option>
              <option value="CPU">CPU</option>
            </select>
          </label>
          {cameras.length > 1 && (
            <label className="span2">
              Camera
              <select value={currentCameraId ?? ''} onChange={(e) => onCameraChange(e.target.value)}>
                {cameras.map((c, i) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="toggles">
          <label><input type="checkbox" checked={settings.mirror} onChange={(e) => onChange({ mirror: e.target.checked })} /> Mirror preview</label>
          <label><input type="checkbox" checked={settings.showOverlay} onChange={(e) => onChange({ showOverlay: e.target.checked })} /> Skeleton overlay</label>
          <label title="Experimental: forearm angle is not the same as paddle-face rotation."><input type="checkbox" checked={settings.rollEnabled} onChange={(e) => onChange({ rollEnabled: e.target.checked })} /> Experimental forearm tilt</label>
          <label title="Experimental approximation only; a pose webcam cannot observe wrist rotation."><input type="checkbox" checked={settings.faceOrientationEnabled} onChange={(e) => onChange({ faceOrientationEnabled: e.target.checked })} /> Experimental face pitch/yaw</label>
          <label title="The game always uses a small filtered depth range. This enables the full, noisier calibrated range.">
            <input type="checkbox" checked={settings.depthEnabled} onChange={(e) => onChange({ depthEnabled: e.target.checked })} /> Extended depth (experimental)
          </label>
        </div>
        {settings.depthEnabled &&
          slider({ key: 'depthGain', label: 'Depth gain', min: 0.2, max: 4, step: 0.1, unit: '×', help: 'Scales the depth estimate. Recalibrate range after changing.' })}
      </section>

      <section>
        <h3>Smoothing</h3>
        <div className="presets">
          {Object.entries(PRESETS).map(([name, patch]) => (
            <button key={name} onClick={() => onChange(patch)}>{name}</button>
          ))}
        </div>
        {SMOOTHING.map(slider)}
      </section>

      <section>
        <h3>Mapping</h3>
        {MAPPING.map(slider)}
      </section>

      <section>
        <h3>Swing detection</h3>
        {SWING.map(slider)}
        <small className="section-help">Attempts reaching 70–100% of the start speed are logged as near misses.</small>
      </section>

      <section>
        <h3>Paddle control</h3>
        {PADDLE_CONTROL.map(slider)}
        <small className="section-help">Pitch/yaw are inferred from forearm geometry. The webcam cannot observe wrist rotation directly.</small>
      </section>

      <section>
        <h3>Difficulty & physics</h3>
        <div className="presets">
          {Object.entries(DIFFICULTY).map(([name, patch]) => (
            <button key={name} onClick={() => onChange(patch)}>{name}</button>
          ))}
        </div>
        {PHYSICS.map(slider)}
      </section>

      <section>
        <h3>Tracking loss</h3>
        {ROBUSTNESS.map(slider)}
      </section>

      <button className="secondary" onClick={() => onChange(DEFAULT_SETTINGS)}>Restore default settings</button>
    </div>
  );
}
