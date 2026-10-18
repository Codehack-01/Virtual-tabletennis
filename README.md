# Table Tennis · Motion Control PoC

Phase Three foundation of the webcam-controlled table tennis prototype: move your real arm in front of a laptop webcam, drive a virtual paddle, detect deliberate swings, and return a simulated ball.

Everything runs locally in the browser. Webcam frames are processed in-page and never recorded or uploaded. After `npm install` the pose model and WASM runtime are served from `public/`, so no CDN is needed at runtime.

## Run it

Requires Node 20+ and a recent Chrome or Edge (Safari and Firefox should work, but Chrome gives the best MediaPipe GPU performance and the latency metric).

```bash
npm install        # also copies the MediaPipe WASM and downloads the pose models into public/
npm run dev        # → http://localhost:5173
```

Open **http://localhost:5173** (use `localhost`, not a LAN IP: browsers only allow camera access on secure origins).

Other scripts: `npm test` (unit tests), `npm run build` (typecheck + production build), `npm run setup:assets` (re-fetch models).

## Testing with your webcam

1. Click **Enable camera** and allow access.
2. Sit or stand 1–2 m from the laptop so your **head, both shoulders and paddle arm** are in frame. Light from the front, not a window behind you.
3. Check the skeleton overlay. Your paddle arm is drawn in cyan, the raw wrist is a red ring, and the filtered wrist the paddle uses is a green dot. The status pill should say **TRACKING**.
4. Click **Calibrate**:
   - *Ready position* (3 s countdown, then 1.5 s capture): hold your normal ready stance, still.
   - *Sweep* (2 s countdown, then 6 s capture): move your paddle hand to the furthest left, right, high and low points you'd comfortably reach. The yellow dashed box on the preview shows the resulting range.
5. Move your arm. The paddle should follow, reaching the edges of the grey box in the 3D view at the edges of your calibrated range.
6. Things to try:
   - Slow repositioning vs. fast swings: watch the yellow velocity arrow and *Peak speed*.
   - Drop your arm out of frame: status goes **HOLDING** (paddle freezes), then **LOST** (paddle fades and drifts to neutral). Bring it back and the paddle eases in.
   - Smoothing presets (Responsive / Balanced / Smooth), then fine-tune with the sliders.
   - Make deliberate fast strokes: a detected swing flashes over the preview and is added to the swing log. Slower 70–100% attempts appear as near misses to help tune the threshold.
   - Click **Launch ball** and try to return it. The simulation runs at a fixed 240 Hz and uses a swept paddle test so a fast ball cannot skip through the paddle between rendered frames.
   - Click **Start match** for a scored training rally. The CPU serves and returns predictable legal shots; double bounces, net faults, misses and balls sent long award points automatically, followed by the next serve.

Settings and calibration are saved in `localStorage`. **Reset** returns to the default mapping.

## Architecture

```
Webcam ─▶ Tracking ─▶ Motion estimation ─▶ Paddle controller ─▶ Rendering
          src/tracking  src/motion          src/control          src/render
                  └──────────── orchestrated by src/engine (outside React) ───────────┘
```

| Layer | Files | Responsibility |
|---|---|---|
| Tracking | `tracking/camera.ts`, `poseTracker.ts`, `arm.ts` | getUserMedia + error classification; MediaPipe Pose Landmarker; produces an `ArmObservation` (wrist, elbow, shoulders) in display coordinates. **This interface is the swap point** for a different tracker. |
| Motion | `motion/motionEstimator.ts`, `oneEuroFilter.ts` | Control-space conversion, glitch rejection, One Euro smoothing, velocity (least-squares over a time window), direction, forearm angle, tracking-loss state machine. |
| Control | `control/calibration.ts`, `paddleController.ts` | Neutral + asymmetric range calibration; maps to a world-space paddle volume; hold / return-to-neutral / re-acquire blending; optional prediction. |
| Render | `render/paddleScene.ts`, `overlay.ts` | Plain Three.js scene (table, net, paddle volume, paddle, trail, velocity arrow); 2D debug overlay. |
| Engine | `engine/engine.ts` | Runs inference on each new video frame (`requestVideoFrameCallback`, rAF fallback), renders on rAF, collects metrics, runs calibration. |
| UI | `App.tsx`, `ui/*` | React. Polls `engine.getSnapshot()` 5×/s for display only. No React state changes per frame. |

### Key choices

