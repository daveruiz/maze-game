import { settings } from './Settings';

// ── Public API for open/close ─────────────────────────────────────────────
// Exposed on window so inline scripts and external code can use it.
export const optionsMenu = {
  open() {
    document.getElementById('options-menu')!.style.display = 'block';
    document.dispatchEvent(new CustomEvent('optionsmenu', { detail: { open: true } }));
  },
  close() {
    document.getElementById('options-menu')!.style.display = 'none';
    document.dispatchEvent(new CustomEvent('optionsmenu', { detail: { open: false } }));
  },
  toggle() {
    const el = document.getElementById('options-menu')!;
    if (el.style.display === 'block') this.close(); else this.open();
  },
  isOpen() {
    return document.getElementById('options-menu')?.style.display === 'block';
  },
};
(window as any).optionsMenu = optionsMenu;

export function initOptionsMenu() {
  // Resolution buttons — initialize active state from saved setting
  const savedScale = settings.get('pixelScale');
  document.querySelectorAll<HTMLButtonElement>('button[data-pixelscale]').forEach(btn => {
    const scale = parseInt(btn.dataset.pixelscale ?? '1', 10);
    btn.classList.toggle('active', scale === savedScale);
    btn.addEventListener('click', () => {
      settings.set('pixelScale', scale);
      document.querySelectorAll<HTMLButtonElement>('button[data-pixelscale]').forEach(b =>
        b.classList.toggle('active', b === btn));
    });
  });

  // Checkboxes — initialize from saved settings
  const vibCb          = document.getElementById('vibration-cb')    as HTMLInputElement;
  const micCb          = document.getElementById('mic-cb')          as HTMLInputElement;
  const micReverbLabel = document.getElementById('mic-reverb-label') as HTMLElement;
  const micReverbVol   = document.getElementById('mic-reverb-vol')  as HTMLInputElement;
  const shadowsCb      = document.getElementById('opt-shadows')     as HTMLInputElement;
  const posterizeCb    = document.getElementById('opt-posterize')   as HTMLInputElement;

  vibCb.checked       = settings.get('vibration');
  micCb.checked       = settings.get('micInput');
  micReverbVol.value  = String(Math.round(settings.get('micReverbVolume') * 100));
  shadowsCb.checked   = settings.get('shadows');
  posterizeCb.checked = settings.get('posterize');

  // Reverb slider depends on mic being enabled
  function syncMicReverb() {
    if (micCb.checked) {
      micReverbLabel.classList.remove('disabled');
    } else {
      micReverbLabel.classList.add('disabled');
    }
  }
  syncMicReverb();

  // Show vibration row when device supports haptics
  const vibLabel = document.getElementById('vibration-label') as HTMLElement;
  if ('vibrate' in navigator) vibLabel.style.display = 'flex';
  window.addEventListener('gamepadconnected', (e) => {
    if ((e as GamepadEvent).gamepad?.vibrationActuator) vibLabel.style.display = 'flex';
  });

  // Wire change handlers — just persist to settings; Game applies live via onChange
  vibCb.addEventListener('change',      () => settings.set('vibration', vibCb.checked));
  micCb.addEventListener('change',      () => { settings.set('micInput', micCb.checked); syncMicReverb(); });
  micReverbVol.addEventListener('input', () => settings.set('micReverbVolume', parseInt(micReverbVol.value) / 100));
  shadowsCb.addEventListener('change',   () => settings.set('shadows',   shadowsCb.checked));
  posterizeCb.addEventListener('change', () => settings.set('posterize', posterizeCb.checked));
}
