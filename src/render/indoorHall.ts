import * as THREE from 'three';
import type { SceneEnvironment } from './environment';

/**
 * Indoor night arena: a dark venue around the court, an illuminated sponsor
 * fascia, and a spotlight that pools light on the court so play stays bright
 * while the surroundings fall away into the dark.
 */

export function buildIndoorHall(): SceneEnvironment {
  const group = new THREE.Group();

  // Dark venue floor; the court surface sits just above it.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x10151d, roughness: 0.55, metalness: 0.1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.01;
  floor.receiveShadow = true;
  group.add(floor);

  // Venue shell behind the opponent and along both sides.
  const shell = new THREE.MeshStandardMaterial({ color: 0x151b25, roughness: 0.86 });
  const rearWall = new THREE.Mesh(new THREE.BoxGeometry(14, 4.2, 0.12), shell);
  rearWall.position.set(0, 2.1, -6.55);
  group.add(rearWall);
  for (const side of [-1, 1]) {
    const sideWall = new THREE.Mesh(new THREE.BoxGeometry(0.12, 4.2, 13), shell);
    sideWall.position.set(side * 7, 2.1, -0.4);
    group.add(sideWall);
  }

  // Illuminated sponsor fascia.
  const fascia = new THREE.Mesh(
    new THREE.BoxGeometry(8.5, 0.52, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x0d2740, roughness: 0.58, metalness: 0.18, emissive: 0x0a2a48, emissiveIntensity: 0.6 }),
  );
  fascia.position.set(0, 2.25, -6.45);
  group.add(fascia);

  // Gameplay spotlight: a soft-edged pool of light over the court. It lives in
  // this group, so it switches off with the rest of the indoor scenery.
  const spot = new THREE.SpotLight(0xfff6e8, 95, 0, 0.48, 0.7, 2);
  spot.position.set(0, 6, 0.2);
  spot.target.position.set(0, 0, 0);
  group.add(spot, spot.target);

  return {
    group,
    background: new THREE.Color(0x0b1018),
    fog: null,
    // Cool, low ambient keeps the venue dark; the key light still gives the
    // table and paddle crisp shadows and shape.
    light: {
      sky: 0xcfe5ff, ground: 0x17202c, ambient: 0.75,
      key: 0xffffff, keyIntensity: 1.3, keyPosition: [-2.4, 4.5, 2.8],
    },
  };
}
