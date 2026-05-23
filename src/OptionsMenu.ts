import { settings } from './Settings';

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
  const micReverbCb    = document.getElementById('mic-reverb-cb')   as HTMLInputElement;
  const shadowsCb      = document.getElementById('opt-shadows')     as HTMLInputElement;
  const posterizeCb    = document.getElementById('opt-posterize')   as HTMLInputElement;

  vibCb.checked       = settings.get('vibration');
  micCb.checked       = settings.get('micInput');
  micReverbCb.checked = settings.get('micReverb');
  shadowsCb.checked   = settings.get('shadows');
  posterizeCb.checked = settings.get('posterize');

  // Mic reverb depends on mic being enabled
  function syncMicReverb() {
    if (micCb.checked) {
      micReverbLabel.classList.remove('disabled');
    } else {
      micReverbLabel.classList.add('disabled');
      micReverbCb.checked = false;
      settings.set('micReverb', false);
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
  vibCb.addEventListener('change',       () => settings.set('vibration', vibCb.checked));
  micCb.addEventListener('change',       () => { settings.set('micInput', micCb.checked); syncMicReverb(); });
  micReverbCb.addEventListener('change', () => settings.set('micReverb', micReverbCb.checked));
  shadowsCb.addEventListener('change',   () => settings.set('shadows',   shadowsCb.checked));
  posterizeCb.addEventListener('change', () => settings.set('posterize', posterizeCb.checked));
}
