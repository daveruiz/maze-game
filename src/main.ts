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
});

// Mouse mode: click on canvas re-acquires pointer lock (but not on UI elements)
container.addEventListener('click', (e) => {
  if (game && !inputMode.isTouch && !document.pointerLockElement) {
    const target = e.target as HTMLElement;
    if (target.closest('#debug-menu') || target.closest('#hud') || target.closest('.mobile-btn')) return;
    document.body.requestPointerLock();
  }
});

// Gamepad: poll for A button press to click start/restart when overlay is visible
let gpPrevA = false;
function pollGamepadForMenu() {
  requestAnimationFrame(pollGamepadForMenu);
  if (overlay.style.display === 'none') { gpPrevA = false; return; }

  const gamepads = navigator.getGamepads?.() ?? [];
  let a = false;
  for (const gp of gamepads) {
    if (gp?.connected && gp.buttons[0]?.pressed) { a = true; break; }
  }
  if (a && !gpPrevA) startBtn.click();
  gpPrevA = a;
}
pollGamepadForMenu();
