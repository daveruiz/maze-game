import { Game } from './Game';
import { isMobileDevice } from './MobileControls';

const container = document.getElementById('canvas-container')!;
const overlay   = document.getElementById('overlay')!;
const startBtn  = document.getElementById('start-btn')!;
const hud       = document.getElementById('hud')!;

let game: Game | null = null;
const mobile = isMobileDevice();

// On mobile, hide desktop-only controls text and update start flow
if (mobile) {
  const controlsList = overlay.querySelector('.controls-list') as HTMLElement;
  if (controlsList) controlsList.style.display = 'none';
}

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

// Desktop: click on canvas re-acquires pointer lock
if (!mobile) {
  container.addEventListener('click', () => {
    if (game && !document.pointerLockElement) {
      document.body.requestPointerLock();
    }
  });
}
