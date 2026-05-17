import { Game } from './Game';

const container = document.getElementById('canvas-container')!;
const overlay   = document.getElementById('overlay')!;
const startBtn  = document.getElementById('start-btn')!;
const hud       = document.getElementById('hud')!;

let game: Game | null = null;

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

// Click on canvas re-acquires pointer lock if lost
container.addEventListener('click', () => {
  if (game && !document.pointerLockElement) {
    document.body.requestPointerLock();
  }
});
