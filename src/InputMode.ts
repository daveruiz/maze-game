/**
 * Dynamic input-mode detection.
 *
 * Instead of sniffing user-agent once at boot, we listen for actual hardware
 * events and switch between "mouse" and "touch" modes on the fly.
 *
 * `isMobileDevice()` is kept only for the fullscreen-CTA heuristic.
 */

export type InputModeName = 'mouse' | 'touch';

type Listener = (mode: InputModeName) => void;

class InputModeManager {
  private _mode: InputModeName = 'mouse';
  private _listeners: Listener[] = [];
  private _installed = false;

  get mode() { return this._mode; }
  get isTouch() { return this._mode === 'touch'; }

  /** Install once — harmless to call multiple times. */
  install() {
    if (this._installed) return;
    this._installed = true;

    // Touch → switch to touch mode
    window.addEventListener('touchstart', () => this.set('touch'), { capture: true, passive: true });

    // Mouse movement with non-zero movementX/Y (not a simulated click from touch)
    window.addEventListener('mousemove', (e: MouseEvent) => {
      if (e.movementX !== 0 || e.movementY !== 0) this.set('mouse');
    }, { capture: true, passive: true });
  }

  onChange(fn: Listener) { this._listeners.push(fn); }

  private set(mode: InputModeName) {
    if (mode === this._mode) return;
    this._mode = mode;
    for (const fn of this._listeners) fn(mode);
  }
}

/** Singleton — import and use directly. */
export const inputMode = new InputModeManager();

/** UA sniff — only used for fullscreen CTA on actual mobile hardware. */
export function isMobileDevice(): boolean {
  return 'ontouchstart' in window && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}
