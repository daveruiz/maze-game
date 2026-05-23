import { Game } from './Game';
import { inputMode } from './InputMode';
import { AudioManager } from './AudioManager';
import { initOptionsMenu } from './OptionsMenu';

initOptionsMenu();

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

  gain.gain.linearRampToValueAtTime(0.10, menuCtx.currentTime + 4.0);
}

function stopMenuDrone() {
  if (!menuDroneGain || !menuCtx) return;
  const now = menuCtx.currentTime;
  menuDroneGain.gain.setValueAtTime(menuDroneGain.gain.value, now);
  menuDroneGain.gain.linearRampToValueAtTime(0, now + 0.5);
  setTimeout(() => { menuCtx?.close(); menuCtx = null; menuDroneGain = null; }, 600);
}

document.addEventListener('pointerdown', startMenuDrone, { once: true });

// ── Input mode — install early so first event is caught ─────────────────
inputMode.install();

// React to input mode switches
inputMode.onChange((mode) => {
  const kbEl = document.getElementById('kb-controls');
  const gpEl = document.getElementById('gp-controls');
  if (kbEl) kbEl.style.display = (mode === 'gamepad' || mode === 'touch') ? 'none' : '';
  if (gpEl) gpEl.style.display = mode === 'gamepad' ? '' : 'none';

  if (mode !== 'keyboard' && document.pointerLockElement) {
    document.exitPointerLock();
  }
  // GamepadManager clears its own keys via its inputMode.onChange subscription.
  // MobileControls shows/hides itself via its inputMode.onChange subscription.
});

startBtn.addEventListener('click', () => {
  stopMenuDrone();

  blackout.style.transition = 'none';
  blackout.style.opacity = '1';
  overlay.classList.remove('ready');

  setTimeout(() => {
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

      loadingScreen.style.opacity = '0';
      setTimeout(() => { loadingScreen.style.display = 'none'; }, 400);

      if (inputMode.isKeyboard) document.body.requestPointerLock();

      setTimeout(() => {
        blackout.style.transition = 'opacity 1.5s ease-in';
        blackout.style.opacity = '0';
      }, 1000);
    });
  }, 500);
});

// Mouse mode: canvas click re-acquires pointer lock
container.addEventListener('click', (e) => {
  if (game && inputMode.isKeyboard && !document.pointerLockElement) {
    if (overlay.style.display !== 'none') return;
    const target = e.target as HTMLElement;
    if (target.closest('#debug-menu') || target.closest('#hud') || target.closest('.mobile-btn')) return;
    document.body.requestPointerLock();
  }
});

// Pause/resume on fullscreen change (touch/mobile devices)
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

// ── Gamepad menu navigation ──────────────────────────────────────────────

// Button indices (standard gamepad mapping)
const GP_A     = 0;
const GP_B     = 1;
const GP_START = 9;
const GP_UP    = 12;
const GP_DOWN  = 13;
const GP_LEFT  = 14;
const GP_RIGHT = 15;

// Previous button state for edge detection
const gpPrev = { a: false, b: false, start: false };

// Navigation state — options menu
let gpNavCooldown = 0;
let gpMenuFocusIdx = -1;
let gpMenuItems: HTMLElement[] = [];

// Navigation state — overlay (home / death screen)
const gpOverlayBtns = () => [
  document.getElementById('start-btn'),
  document.getElementById('options-btn'),
].filter(Boolean) as HTMLElement[];
let gpOverlayFocusIdx = -1;

function gpGetMenuItems(): HTMLElement[] {
  const menu = document.getElementById('options-menu');
  if (!menu || menu.style.display !== 'block') return [];
  const items: HTMLElement[] = [];
  menu.querySelectorAll<HTMLElement>(
    'button, input[type="checkbox"], input[type="range"]'
  ).forEach(el => {
    if (el.closest('label.disabled')) return;
    if (el.getBoundingClientRect().height === 0) return; // hidden
    items.push(el);
  });
  return items;
}

function gpFocusTarget(el: HTMLElement): HTMLElement {
  return (el.closest('label') as HTMLElement) ?? el;
}

function gpSetMenuFocus(items: HTMLElement[], idx: number) {
  // Remove focus from previous element
  if (gpMenuFocusIdx >= 0 && gpMenuFocusIdx < gpMenuItems.length) {
    gpFocusTarget(gpMenuItems[gpMenuFocusIdx]).classList.remove('gp-focus');
  }
  gpMenuFocusIdx = Math.max(0, Math.min(items.length - 1, idx));
  gpMenuItems = items;
  if (gpMenuFocusIdx >= 0 && gpMenuFocusIdx < items.length) {
    const target = gpFocusTarget(items[gpMenuFocusIdx]);
    target.classList.add('gp-focus');
    target.scrollIntoView?.({ block: 'nearest' });
  }
}

function gpClearMenuFocus() {
  if (gpMenuFocusIdx >= 0 && gpMenuFocusIdx < gpMenuItems.length) {
    gpFocusTarget(gpMenuItems[gpMenuFocusIdx]).classList.remove('gp-focus');
  }
  gpMenuFocusIdx = -1;
  gpMenuItems = [];
}

