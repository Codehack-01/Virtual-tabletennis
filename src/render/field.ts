import * as THREE from 'three';
import type { SceneEnvironment } from './environment';

/**
 * Open-air surroundings beyond the court barriers: a mown grass field running
 * to the horizon under a clear sky. Static scenery only.
 */

const SKY_TOP = new THREE.Color(0x4f97da);
const SKY_HORIZON = new THREE.Color(0xcfe3ef);
const FIELD_SIZE = 320;
// Texture tile in metres: four mowing stripes per tile.
const GRASS_TILE_M = 6;

/** Deterministic PRNG so the field looks identical on every load. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mown-lawn texture: alternating stripes plus thousands of short blades. */
function grassTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const stripes = 4;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? '#4f8a35' : '#5a9a3c';
    ctx.fillRect(0, (i * size) / stripes, size, size / stripes);
  }
  const random = mulberry32(7);
  const blades = ['#3f7428', '#6aa948', '#4b8531', '#78b555', '#365f22'];
  ctx.lineCap = 'round';
  for (let i = 0; i < 26000; i++) {
    const x = random() * size;
    const y = random() * size;
    const length = 3 + random() * 6;
    const angle = -Math.PI / 2 + (random() - 0.5) * 0.9;
    ctx.strokeStyle = blades[Math.floor(random() * blades.length)];
    ctx.globalAlpha = 0.35 + random() * 0.4;
    ctx.lineWidth = 1 + random();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(FIELD_SIZE / GRASS_TILE_M, FIELD_SIZE / GRASS_TILE_M);
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

function skyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(400, 32, 16);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: SKY_TOP }, horizon: { value: SKY_HORIZON } },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      varying vec3 vDirection;
      void main() {
        float h = clamp(vDirection.y, 0.0, 1.0);
        gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  return new THREE.Mesh(geometry, material);
}

export function buildField(renderer: THREE.WebGLRenderer): SceneEnvironment {
  const group = new THREE.Group();
  group.add(skyDome());

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD_SIZE, FIELD_SIZE),
    new THREE.MeshStandardMaterial({ map: grassTexture(renderer), roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  // Just below the court floor so the court surface always draws on top.
  ground.position.y = -0.01;
  ground.receiveShadow = true;
  group.add(ground);

  return {
    group,
    background: SKY_HORIZON.clone(),
    // Haze softens the far grass into the horizon.
    fog: new THREE.Fog(SKY_HORIZON.clone(), 30, 140),
    // Daylight: blue sky above, light bounced off the grass below.
    light: {
      sky: 0xcfe6ff, ground: 0x4d6b33, ambient: 1.25,
      key: 0xfff2dc, keyIntensity: 2.5, keyPosition: [-2.4, 4.5, 2.8],
    },
  };
}
