export interface SettingsData {
  pixelScale:      number;   // renderer divisor: 1=native, 2=half, 4=quarter, 8=eighth
  shadows:         boolean;
  posterize:       boolean;
  vibration:       boolean;
  micInput:        boolean;
  micReverbVolume: number;   // 0=off, 0..1 reverb feedback level
  mobileScale:      number;   // 1.0 = default button size (multiplier)
  mobileBtnJumpX:   number;   // % from left (0-100)
  mobileBtnJumpY:   number;   // % from top  (0-100)
  mobileBtnCrouchX: number;
  mobileBtnCrouchY: number;
  mobileBtnFlashX:  number;
  mobileBtnFlashY:  number;
}

const DEFAULTS: SettingsData = {
  pixelScale:      4,
  shadows:         true,
  posterize:       true,
  vibration:       false,
  micInput:        false,
  micReverbVolume: 0.8,
  mobileScale:      1.0,
  mobileBtnJumpX:   91,  mobileBtnJumpY:   33,
  mobileBtnCrouchX: 91,  mobileBtnCrouchY: 53,
  mobileBtnFlashX:  83,  mobileBtnFlashY:  53,
};

const KEY = 'dads-nightmare-settings';

class Settings {
  private _data: SettingsData;
  private _listeners = new Set<(data: SettingsData) => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      this._data = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch {
      this._data = { ...DEFAULTS };
    }
  }

  get<K extends keyof SettingsData>(key: K): SettingsData[K] {
    return this._data[key];
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]) {
    this._data[key] = value;
    try { localStorage.setItem(KEY, JSON.stringify(this._data)); } catch {}
    this._listeners.forEach(fn => fn({ ...this._data }));
  }

  onChange(fn: (data: SettingsData) => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}

export const settings = new Settings();
