import { Player } from './Player';
import { inputMode } from './InputMode';
import { settings } from './Settings';

// Standard gamepad button / axis mapping (Xinput / PS layout)
const AXIS_LX = 0;
const AXIS_LY = 1;
const AXIS_RX = 2;
const AXIS_RY = 3;

const BTN_A  = 0;   // Jump  (Cross / A)
const BTN_B  = 1;   // Crouch (Circle / B) — held
const BTN_X  = 2;   // Flashlight (Square / X)
const BTN_L3 = 10;  // Left stick press — sprint latch

const DEAD_ZONE        = 0.20;
const LOOK_SENSITIVITY = 0.04;  // radians per frame at full tilt
const MAX_LOOK_DELTA   = 0.06;  // clamp against random spikes

export class GamepadManager {
  private player: Player | null = null;
  private toggleFlashlight: () => void;

  private sprintLatched = false;
  private crouchLatched = false;
  private prevL3 = false;
  private prevB  = false;
  private prevA  = false;
  private prevX  = false;

  constructor(callbacks: { toggleFlashlight: () => void }) {
    this.toggleFlashlight = callbacks.toggleFlashlight;

    // Clear all virtual keys whenever input mode leaves gamepad
    inputMode.onChange((mode) => {
      if (mode !== 'gamepad') this.clearKeys();
    });
  }

  setPlayer(player: Player) { this.player = player; }

  /** Call every frame from the game loop — only runs in gamepad mode. */
  update(): boolean {
    if (!this.player || !inputMode.isGamepad) return false;

    const gamepads = navigator.getGamepads?.() ?? [];

    let lx = 0, ly = 0, rx = 0, ry = 0;
    let l3 = false, a = false, b = false, x = false;
    let anyConnected = false;

    for (const gp of gamepads) {
      if (!gp?.connected) continue;
      anyConnected = true;

      const glx = this.applyDeadZone(gp.axes[AXIS_LX] ?? 0);
      const gly = this.applyDeadZone(gp.axes[AXIS_LY] ?? 0);
      const grx = this.applyDeadZone(gp.axes[AXIS_RX] ?? 0);
      const gry = this.applyDeadZone(gp.axes[AXIS_RY] ?? 0);

      if (Math.abs(glx) > Math.abs(lx)) lx = glx;
      if (Math.abs(gly) > Math.abs(ly)) ly = gly;
      if (Math.abs(grx) > Math.abs(rx)) rx = grx;
      if (Math.abs(gry) > Math.abs(ry)) ry = gry;

      l3 = l3 || (gp.buttons[BTN_L3]?.pressed ?? false);
      a  = a  || (gp.buttons[BTN_A]?.pressed  ?? false);
      b  = b  || (gp.buttons[BTN_B]?.pressed  ?? false);
      x  = x  || (gp.buttons[BTN_X]?.pressed  ?? false);
    }

    if (!anyConnected) return false;

    // ── Movement (left stick) ──────────────────────────────────────────
    this.player.setKey('KeyW', ly < -0.35);
    this.player.setKey('KeyS', ly >  0.35);
    this.player.setKey('KeyA', lx < -0.35);
    this.player.setKey('KeyD', lx >  0.35);

    const moving = Math.abs(lx) > 0.01 || Math.abs(ly) > 0.01;

    // ── Sprint latch (L3 toggles, auto-off when stick released) ───────
    if (l3 && !this.prevL3) this.sprintLatched = !this.sprintLatched;
    this.prevL3 = l3;
    if (this.sprintLatched && !moving) this.sprintLatched = false;
    this.player.setKey('ShiftLeft', this.sprintLatched && moving);

    // ── Crouch (B — toggle or hold depending on setting) ───────────────
    if (settings.get('toggleCrouch')) {
      // Edge-triggered: toggle Player's internal crouchToggled flag
      if (b && !this.prevB) this.player.triggerCrouchToggle();
      this.prevB = b;
    } else {
      this.prevB = b;
      this.player.setKey('KeyC', b);
    }

    // ── Look (right stick) ─────────────────────────────────────────────
    if (Math.abs(rx) > 0.01 || Math.abs(ry) > 0.01) {
      const dx = Math.max(-MAX_LOOK_DELTA, Math.min(MAX_LOOK_DELTA, rx * LOOK_SENSITIVITY));
      const dy = Math.max(-MAX_LOOK_DELTA, Math.min(MAX_LOOK_DELTA, ry * LOOK_SENSITIVITY));
      this.player.applyLookDelta(dx, dy);
    }

    // ── Buttons (edge-triggered) ───────────────────────────────────────
    if (a && !this.prevA) this.player.triggerJump();
    this.prevA = a;

    if (x && !this.prevX) this.toggleFlashlight();
    this.prevX = x;

    return true;
  }

  private clearKeys() {
    this.sprintLatched = false;
    this.crouchLatched = false;
    if (this.player) {
      for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft', 'KeyC']) {
        this.player.setKey(k, false);
      }
    }
  }

  /** Switch input mode to keyboard — kept for external callers. */
  deactivate() { inputMode.setMode('keyboard'); }

  /** No-op — InputMode handles mode switching via its own listeners. */
  onKeyboardInput() {}

  private applyDeadZone(value: number): number {
    if (Math.abs(value) < DEAD_ZONE) return 0;
    const sign = value > 0 ? 1 : -1;
    return sign * (Math.abs(value) - DEAD_ZONE) / (1 - DEAD_ZONE);
  }
}
