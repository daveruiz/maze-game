import { Game } from './Game';
import { inputMode } from './InputMode';
import { AudioManager } from './AudioManager';

const container     = document.getElementById('canvas-container')!;
const overlay       = document.getElementById('overlay')!;
const startBtn      = document.getElementById('start-btn')!;
const hud           = document.getElementById('hud')!;
const blackout      = document.getElementById('blackout')!;
const loadingScreen = document.getElementById('loading-screen')!;

let game: Game | null = null;

// ── Preload all assets immediately (no user gesture needed for fetch/XHR) ──
const PRELOAD_TEXTURES = [
  'item-key.png', 'item-map.png', 'item-compass.png',
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

// ── Menu atmosphere drone ────────────────────────────────────────────────
// Identical waveform to the in-game proximity drone; played at a low gain
// to simulate the enemy being far away while the title screen is visible.
let menuCtx: AudioContext | null = null;
let menuDroneGain: GainNode | null = null;

function startMenuDrone() {
  if (menuCtx) return;
  try { menuCtx = new AudioContext(); } catch { return; }

  const sr  = menuCtx.sampleRate;
  const dur = 8.0;
  const buf = menuCtx.createBuffer(1, Math.floor(sr * dur), sr);
  const d   = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const t      = i / sr;
    const sub    = Math.sin(2 * Math.PI * 32 * t) * 0.4;
    const rumble = Math.sin(2 * Math.PI * 48 * t + Math.sin(t * 2.0) * 3.0) * 0.3;
    const grind  = Math.sin(2 * Math.PI * 73 * t) * 0.15;
    const noise  = (Math.random() - 0.5) * 0.08;
    const lfo    = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.25 * t);
    d[i] = (sub + rumble + grind + noise) * lfo;
  }

  const src  = menuCtx.createBufferSource();
  src.buffer = buf;
  src.loop   = true;

  const gain = menuCtx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(menuCtx.destination);
  src.start();
  menuDroneGain = gain;

  // Fade in slowly — simulates enemy lurking far away
  gain.gain.linearRampToValueAtTime(0.10, menuCtx.currentTime + 4.0);
}

function stopMenuDrone() {
  if (!menuDroneGain || !menuCtx) return;
  const now = menuCtx.currentTime;
  menuDroneGain.gain.setValueAtTime(menuDroneGain.gain.value, now);
  menuDroneGain.gain.linearRampToValueAtTime(0, now + 0.5);
  setTimeout(() => { menuCtx?.close(); menuCtx = null; menuDroneGain = null; }, 600);
}

// Start the drone on first pointer interaction with the page
document.addEventListener('pointerdown', startMenuDrone, { once: true });

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
  stopMenuDrone();

  // Snap blackout to fully opaque behind the overlay (no transition)
  blackout.style.transition = 'none';
  blackout.style.opacity = '1';
  // Fade the overlay out (0.5s via CSS transition)
  overlay.classList.remove('ready');

  setTimeout(() => {
    // Screen is black — show loading indicator then start game
    overlay.style.display = 'none';
    hud.style.display = 'block';
    loadingScreen.style.display = 'block';
    requestAnimationFrame(() => { loadingScreen.style.opacity = '1'; });

    preloadPromise.then(() => {
      if (game) {
        game.restart();
      } else {
        game = new Game(container);
        game.start();
      }

      // Hide loading message before the fade-in begins
      loadingScreen.style.opacity = '0';
      setTimeout(() => { loadingScreen.style.display = 'none'; }, 400);

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

// Pause game when fullscreen exits on touch/mobile devices
const onFullscreenChange = () => {
  if (!game || !inputMode.isTouch) return;
  const isFS = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
  if (!isFS) {
    game.pauseGame();
  } else {
    game.resumeGame();
  }
};
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

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
