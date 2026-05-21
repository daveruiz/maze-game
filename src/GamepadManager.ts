import { Player } from './Player';
import { inputMode } from './InputMode';

// Standard gamepad mapping indices
const AXIS_LX = 0;
const AXIS_LY = 1;
const AXIS_RX = 2;
const AXIS_RY = 3;

const BTN_A     = 0;   // Jump (Cross / A)
const BTN_B     = 1;   // Crouch (Circle / B) — held
const BTN_X     = 2;   // Flashlight (Square / X)
const BTN_L3    = 10;  // Left stick press — sprint toggle

const DEAD_ZONE        = 0.20;
const LOOK_SENSITIVITY = 0.04;  // radians per frame at full tilt
const MAX_LOOK_DELTA   = 0.06;  // clamp to prevent random spikes

export class GamepadManager {
  private player: Player | null = null;
  private toggleFlashlight: () => void;

  // Sprint latch: L3 turns sprint on, stops when player releases stick
  private sprintLatched = false;
  private prevL3 = false;
  private prevA  = false;
  private prevX  = false;

  // Track whether gamepad is the active input source
  private active = false;

  constructor(callbacks: { toggleFlashlight: () => void }) {
    this.toggleFlashlight = callbacks.toggleFlashlight;
  }

  setPlayer(player: Player) { this.player = player; }

  /** Call every frame — reads ALL connected gamepads and feeds the player. */
  update(): boolean {
    if (!this.player) return false;
    if (inputMode.isTouch) return false; // touch controls take priority

    const gamepads = navigator.getGamepads?.() ?? [];

    // Accumulate input from all connected gamepads
    let lx = 0, ly = 0, rx = 0, ry = 0;
    let l3 = false, a = false, b = false, x = false;
    let anyConnected = false;

    for (const gp of gamepads) {
      if (!gp || !gp.connected) continue;
      anyConnected = true;

      const glx = this.applyDeadZone(gp.axes[AXIS_LX] ?? 0);
      const gly = this.applyDeadZone(gp.axes[AXIS_LY] ?? 0);
      const grx = this.applyDeadZone(gp.axes[AXIS_RX] ?? 0);
      const gry = this.applyDeadZone(gp.axes[AXIS_RY] ?? 0);

      // Use whichever gamepad has the strongest input on each axis
      if (Math.abs(glx) > Math.abs(lx)) lx = glx;
      if (Math.abs(gly) > Math.abs(ly)) ly = gly;
      if (Math.abs(grx) > Math.abs(rx)) rx = grx;
      if (Math.abs(gry) > Math.abs(ry)) ry = gry;

      // OR buttons across all gamepads
      l3 = l3 || (gp.buttons[BTN_L3]?.pressed ?? false);
      a  = a  || (gp.buttons[BTN_A]?.pressed ?? false);
      b  = b  || (gp.buttons[BTN_B]?.pressed ?? false);
      x  = x  || (gp.buttons[BTN_X]?.pressed ?? false);
    }

    if (!anyConnected) {
      // No gamepad — release ownership if we had it
      if (this.active) this.deactivate();
      return false;
    }

    // Require deliberate input to activate (stick > 0.4 or button press)
    // Prevents phantom/drifting gamepads from hijacking mouse control
    const ACTIVATE_THRESHOLD = 0.4;
    const hasInput = Math.abs(lx) > ACTIVATE_THRESHOLD || Math.abs(ly) > ACTIVATE_THRESHOLD
                  || Math.abs(rx) > ACTIVATE_THRESHOLD || Math.abs(ry) > ACTIVATE_THRESHOLD
                  || l3 || a || b || x;

    // Activate on first real input, deactivate when keyboard takes over
    // (keyboard deactivation is handled by the keydown listener below)
    if (hasInput && !this.active) {
      this.active = true;
    }

    if (!this.active) {
      // Gamepad connected but not active — don't override keyboard
      this.prevL3 = l3;
      this.prevA = a;
      this.prevX = x;
      return false;
    }

    // ── Left stick → movement ──────────────────────────────────────────
    this.player.setKey('KeyW', ly < -0.35);
    this.player.setKey('KeyS', ly >  0.35);
    this.player.setKey('KeyA', lx < -0.35);
    this.player.setKey('KeyD', lx >  0.35);

    const moving = Math.abs(lx) > 0.01 || Math.abs(ly) > 0.01;

    // ── L3 sprint latch ────────────────────────────────────────────────
    if (l3 && !this.prevL3) {
      this.sprintLatched = !this.sprintLatched;
    }
    this.prevL3 = l3;

    if (this.sprintLatched && !moving) {
      this.sprintLatched = false;
    }

    this.player.setKey('ShiftLeft', this.sprintLatched && moving);

    // ── B button → crouch (held) ───────────────────────────────────────
    this.player.setKey('KeyC', b);

    // ── Right stick → look ─────────────────────────────────────────────
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

  /** Release gamepad control — clears virtual keys so keyboard can take over */
  deactivate() {
    this.active = false;
    this.sprintLatched = false;
    if (this.player) {
      for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft', 'KeyC']) {
        this.player.setKey(k, false);
      }
    }
  }

  /** Call from outside when keyboard input is detected */
  onKeyboardInput() {
    if (this.active) this.deactivate();
  }

  private applyDeadZone(value: number): number {
    if (Math.abs(value) < DEAD_ZONE) return 0;
    const sign = value > 0 ? 1 : -1;
    return sign * (Math.abs(value) - DEAD_ZONE) / (1 - DEAD_ZONE);
  }
}
