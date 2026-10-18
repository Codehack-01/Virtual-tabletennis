import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // MediaPipe ships its own WASM loader; pre-bundling it adds nothing.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
});
