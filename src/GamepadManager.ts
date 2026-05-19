import { Player } from './Player';

// Standard gamepad mapping indices
const AXIS_LX = 0;
const AXIS_LY = 1;
const AXIS_RX = 2;
const AXIS_RY = 3;

const BTN_A     = 0;   // Jump (Cross / A)
const BTN_X     = 2;   // Flashlight (Square / X)
const BTN_L3    = 10;  // Left stick press — sprint toggle

const DEAD_ZONE       = 0.15;
const LOOK_SENSITIVITY = 0.04;  // radians per frame at full tilt

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

    const gamepads = navigator.getGamepads?.() ?? [];

    // Accumulate input from all connected gamepads
    let lx = 0, ly = 0, rx = 0, ry = 0;
    let l3 = false, a = false, x = false;
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
      x  = x  || (gp.buttons[BTN_X]?.pressed ?? false);
    }

    if (!anyConnected) {
      // No gamepad — release ownership if we had it
      if (this.active) this.deactivate();
      return false;
    }

    // Check if there's any real input from the gamepad
    const hasInput = Math.abs(lx) > 0 || Math.abs(ly) > 0
                  || Math.abs(rx) > 0 || Math.abs(ry) > 0
                  || l3 || a || x;

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

    // ── Right stick → look ─────────────────────────────────────────────
    if (Math.abs(rx) > 0.01 || Math.abs(ry) > 0.01) {
      this.player.applyLookDelta(rx * LOOK_SENSITIVITY, ry * LOOK_SENSITIVITY);
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
      for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ShiftLeft']) {
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