- **MediaPipe Pose Landmarker (lite), not Hand Landmarker.** Hand Landmarker re-detects the palm whenever tracking drops, and it struggles with the small, motion-blurred hands you get at arm's length during a swing. Pose tracks the whole upper body, so the wrist stays anchored by the elbow and shoulder through fast movement. It also gives us shoulder width (for scale) and the forearm angle (for paddle tilt). The cost is coarser wrist precision and no finger or paddle-face detail. Hand Landmarker could later be added *alongside* Pose for paddle-face orientation. The `full` model is selectable in the UI if `lite` is too jittery.
- **One Euro filter** on position: heavy smoothing when still (no jitter), light smoothing when fast (swings aren't delayed). It uses vector speed so diagonal motion isn't distorted.
- **Glitch rejection:** single-frame jumps faster than a plausibility limit are ignored, but never more than 2 frames in a row, because a jump that persists is real.
- **Reference frame:** *Camera* (default) means stepping sideways moves the paddle, like real footwork. *Body* measures the wrist relative to the shoulders, so only arm movement counts.
- **GPU delegate with automatic CPU fallback**, plus local assets with a remote fallback. Any fallback that happens is listed under *Warnings*.
- **Rendered arm** (`PaddleController.solveArm`) belongs to the player's body. The shoulder's sideways position follows your tracked shoulder through the paddle's own mapping (so stepping moves body and paddle together). The filtered tracked elbow supplies both the primary bend direction and the elbow angle; the shoulder is allowed a small, smoothed lean so the larger gameplay hand mapping cannot force the chain straight on a swing or into a sharp L on return. A fallback covers frames where the elbow is unavailable. Brief tracking gaps literally freeze the last rendered pose, while a render-rate speed limit prevents a bad landmark from teleporting the arm across the table. The arm is visual only; gameplay uses the paddle pose.
- **Stillness first, glide when moving:** extra grip smoothing applies only while the hand is still. A direction reversal uses the newest filtered frame velocity immediately, so returning does not wait for the multi-frame swing detector to agree on the new direction. During a stroke the paddle glides between 30 Hz camera frames; the uncalibrated mapping remains linear and a range calibration learns asymmetric reach; backhand detection uses entry/exit hysteresis; small depth changes are ignored. `src/control/armStability.test.ts` feeds webcam-like landmark noise through the real pipeline and fails if the arm flinches at rest, whips or stutters on a fast cross-body swing, or lags a stroke.

## Tuning

| Symptom | Adjust |
|---|---|
| Paddle shakes while you hold still | Lower **Smoothing at rest** (e.g. 0.5 Hz), or switch to the *full* model |
| Paddle lags behind fast swings | Raise **Speed responsiveness (beta)** (10–15), or try the *Responsive* preset |
| Still lags slightly at all speeds | Add **Prediction** 10–20 ms (it overshoots when you stop abruptly) |
| Need to move too far to reach the edges | Recalibrate with a smaller sweep, or raise **Gain** |
| Tracking drops out often | Improve lighting / framing first; then lower **Min wrist visibility** (0.3–0.4) |
| Paddle occasionally jumps to a wrong spot | Raise **Min wrist visibility**; lower **Glitch speed limit** |
| Paddle freezes too long or too briefly after loss | **Hold after loss**, **Return to neutral** |

Watch the performance panel while tuning. *Inference p95* should stay well under the camera frame interval (33 ms at 30 fps). If it doesn't, switch to `lite` / GPU, close other GPU-heavy tabs, or plug in the laptop.

## Limitations (please read)

- **This is 2D image tracking, not 3D paddle tracking.** The paddle follows the wrist's projection onto the camera image, mapped into a virtual volume. It does not reproduce your real paddle's 3D trajectory, and moving toward or away from the camera barely registers. The *Depth (experimental)* toggle uses MediaPipe's relative z estimate, which is noisy and should not be trusted for gameplay yet.
- **Paddle orientation remains an approximation.** Roll comes from the elbow→wrist screen angle; pitch/yaw proxies use forearm direction and MediaPipe's relative depth. Wrist rotation, the true paddle-face angle, and forehand vs. backhand face are not directly observed.
- **Speeds are in frame-heights per second.** The "≈ m/s" figure assumes a 38 cm shoulder width and ignores depth, so it's only for rough comparison.
- **Latency:** *Capture → landmarks* (Chrome only) covers camera timestamp to inference result. True motion-to-photon latency is higher: add sensor exposure, USB transfer, render, and display time (typically 30–60 ms more). Most laptop webcams deliver 30 fps, and less in dim light because auto-exposure lengthens frames. Expect roughly 70–120 ms end-to-end. That's fine for positioning, but it will matter for reacting to a fast ball in Phase 3.
- **Motion blur** in fast swings lowers landmark confidence. Glitch rejection and the hold state cover short dropouts, but very fast swings may briefly read as HOLDING. Better lighting (shorter exposure) helps more than any setting.
- One person in frame. If several people are visible, MediaPipe picks one.

## What has been verified

- Unit tests (`npm test`): One Euro jitter reduction and fast-motion lag, velocity estimation, control-space conversion, hold→lost→reacquire state machine, glitch rejection, calibration maths.
- Headless Chrome end-to-end with a synthetic camera feed (a photo of a person panned across the frame): model loads from local assets, wrist tracked in 100% of frames with 0 glitches, paddle follows the motion, the calibration flow completes and persists across reload, and denied camera permission shows the correct message with Retry.
- **Not yet verified:** a live human swinging in front of a real webcam. That is the next test, and the one that decides whether this approach is good enough.

## Next steps

### Phase Three: gameplay refinement
- Tune launch trajectory, collision generosity, and swing transfer from live returns.
- Add scoring, legal-bounce tracking, serve/rally states, and automatic relaunch.
- Add paddle-face pitch/yaw and spin after the basic return loop feels reliable.
