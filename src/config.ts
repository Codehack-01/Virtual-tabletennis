export type Hand = 'right' | 'left';
/**
 * camera: wrist position relative to the camera image (stepping sideways moves the paddle).
 * body:   wrist position relative to the shoulders (only the arm moves the paddle).
 */
export type ReferenceFrame = 'camera' | 'body';
export type ModelVariant = 'lite' | 'full';
export type Delegate = 'GPU' | 'CPU';
/** Backdrop around the court: open-air field or indoor hall. */
export type Environment = 'outdoor' | 'indoor';

export interface Settings {
  hand: Hand;
  mirror: boolean;
  frame: ReferenceFrame;
  model: ModelVariant;
  delegate: Delegate;
  /** Wrist landmarks below this visibility score are treated as missing. */
  minVisibility: number;
  /** One Euro filter: cutoff (Hz) at rest. Lower = less jitter, more lag when slow. */
  minCutoff: number;
  /** One Euro filter: how fast the cutoff rises with speed. Higher = less lag on fast swings. */
  beta: number;
  /** One Euro filter: cutoff (Hz) for the speed estimate that drives beta. */
  dCutoff: number;
  /** Single-frame jumps faster than this (image heights/s) are rejected as glitches. */
  maxPlausibleSpeed: number;
  /** How long the paddle freezes in place after the wrist is lost. */
  holdMs: number;
  /** Time constant for drifting back to neutral once tracking is lost. */
  returnToNeutralMs: number;
  /** Extrapolate the paddle forward along its velocity to hide some latency. */
  predictionMs: number;
  /** Multiplier on calibrated movement range (>1 = less arm movement needed). */
  gain: number;
  /** Time window for the velocity estimate. */
  velocityWindowMs: number;
  /** Experimental: expand the conservative default depth range to its full calibrated range. */
  depthEnabled: boolean;
  depthGain: number;
  /** Tilt the paddle to follow the forearm angle. */
  rollEnabled: boolean;
  showOverlay: boolean;
  environment: Environment;
  /** Speed needed to begin a swing candidate (image heights/s). */
  swingStartSpeed: number;
  /** Speed below which an active swing ends. Kept below start for hysteresis. */
  swingEndSpeed: number;
  /** Candidate must remain fast and directionally consistent for this long. */
  swingMinDurationMs: number;
  /** Use forearm geometry as a proxy for paddle face pitch/yaw. */
  faceOrientationEnabled: boolean;
  /** 0 = physical paddle hitbox, 1 = generous webcam latency compensation. */
  collisionAssist: number;
  /** 0 = swing alone supplies lift, 1 = guarantee net clearance. */
  netClearanceAssist: number;
  /** Opponent feed/return speed in metres per second. */
  feedSpeed: number;
  /** Exponential air-drag coefficient. */
  ballDrag: number;
  tableRestitution: number;
  paddleRestitution: number;
  swingTransfer: number;
  /** Base chance the CPU makes a mistake on a return (0 = never misses). */
  cpuErrorRate: number;
}

export const DEFAULT_SETTINGS: Settings = {
  hand: 'right',
  mirror: true,
  frame: 'camera',
  // On a real player's footage (hand low near the frame edge) the lite model
  // teleported the wrist up to 385 px between frames; full held it within
  // ~27 px. The engine drops back to lite on devices too slow for full.
  model: 'full',
  delegate: 'GPU',
  // A bent ready arm puts the wrist close to the torso, where BlazePose reports
  // lower confidence than it does for an extended arm.
  minVisibility: 0.3,
  minCutoff: 1.5,
  beta: 12,
  dCutoff: 1.0,
  maxPlausibleSpeed: 15,
  holdMs: 250,
  returnToNeutralMs: 600,
  predictionMs: 15,
  gain: 1,
  velocityWindowMs: 66,
  depthEnabled: false,
  depthGain: 1,
  rollEnabled: false,
  showOverlay: true,
  environment: 'outdoor',
  swingStartSpeed: 1.8,
  swingEndSpeed: 0.8,
  swingMinDurationMs: 80,
  faceOrientationEnabled: false,
  collisionAssist: 0.65,
  netClearanceAssist: 0.4,
  feedSpeed: 3.2,
  ballDrag: 0.12,
  tableRestitution: 0.88,
  paddleRestitution: 0.86,
  swingTransfer: 0.65,
  cpuErrorRate: 0.12,
};

/** Assumed real shoulder width, used only to give speeds an approximate m/s reading. */
export const ASSUMED_SHOULDER_WIDTH_M = 0.38;

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode etc.) — settings just won't persist.
  }
}

/** Preferences a player sets on purpose, carried over from pre-v6 storage. */
const CARRIED_PREFERENCES: (keyof Settings)[] = ['hand', 'mirror', 'environment', 'showOverlay'];

/**
 * Settings are stored as only the values the player changed. Everything else
 * follows DEFAULT_SETTINGS, so tuning improvements in the code reach players
 * who have touched any setting (previously the whole object was saved, which
 * froze every value at whatever the defaults were that day).
 */
export function loadSettings(key: string, legacyKey?: string): Settings {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    const legacy = legacyKey ? localStorage.getItem(legacyKey) : null;
    if (legacy) {
      // One-time migration: keep deliberate preferences, reset old tuning.
      const old = JSON.parse(legacy) as Partial<Settings>;
      const carried: Partial<Settings> = {};
      for (const name of CARRIED_PREFERENCES) {
        if (old[name] !== undefined) (carried as Record<string, unknown>)[name] = old[name];
      }
      const settings = { ...DEFAULT_SETTINGS, ...carried };
      saveSettings(key, settings);
      return settings;
    }
  } catch {
    // Unreadable storage: fall through to defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(key: string, settings: Settings): void {
  const changed: Partial<Settings> = {};
  for (const name of Object.keys(settings) as (keyof Settings)[]) {
    if (settings[name] !== DEFAULT_SETTINGS[name]) (changed as Record<string, unknown>)[name] = settings[name];
  }
  saveJSON(key, changed);
}
