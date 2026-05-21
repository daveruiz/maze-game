import { Game } from './Game';
import { inputMode } from './InputMode';
import { AudioManager } from './AudioManager';

const container = document.getElementById('canvas-container')!;
const overlay   = document.getElementById('overlay')!;
const startBtn  = document.getElementById('start-btn')!;
const hud       = document.getElementById('hud')!;
const blackout  = document.getElementById('blackout')!;

let game: Game | null = null;

// ── Preload all assets immediately (no user gesture needed for fetch/XHR) ──
const PRELOAD_TEXTURES = [
  'item-key.png', 'item-map.png', 'item-compass.png',
  'enemy-front.png', 'enemy-back.png', 'enemy-side.png',
  'basement-wall.png', 'basement-floor.png', 'basement-ceiling.png',
  'home-wall.png', 'home-floor.png', 'home-ceiling.png',
  'village-wall.png', 'vilage-floor.png',
];

const preloadPromise = Promise.all([
  AudioManager.preload(),
  ...PRELOAD_TEXTURES.map(url => new Promise<void>(resolve => {
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
  })),
]).then(() => {});

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
  // Snap blackout to fully opaque behind the overlay (no transition)
  blackout.style.transition = 'none';
  blackout.style.opacity = '1';
  // Fade the overlay out (0.5s via CSS transition)
  overlay.classList.remove('ready');

  setTimeout(() => {
    // Screen is black — wait for preload then start game (audio begins)
    overlay.style.display = 'none';
    hud.style.display = 'block';

    preloadPromise.then(() => {
      if (game) {
        game.restart();
      } else {
        game = new Game(container);
        game.start();
      }

      if (!inputMode.isTouch) document.body.requestPointerLock();

      // After 1s in black, fade the scene in over 1.5s (audio was already playing)
      setTimeout(() => {
        blackout.style.transition = 'opacity 1.5s ease-in';
        blackout.style.opacity = '0';
      }, 1000);
    });
  }, 500);
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
