// Copies the MediaPipe WASM runtime out of node_modules and downloads the pose
// models into public/, so the app can run without fetching from a CDN at
// runtime. Runs automatically after `npm install`; safe to re-run.
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDest = join(root, 'public/mediapipe/wasm');
const modelDir = join(root, 'public/models');

const MODELS = {
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
};

if (existsSync(wasmSrc)) {
  mkdirSync(wasmDest, { recursive: true });
  cpSync(wasmSrc, wasmDest, { recursive: true });
  console.log('[assets] MediaPipe WASM copied to public/mediapipe/wasm');
} else {
  console.warn('[assets] @mediapipe/tasks-vision not installed yet; skipping WASM copy');
}

mkdirSync(modelDir, { recursive: true });
for (const [name, url] of Object.entries(MODELS)) {
  const dest = join(modelDir, name);
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`[assets] ${name} already present`);
    continue;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`[assets] downloaded ${name}`);
  } catch (err) {
    // Not fatal: the app falls back to loading the model from the remote URL.
    console.warn(`[assets] could not download ${name} (${err.message}); the app will load it remotely`);
  }
}
