export type InputModeName = 'keyboard' | 'touch' | 'gamepad';

type Listener = (mode: InputModeName) => void;

// Thresholds for gamepad activation (high enough to ignore stick drift)
const GP_AXIS_THRESHOLD = 0.40;
const GP_BTN_THRESHOLD  = 0.50;

class InputModeManager {
  private _mode: InputModeName = 'keyboard';
  private _listeners: Listener[] = [];
  private _installed = false;

  get mode()       { return this._mode; }
  get isTouch()    { return this._mode === 'touch'; }
  get isGamepad()  { return this._mode === 'gamepad'; }
  get isKeyboard() { return this._mode === 'keyboard'; }

  /** Install global listeners once — safe to call multiple times. */
  install() {
    if (this._installed) return;
    this._installed = true;

    window.addEventListener('touchstart', () => this.setMode('touch'),
      { capture: true, passive: true });

    window.addEventListener('mousemove', (e: MouseEvent) => {
      if (e.movementX !== 0 || e.movementY !== 0) this.setMode('keyboard');
    }, { capture: true, passive: true });

    window.addEventListener('keydown', () => this.setMode('keyboard'),
      { capture: true, passive: true });

    // Gamepad: poll in a separate RAF loop so mode detection works even when
    // the game loop is paused (menu open, title screen, etc.).
    // Only checks while NOT in gamepad mode — keyboard/touch events handle leaving it.
    const pollGp = () => {
      if (this._mode !== 'gamepad') {
        for (const gp of navigator.getGamepads?.() ?? []) {
          if (!gp?.connected) continue;
          const axisInput = gp.axes.some(a => Math.abs(a) > GP_AXIS_THRESHOLD);
          const btnInput  = gp.buttons.some(b => b.value > GP_BTN_THRESHOLD);
          if (axisInput || btnInput) { this.setMode('gamepad'); break; }
        }
      }
      requestAnimationFrame(pollGp);
    };
    requestAnimationFrame(pollGp);
  }

  onChange(fn: Listener) { this._listeners.push(fn); }

  setMode(mode: InputModeName) {
    if (mode === this._mode) return;
    this._mode = mode;
    for (const fn of this._listeners) fn(mode);
  }
}

/** Singleton — import and use directly. */
export const inputMode = new InputModeManager();

/** UA sniff — only used for the fullscreen CTA on actual mobile hardware. */
export function isMobileDevice(): boolean {
  return 'ontouchstart' in window && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
}
