import type { EngineSnapshot } from '../engine/engine';

interface Props {
  snap: EngineSnapshot;
  onFull: () => void;
  onNeutral: () => void;
  onRange: () => void;
  onCancel: () => void;
  onReset: () => void;
}

export function CalibrationPanel({ snap, onFull, onNeutral, onRange, onCancel, onReset }: Props) {
  const running = snap.calibrationRun !== null;
  const cal = snap.calibration;
  const disabled = snap.phase !== 'running';
  return (
    <div className="calibration">
      <div className="buttons">
        {running ? (
          <button onClick={onCancel}>Cancel calibration</button>
        ) : (
          <>
            <button className="primary" onClick={onFull} disabled={disabled}>Calibrate</button>
            <button onClick={onNeutral} disabled={disabled} title="Only re-capture the ready position">Neutral only</button>
            <button onClick={onRange} disabled={disabled} title="Only re-capture the movement range">Range only</button>
            <button className="secondary" onClick={onReset} disabled={disabled}>Reset</button>
          </>
        )}
      </div>
      <p className="hint">
        {!cal.neutralSet
          ? 'Ready position will be captured automatically when your arm is first tracked.'
          : !cal.rangeSet
            ? 'Ready position set. Using a conservative default reach; use Range only later if needed.'
            : 'Calibrated. Recalibrate if you move your chair or laptop.'}
      </p>
      {snap.calibrationMessage && <p className="cal-message">{snap.calibrationMessage}</p>}
    </div>
  );
}

/** Large instruction text drawn over the webcam preview while calibrating. */
export function CalibrationPrompt({ snap }: { snap: EngineSnapshot }) {
  const run = snap.calibrationRun;
  if (!run) return null;
  const secs = Math.ceil(run.remainingMs / 1000);
  const text = {
    'neutral-countdown': ['Get into your ready position', `Capturing in ${secs}…`],
    'neutral-capture': ['Hold still', 'Capturing neutral…'],
    'range-countdown': ['Next: sweep your reach', `Starting in ${secs}…`],
    'range-capture': ['Reach far left, far right, high and low', `Keep moving — ${secs} s`],
  }[run.step];
  return (
    <div className="cal-prompt">
      <strong>{text[0]}</strong>
      <span>{text[1]}</span>
    </div>
  );
}