function pollGamepadForMenu() {
  requestAnimationFrame(pollGamepadForMenu);

  // Read all connected gamepads
  const gamepads = navigator.getGamepads?.() ?? [];
  let navUp = false, navDown = false, navLeft = false, navRight = false;
  let btnA = false, btnB = false, btnStart = false;

  for (const gp of gamepads) {
    if (!gp?.connected) continue;
    navUp    = navUp    || (gp.buttons[GP_UP]?.pressed    ?? false);
    navDown  = navDown  || (gp.buttons[GP_DOWN]?.pressed  ?? false);
    navLeft  = navLeft  || (gp.buttons[GP_LEFT]?.pressed  ?? false);
    navRight = navRight || (gp.buttons[GP_RIGHT]?.pressed ?? false);
    btnA     = btnA     || (gp.buttons[GP_A]?.pressed     ?? false);
    btnB     = btnB     || (gp.buttons[GP_B]?.pressed     ?? false);
    btnStart = btnStart || (gp.buttons[GP_START]?.pressed ?? false);
    // Left stick supplements D-pad for navigation
    const ly = gp.axes[1] ?? 0;
    const lx = gp.axes[0] ?? 0;
    if (ly < -0.5) navUp    = true;
    if (ly >  0.5) navDown  = true;
    if (lx < -0.5) navLeft  = true;
    if (lx >  0.5) navRight = true;
  }

  // ── Overlay (home / death screen) ──────────────────────────────────
  if (overlay.style.display !== 'none') {
    const items = gpOverlayBtns();

    // Auto-focus the start button when overlay is visible
    if (gpOverlayFocusIdx < 0 && items.length > 0) {
      gpOverlayFocusIdx = 0;
      items[0].classList.add('gp-focus');
    }

    if (gpNavCooldown > 0) gpNavCooldown--;

    // Left/right navigates between the two buttons
    const horizDir = navRight ? 1 : (navLeft ? -1 : 0);
    if (horizDir !== 0 && gpNavCooldown === 0) {
      items[gpOverlayFocusIdx]?.classList.remove('gp-focus');
      gpOverlayFocusIdx = Math.max(0, Math.min(items.length - 1, gpOverlayFocusIdx + horizDir));
      items[gpOverlayFocusIdx]?.classList.add('gp-focus');
      gpNavCooldown = 12;
    }

    // A confirms focused button; Start always starts
    if (btnA && !gpPrev.a) {
      items[gpOverlayFocusIdx]?.click();
    } else if (btnStart && !gpPrev.start) {
      startBtn.click();
    }

    gpPrev.a = btnA; gpPrev.b = btnB; gpPrev.start = btnStart;
    if (gpMenuFocusIdx >= 0) gpClearMenuFocus();
    return;
  }

  // Clear overlay focus when overlay is hidden
  if (gpOverlayFocusIdx >= 0) {
    gpOverlayBtns()[gpOverlayFocusIdx]?.classList.remove('gp-focus');
    gpOverlayFocusIdx = -1;
  }

  const menuOpen = (window as any).optionsMenu?.isOpen?.() ?? false;

  // ── Options menu navigation ─────────────────────────────────────────
  if (menuOpen) {
    const items = gpGetMenuItems();

    // Initialise focus when menu first opens
    if (gpMenuFocusIdx < 0 && items.length > 0) {
      gpSetMenuFocus(items, 0);
    }

    if (gpNavCooldown > 0) gpNavCooldown--;

    // Vertical navigation (D-pad / left stick up-down)
    const vertDir = navDown ? 1 : (navUp ? -1 : 0);
    if (vertDir !== 0 && gpNavCooldown === 0) {
      gpSetMenuFocus(items, gpMenuFocusIdx + vertDir);
      gpNavCooldown = 12; // ~200 ms repeat at 60 fps
    }

    // Horizontal navigation adjusts range sliders
    const horizDir = navRight ? 1 : (navLeft ? -1 : 0);
    const focused  = items[gpMenuFocusIdx];
    if (horizDir !== 0 && gpNavCooldown === 0 &&
        focused instanceof HTMLInputElement && focused.type === 'range') {
      const min  = Number(focused.min);
      const max  = Number(focused.max);
      const step = Math.max(Number(focused.step) || 1, (max - min) / 20);
      const newV = Math.max(min, Math.min(max, Number(focused.value) + horizDir * step));
      focused.value = String(Math.round(newV));
      focused.dispatchEvent(new Event('input', { bubbles: true }));
      gpNavCooldown = 3;
    }

    // A = confirm / toggle
    if (btnA && !gpPrev.a) {
      if (focused instanceof HTMLInputElement && focused.type === 'checkbox') {
        focused.checked = !focused.checked;
        focused.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (focused) {
        focused.click();
      }
    }

    // B or Start = close menu
    if ((btnB && !gpPrev.b) || (btnStart && !gpPrev.start)) {
      (window as any).optionsMenu?.close();
    }
  } else {
    // In-game, no menu: Start toggles options menu
    if (btnStart && !gpPrev.start) (window as any).optionsMenu?.toggle();
    // Clear stale focus when menu is not open
    if (gpMenuFocusIdx >= 0) gpClearMenuFocus();
  }

  gpPrev.a = btnA; gpPrev.b = btnB; gpPrev.start = btnStart;
}

pollGamepadForMenu();
