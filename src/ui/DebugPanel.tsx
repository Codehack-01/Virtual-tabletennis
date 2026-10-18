import type { EngineSnapshot } from '../engine/engine';

const f = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || !isFinite(n) ? '—' : n.toFixed(digits));
const signed = (n: number, digits = 2) => (n >= 0 ? '+' : '') + n.toFixed(digits);

function Row({ label, value, warn, title }: { label: string; value: React.ReactNode; warn?: boolean; title?: string }) {
  return (
    <tr title={title}>
      <th>{label}</th>
      <td className={warn ? 'warn' : undefined}>{value}</td>
    </tr>
  );
}

export function DebugPanel({ snap }: { snap: EngineSnapshot }) {
  const { metrics: m, motion, paddle, stats, calibration: cal } = snap;
  const cam = snap.camera;
  const acceptedPct = stats.framesTotal ? (stats.framesAccepted / stats.framesTotal) * 100 : 0;

  return (
    <div className="debug">
      <section>
        <h3>Performance</h3>
        <table>
          <tbody>
            <Row label="Camera" value={cam ? `${cam.width}×${cam.height} @ ${f(cam.frameRate, 0)} fps (reported)` : '—'} />
            <Row label="Camera frames" value={`${f(m.cameraFps, 0)} fps`} warn={m.cameraFps > 0 && m.cameraFps < 24} title="Frames delivered by the webcam. Low values usually mean poor lighting (auto-exposure slows the camera down)." />
            <Row label="Tracked frames" value={`${f(m.processedFps, 0)} fps`} warn={m.processedFps > 0 && m.processedFps < m.cameraFps * 0.8} title="Frames that went through pose inference." />
            <Row label="Skipped camera frames" value={m.droppedFrames} title="Camera frames that arrived while inference was still busy." />
            <Row label="Render" value={`${f(m.renderFps, 0)} fps`} />
            <Row label="Inference" value={`${f(m.inferenceMeanMs)} ms avg · ${f(m.inferenceP95Ms)} ms p95`} warn={m.inferenceP95Ms > 30} />
            <Row
              label="Capture → landmarks"
              value={m.captureToResultMs !== null ? `${f(m.captureToResultMs, 0)} ms` : 'n/a in this browser'}
              title="From camera capture timestamp to landmarks ready. Total motion-to-photon latency is higher: add display/render time (~16–33 ms) and camera exposure/USB latency, which the browser can't measure."
            />
            <Row label="Tracker" value={snap.trackerLoading ? 'loading…' : snap.trackerDescription || '—'} />
          </tbody>
        </table>
      </section>

      <section>
        <h3>Tracking</h3>
        <table>
          <tbody>
            <Row label="Status" value={<span className={`pill ${motion.status}`}>{motion.status}</span>} />
            <Row label="Wrist visibility" value={f(motion.wristVisibility, 2)} warn={motion.wristVisibility < 0.5} />
            <Row label="Tracked (last 3 s)" value={`${f(m.trackedPercent, 0)}%`} warn={m.trackedPercent < 90} />
            <Row label="Tracked (session)" value={`${f(acceptedPct, 0)}% of ${stats.framesTotal} frames`} />
            <Row label="Loss events" value={stats.lossEvents} />
            <Row label="Current / longest loss" value={`${f(stats.currentLossMs, 0)} / ${f(stats.longestLossMs, 0)} ms`} />
            <Row label="Glitches rejected" value={stats.outliersRejected} title="Single-frame jumps faster than the plausibility limit." />
            <Row label="Face / torso scale" value={motion.faceScale && motion.torsoScale ? `${f(motion.faceScale * 100, 1)} / ${f(motion.torsoScale * 100, 1)}%` : '—'} title="Raw arm-independent measurements used for camera distance." />
          </tbody>
        </table>
      </section>

      <section>
        <h3>Movement</h3>
        <table>
          <tbody>
            <Row label="Direction" value={<strong>{motion.direction}</strong>} />
            <Row label="Speed" value={`${f(motion.speed, 2)} frame-heights/s`} />
            <Row
              label="≈ Speed"
              value={snap.approxSpeedMs !== null ? `${f(snap.approxSpeedMs, 1)} m/s` : '—'}
              title="Very rough: assumes a 38 cm shoulder width and ignores motion toward/away from the camera."
            />
            <Row label="Peak speed (1 s)" value={`${f(m.peakSpeed1s, 2)} frame-heights/s`} />
            <Row label="Velocity x / y" value={`${signed(motion.velocity.x)} / ${signed(motion.velocity.y)}`} />
            <Row label="Forearm angle" value={motion.forearmAngle !== null ? `${f((motion.forearmAngle * 180) / Math.PI, 0)}°` : '—'} />
            <Row label="Face pitch / yaw" value={`${signed((paddle.pitch * 180) / Math.PI, 0)}° / ${signed((paddle.yaw * 180) / Math.PI, 0)}°`} title="Approximate values inferred from forearm geometry, not direct paddle-face tracking." />
            <Row label="Paddle (−1…1)" value={`x ${signed(paddle.normalized.x)} · y ${signed(paddle.normalized.y)} · z ${signed(paddle.normalized.z)}`} />
          </tbody>
        </table>
      </section>

      <section>
        <h3>Calibration</h3>
        <table>
          <tbody>
            <Row label="Neutral" value={cal.neutralSet ? `x ${signed(cal.neutral.x)} · y ${signed(cal.neutral.y)}` : 'default'} warn={!cal.neutralSet} />
            <Row
              label="Range"
              value={cal.rangeSet ? `L ${f(cal.range.left, 2)} R ${f(cal.range.right, 2)} U ${f(cal.range.up, 2)} D ${f(cal.range.down, 2)}` : 'default'}
              warn={!cal.rangeSet}
            />
            <Row label="Frame" value={cal.frame} />
          </tbody>
        </table>
      </section>

      <section className="swing-panel">
        <h3>Swing detection</h3>
        <table>
          <tbody>
            <Row label="State" value={<strong className={snap.swing.active ? 'swing-live' : undefined}>{snap.swing.active ? 'SWINGING' : 'ready'}</strong>} />
            <Row label="Detected" value={snap.swing.total} />
            <Row label="Near misses" value={snap.swing.nearMisses} title="Movements that reached at least 70% of the start threshold but did not qualify." />
          </tbody>
        </table>
        {snap.swing.events.length > 0 ? (
          <ol className="swing-log">
            {snap.swing.events.slice(0, 6).map((event) => (
              <li key={event.id} className={event.nearMiss ? 'near-miss' : undefined}>
                <strong>{event.nearMiss ? 'near miss' : event.direction}</strong>
                <span>{f(event.peakSpeed, 2)} fh/s · {f(event.durationMs, 0)} ms</span>
              </li>
            ))}
          </ol>
        ) : <p className="empty-log">Make a fast, consistent movement to record a swing.</p>}
      </section>

      <section>
        <h3>Ball</h3>
        <table>
          <tbody>
            <Row label="Status" value={snap.ball.status} />
            <Row label="Last event" value={snap.ball.lastEvent} />
            <Row label="Paddle hits / bounces" value={`${snap.ball.paddleHits} / ${snap.ball.bounces}`} />
            <Row label="Position x / y / z" value={`${signed(snap.ball.position.x)} / ${signed(snap.ball.position.y)} / ${signed(snap.ball.position.z)}`} />
            <Row label="Velocity x / y / z" value={`${signed(snap.ball.velocity.x)} / ${signed(snap.ball.velocity.y)} / ${signed(snap.ball.velocity.z)}`} />
          </tbody>
        </table>
      </section>

      <section>
        <h3>Rally</h3>
        <table>
          <tbody>
            <Row label="Phase" value={snap.rally.phase} />
            <Row label="Score" value={`${snap.rally.playerScore} – ${snap.rally.opponentScore}`} />
            <Row label="Current / best rally" value={`${snap.rally.rallyHits} / ${snap.rally.bestRally}`} />
            <Row label="Call" value={snap.rally.message} />
            <Row label="Contacts / legal returns" value={`${snap.rally.stats.contacts} / ${snap.rally.stats.legalReturns}`} />
            <Row label="Misses / net / long" value={`${snap.rally.stats.misses} / ${snap.rally.stats.netFaults} / ${snap.rally.stats.longFaults}`} />
            <Row label="Return speed avg / peak" value={`${f(snap.rally.stats.averageReturnSpeed, 1)} / ${f(snap.rally.stats.peakReturnSpeed, 1)} m/s`} />
            <Row label="CPU returns / serves" value={`${snap.rally.stats.opponentReturns} / ${snap.rally.stats.serves}`} />
          </tbody>
        </table>
      </section>

      {snap.warnings.length > 0 && (
        <section>
          <h3>Warnings</h3>
          <ul className="warnings">
            {snap.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
