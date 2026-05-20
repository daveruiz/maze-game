import { Game } from './Game';
import { inputMode } from './InputMode';

const container = document.getElementById('canvas-container')!;
const overlay   = document.getElementById('overlay')!;
const startBtn  = document.getElementById('start-btn')!;
const hud       = document.getElementById('hud')!;

let game: Game | null = null;

// Install input-mode detection early so first touch/mouse is caught
inputMode.install();

// React to input-mode switches
inputMode.onChange((mode) => {
  const controlsList = overlay.querySelector('.controls-list') as HTMLElement;
  if (controlsList) controlsList.style.display = mode === 'touch' ? 'none' : '';

  // Release pointer lock when switching to touch
  if (mode === 'touch' && document.pointerLockElement) {
    document.exitPointerLock();
  }
  // Deactivate gamepad when switching to touch (same as keyboard reclaim)
  if (mode === 'touch' && game) {
    game.deactivateGamepad();
  }
});

startBtn.addEventListener('click', () => {
  overlay.style.display = 'none';
  hud.style.display = 'block';

  if (game) {
    game.restart();
  } else {
    game = new Game(container);
    game.start();
  }

  // Lock pointer immediately on start/restart (mouse mode only)
  if (!inputMode.isTouch) document.body.requestPointerLock();
});

// Mouse mode: click on canvas re-acquires pointer lock (but not on UI elements)
container.addEventListener('click', (e) => {
  if (game && !inputMode.isTouch && !document.pointerLockElement) {
    // Don't re-lock if overlay is visible (retry/start screen) or clicking UI
    if (overlay.style.display !== 'none') return;
    const target = e.target as HTMLElement;
    if (target.closest('#debug-menu') || target.closest('#hud') || target.closest('.mobile-btn')) return;
    document.body.requestPointerLock();
  }
});

// Gamepad: poll for A or Start button press to click start/restart when overlay is visible
let gpPrevConfirm = false;
function pollGamepadForMenu() {
  requestAnimationFrame(pollGamepadForMenu);
  // Overlay is visible when display is '' (initial) or 'flex' (retry); 'none' = in-game
  if (overlay.style.display === 'none') { gpPrevConfirm = false; return; }

  const gamepads = navigator.getGamepads?.() ?? [];
  let confirm = false;
  for (const gp of gamepads) {
    if (!gp?.connected) continue;
    // A button (index 0) or Start/Options button (index 9)
    if (gp.buttons[0]?.pressed || gp.buttons[9]?.pressed) { confirm = true; break; }
  }
  if (confirm && !gpPrevConfirm) startBtn.click();
  gpPrevConfirm = confirm;
}
pollGamepadForMenu();
