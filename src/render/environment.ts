import type * as THREE from 'three';

export type EnvironmentName = 'outdoor' | 'indoor';

/** A swappable backdrop around the court: its scenery, sky/room colour and lighting. */
export interface SceneEnvironment {
  group: THREE.Group;
  background: THREE.Color;
  fog: THREE.Fog | null;
  light: {
    /** Hemisphere light: colour from above, colour from below, intensity. */
    sky: number;
    ground: number;
    ambient: number;
    /** The shadow-casting key light (sun outdoors, ceiling rig indoors). */
    key: number;
    keyIntensity: number;
    keyPosition: [number, number, number];
  };
}
