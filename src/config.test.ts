import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './config';

// Minimal in-memory localStorage for the node test environment.
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

describe('settings storage', () => {
  beforeEach(() => store.clear());

  it('stores only the settings the player changed', () => {
    saveSettings('s', { ...DEFAULT_SETTINGS, environment: 'indoor' });
    expect(JSON.parse(store.get('s')!)).toEqual({ environment: 'indoor' });
  });

  it('lets later default changes reach a player who changed something else', () => {
    store.set('s', JSON.stringify({ environment: 'indoor' }));
    const settings = loadSettings('s');
    expect(settings.environment).toBe('indoor');
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(settings.beta).toBe(DEFAULT_SETTINGS.beta);
  });

  it('migrates old full-object storage, keeping preferences and resetting tuning', () => {
    store.set('old', JSON.stringify({ ...DEFAULT_SETTINGS, model: 'lite', beta: 3, environment: 'indoor', hand: 'left' }));
    const settings = loadSettings('new', 'old');
    expect(settings.environment).toBe('indoor');
    expect(settings.hand).toBe('left');
    expect(settings.model).toBe(DEFAULT_SETTINGS.model);
    expect(settings.beta).toBe(DEFAULT_SETTINGS.beta);
    expect(JSON.parse(store.get('new')!)).toEqual({ environment: 'indoor', hand: 'left' });
  });
});
