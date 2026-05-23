import { Player } from './Player';
import { inputMode, isMobileDevice } from './InputMode';
import { settings } from './Settings';
import type { SettingsData } from './Settings';

// Re-export for backward compat
export { isMobileDevice };

// ── Constants ──────────────────────────────────────────────────────────────
const JOYSTICK_SIZE      = 130;
const JOYSTICK_THUMB     = 54;
const DEAD_ZONE          = 12;      // px before movement registers
const SPRINT_THRESHOLD   = 0.80;    // joystick tilt % to auto-sprint
const LOOK_SENSITIVITY   = 0.01;
const BTN_SIZE           = 58;

// ── Mobile Controls ────────────────────────────────────────────────────────
export class MobileControls {
  private player: Player;
  private toggleFlashlight: () => void;
  private toggleOptions: () => void;

  // Root container
  private container!: HTMLDivElement;

  // Action buttons (saved for layout customization)
  private btnJump!:   HTMLButtonElement;
  private btnCrouch!: HTMLButtonElement;
  private btnFlash!:  HTMLButtonElement;
  private editCleanup: (() => void)[] = [];
  private editOverlay: HTMLDivElement | null = null;

  // Fullscreen CTA
  private ctaOverlay!: HTMLDivElement;

  // Joystick
  private joystickBase!: HTMLDivElement;
  private joystickThumb!: HTMLDivElement;
  private joystickTouchId: number | null = null;
  private joystickOriginX = 0;
  private joystickOriginY = 0;
  private joyVecX = 0;   // normalised -1..1
  private joyVecY = 0;

  // Look
  private lookTouchId: number | null = null;
  private lookPrevX = 0;
  private lookPrevY = 0;

  // Joystick zone ref for coordinate conversion
  private joystickZone!: HTMLDivElement;

  constructor(player: Player, callbacks: { toggleFlashlight: () => void; toggleOptions?: () => void }) {
    this.player = player;
    this.toggleFlashlight = callbacks.toggleFlashlight;
    this.toggleOptions = callbacks.toggleOptions ?? (() => (window as any).optionsMenu?.toggle());
  }

  /** Update player reference (needed after restart creates new Player) */
  setPlayer(player: Player) { this.player = player; }

  // ── Public API ──────────────────────────────────────────────────────────

  init() {
    this.buildCSS();
    this.buildCTA();
    this.buildControls();
    this.attachTouchListeners();
    this.attachFullscreenListeners();

    // React to input-mode switches
    inputMode.onChange((mode) => {
      if (mode === 'touch') {
        this.show();
      } else {
        this.hide();
      }
    });

    // Initial state based on current mode
    if (inputMode.isTouch) this.show(); else this.hide();
  }

  show() {
    this.container.style.display = 'block';
  }

  hide() {
    this.container.style.display = 'none';
    // Clear any held virtual keys
    this.resetState();
  }

  /** Call every frame before player.update() */
  update() {
    if (!inputMode.isTouch) return;

    const mag = Math.sqrt(this.joyVecX * this.joyVecX + this.joyVecY * this.joyVecY);

    // Movement keys from joystick angle
    const moving = mag > 0;

    const fwd   = moving && this.joyVecY < -0.35;
    const back  = moving && this.joyVecY >  0.35;
    const left  = moving && this.joyVecX < -0.35;
    const right = moving && this.joyVecX >  0.35;

    this.player.setKey('KeyW', fwd);
    this.player.setKey('KeyS', back);
    this.player.setKey('KeyA', left);
    this.player.setKey('KeyD', right);

    // Auto-sprint when joystick pushed to max
    this.player.setKey('ShiftLeft', mag >= SPRINT_THRESHOLD);
  }

  destroy() {
    this.container?.remove();
    this.ctaOverlay?.remove();
    this.resetState();
  }

  private resetState() {
    this.joyVecX = 0;
    this.joyVecY = 0;
    this.joystickTouchId = null;
    this.lookTouchId = null;
    for (const k of ['KeyW','KeyS','KeyA','KeyD','ShiftLeft','KeyC']) {
      this.player.setKey(k, false);
    }
  }

  // ── CSS ─────────────────────────────────────────────────────────────────

  private buildCSS() {
    const style = document.createElement('style');
    style.textContent = `
      /* Mobile controls — shown dynamically when touch input detected */
      #mobile-controls {
        position: fixed; top: 0; left: 0;
        width: 100%; height: 100%;
        pointer-events: none;
        z-index: 5;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        opacity: 0.5;
        display: none;
      }
      #mobile-controls * { touch-action: none; }

      /* Joystick */
      #joystick-zone {
        position: absolute; left: 0; bottom: 0;
        width: 45%; height: 55%;
        pointer-events: auto;
      }
      #joystick-base {
        position: absolute;
        width: ${JOYSTICK_SIZE}px; height: ${JOYSTICK_SIZE}px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.25);
        background: rgba(255,255,255,0.04);
        display: none;
        pointer-events: none;
      }
      #joystick-thumb {
        position: absolute;
        width: ${JOYSTICK_THUMB}px; height: ${JOYSTICK_THUMB}px;
        border-radius: 50%;
        background: rgba(255,255,255,0.18);
        border: 2px solid rgba(255,255,255,0.35);
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        transition: none;
      }

      /* Action buttons — positions applied by JS via applyLayout() */
      #mobile-buttons {
        position: absolute; top: 0; left: 0;
        width: 100%; height: 100%;
        pointer-events: none;
      }
      #mobile-buttons .mobile-btn {
        position: absolute;
        pointer-events: auto;
      }
      .mobile-btn {
        width: ${BTN_SIZE}px; height: ${BTN_SIZE}px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.35);
        background: transparent;
        color: rgba(255,255,255,0.6);
        font-family: "Barriecito", system-ui;
        font-size: 10px;
        font-weight: bold;
        letter-spacing: 1px;
        text-transform: uppercase;
        display: flex; align-items: center; justify-content: center;
        pointer-events: auto;
        -webkit-tap-highlight-color: transparent;
        touch-action: none;
      }
      .mobile-btn:active, .mobile-btn.active {
        border-color: rgba(255,255,255,0.7);
        background: rgba(255,255,255,0.12);
        color: rgba(255,255,255,0.9);
      }
      #btn-mobile-options {
        position: fixed;
        top: max(env(safe-area-inset-top, 0px) + 10px, 10px);
        right: max(env(safe-area-inset-right, 0px) + 10px, 10px);
        width: 44px; height: 44px;
        border-radius: 50%;
        border: 1.5px solid rgba(255,255,255,0.3);
        background: rgba(0,0,0,0.35);
        color: rgba(255,255,255,0.6);
        font-size: 20px;
        display: flex; align-items: center; justify-content: center;
        pointer-events: auto;
        -webkit-tap-highlight-color: transparent;
        touch-action: none;
        z-index: 6;
      }

      /* Look zone — full right side for camera control */
      #look-zone {
        position: absolute; right: 0; top: 0;
        width: 55%; height: 100%;
        pointer-events: auto;
      }

      /* Force landscape orientation */
      @media (orientation: portrait) {
        #mobile-rotate-notice {
          display: flex !important;
        }
        #mobile-controls { display: none !important; }
      }
      @media (orientation: landscape) {
        #mobile-rotate-notice { display: none !important; }
      }
      #mobile-rotate-notice {
        position: fixed; top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0,0,0,0.95);
        display: none;
        flex-direction: column;
        align-items: center; justify-content: center;
        z-index: 60;
        color: #fff;
        font-family: "Barriecito", system-ui;
        touch-action: none;
      }
      #mobile-rotate-notice .rotate-icon { font-size: 3rem; margin-bottom: 16px; filter: grayscale(1); }
      #mobile-rotate-notice .rotate-text {
        font-size: 1rem; color: #e8c56d;
        letter-spacing: 3px; text-transform: uppercase;
      }

      /* Fullscreen CTA */
      #fullscreen-cta {
        position: fixed; top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0,0,0,0.92);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        z-index: 50;
        color: #fff;
        font-family: "Barriecito", system-ui;
        touch-action: none;
      }
      #fullscreen-cta .cta-icon { font-size: 3rem; margin-bottom: 16px; filter: grayscale(1); }
      #fullscreen-cta .cta-text {
        font-size: 1.1rem; color: #e8c56d;
        letter-spacing: 3px; text-transform: uppercase;
      }
      #fullscreen-cta .cta-sub {
        font-size: 0.75rem; color: #666;
        margin-top: 10px; letter-spacing: 1px;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Fullscreen CTA ──────────────────────────────────────────────────────

  private buildCTA() {
    this.ctaOverlay = document.createElement('div');
    this.ctaOverlay.id = 'fullscreen-cta';
    this.ctaOverlay.innerHTML = `
      <div class="cta-icon">📱</div>
      <div class="cta-text">Tap for fullscreen</div>
      <div class="cta-sub">Best experience in landscape</div>
    `;
    this.ctaOverlay.style.display = 'none'; // hidden until game starts
    document.body.appendChild(this.ctaOverlay);

    // Rotate notice (shown in portrait)
    const rotateNotice = document.createElement('div');
    rotateNotice.id = 'mobile-rotate-notice';
    rotateNotice.innerHTML = `
      <div class="rotate-icon">🔄</div>
      <div class="rotate-text">Rotate your device</div>
    `;
    document.body.appendChild(rotateNotice);

    // Lock to landscape if Screen Orientation API available
    try {
      (screen.orientation as any).lock?.('landscape').catch(() => {});
    } catch (_) {}

    this.ctaOverlay.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.requestFullscreen();
    }, { passive: false });

    // In standalone PWA mode, go fullscreen immediately on open.
    // Try auto-request first (works on some Android Chrome versions);
    // if the browser blocks it (needs a user gesture), show the CTA
    // right away so the first tap goes fullscreen before the title screen.
    if (this.isStandalone() && this.supportsFullscreen()) {
      const isFS = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
      if (!isFS) {
        const el = document.documentElement as any;
        const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
        rfs.call(el).catch(() => {
          // Gesture required — show CTA over the title screen
          this.ctaOverlay.style.display = 'flex';
        });
      }
    }
  }

  private requestFullscreen() {
    const el = document.documentElement as any;
    const rfs = el.requestFullscreen
      || el.webkitRequestFullscreen
      || el.msRequestFullscreen;
    if (rfs) {
      rfs.call(el).catch(() => {
        // iOS doesn't support fullscreen API — just hide the CTA
        this.ctaOverlay.style.display = 'none';
      });
    } else {
      // No fullscreen support (iOS) — just hide the CTA
      this.ctaOverlay.style.display = 'none';
    }
  }

  private attachFullscreenListeners() {
    const update = () => {
      const isFS = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
      // Only show CTA on actual mobile hardware, when game is active and not fullscreen
      const gameOverlay = document.getElementById('overlay');
      const gameActive = gameOverlay?.style.display === 'none';
      if (gameActive && !isFS && isMobileDevice() && this.supportsFullscreen()) {
        this.ctaOverlay.style.display = 'flex';
      } else {
        this.ctaOverlay.style.display = 'none';
      }
    };
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);

    (this as any)._checkFullscreen = update;
  }

  private supportsFullscreen(): boolean {
    const el = document.documentElement as any;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen);
  }

  private isStandalone(): boolean {
    return window.matchMedia('(display-mode: standalone)').matches
        || (window.navigator as any).standalone === true;
  }

  /** Call when game transitions to active state */
  showCTAIfNeeded() {
    const isFS = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
    if (!isFS && isMobileDevice() && this.supportsFullscreen()) {
      this.ctaOverlay.style.display = 'flex';
    }
  }

  // ── Controls DOM ────────────────────────────────────────────────────────

  private buildControls() {
    this.container = document.createElement('div');
    this.container.id = 'mobile-controls';

    // Look zone (behind everything, captures remaining touches)
    const lookZone = document.createElement('div');
    lookZone.id = 'look-zone';
    this.container.appendChild(lookZone);

    // Joystick
    this.joystickZone = document.createElement('div');
    this.joystickZone.id = 'joystick-zone';

    this.joystickBase = document.createElement('div');
    this.joystickBase.id = 'joystick-base';
    this.joystickThumb = document.createElement('div');
    this.joystickThumb.id = 'joystick-thumb';
    this.joystickBase.appendChild(this.joystickThumb);
    this.joystickZone.appendChild(this.joystickBase);
    this.container.appendChild(this.joystickZone);

    // Action buttons
    const btnContainer = document.createElement('div');
    btnContainer.id = 'mobile-buttons';

    const btnFlash  = this.makeButton('🔦', 'Light', 'btn-mobile-flashlight');
    this.btnFlash = btnFlash;
    const btnJump   = this.makeButton('⬆', 'Jump', 'btn-mobile-jump');
    this.btnJump = btnJump;
    const btnCrouch = this.makeButton('⬇', 'Crouch', 'btn-mobile-crouch');
    this.btnCrouch = btnCrouch;

    // Flashlight tap
    btnFlash.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleFlashlight();
    }, { passive: false });

    // Jump tap
    btnJump.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.player.triggerJump();
    }, { passive: false });

    // Crouch hold — press and hold to crouch, release to stand
    const crouchStart = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.player.setKey('KeyC', true);
      btnCrouch.classList.add('active');
    };
    const crouchEnd = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.player.setKey('KeyC', false);
      btnCrouch.classList.remove('active');
    };
    btnCrouch.addEventListener('touchstart', crouchStart, { passive: false });
    btnCrouch.addEventListener('touchend', crouchEnd, { passive: false });
    btnCrouch.addEventListener('touchcancel', crouchEnd, { passive: false });

    btnContainer.appendChild(btnFlash);
    btnContainer.appendChild(btnJump);
    btnContainer.appendChild(btnCrouch);
    this.container.appendChild(btnContainer);

    // Gear / options button — top-right corner, fixed position
    const btnOptions = document.createElement('button');
    btnOptions.id = 'btn-mobile-options';
    btnOptions.setAttribute('aria-label', 'Options');
    btnOptions.textContent = '⚙';
    btnOptions.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleOptions();
    }, { passive: false });
    this.container.appendChild(btnOptions);

    this.applyLayout();
    document.body.appendChild(this.container);
  }

  applyLayout() {
    const scale = settings.get('mobileScale');
    const px = Math.round(BTN_SIZE * scale);
    const applyBtn = (btn: HTMLButtonElement, xKey: keyof SettingsData, yKey: keyof SettingsData) => {
      btn.style.left   = settings.get(xKey) + '%';
      btn.style.top    = settings.get(yKey) + '%';
      btn.style.right  = 'auto';
      btn.style.width  = px + 'px';
      btn.style.height = px + 'px';
      const span = btn.querySelector('span');
      if (span) (span as HTMLElement).style.fontSize = Math.round(18 * scale) + 'px';
    };
    applyBtn(this.btnJump,   'mobileBtnJumpX',   'mobileBtnJumpY');
    applyBtn(this.btnCrouch, 'mobileBtnCrouchX', 'mobileBtnCrouchY');
    applyBtn(this.btnFlash,  'mobileBtnFlashX',  'mobileBtnFlashY');
  }

  startEditMode(onDone: () => void) {
    this.show();

    // Create fullscreen edit overlay
    this.editOverlay = document.createElement('div');
    Object.assign(this.editOverlay.style, {
      position: 'fixed', inset: '0', zIndex: '100',
      background: 'rgba(0,0,0,0.55)',
      pointerEvents: 'none',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'flex-start',
      paddingTop: '18px', gap: '10px',
    });

    // Header label
    const label = document.createElement('div');
    label.textContent = 'DRAG BUTTONS TO REPOSITION';
    Object.assign(label.style, {
      color: '#e8c56d', fontFamily: '"Barriecito", system-ui',
      fontSize: '22px', letterSpacing: '3px', pointerEvents: 'none',
    });
    this.editOverlay.appendChild(label);

    // Button row: Done + Reset
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '16px', pointerEvents: 'auto' });

    const mkBtn = (text: string, bg: string) => {
      const b = document.createElement('button');
      b.textContent = text;
      Object.assign(b.style, {
        background: bg, color: '#000', border: 'none',
        borderRadius: '6px', padding: '10px 22px',
        fontFamily: '"Barriecito", system-ui', fontSize: '20px',
        cursor: 'pointer', touchAction: 'none',
      });
      return b;
    };

    const doneBtn  = mkBtn('✓  DONE', '#e8c56d');
    const resetBtn = mkBtn('↺  RESET', '#aaa');
    row.appendChild(doneBtn);
    row.appendChild(resetBtn);
    this.editOverlay.appendChild(row);
    document.body.appendChild(this.editOverlay);

    // Make each action button draggable
    const DEFAULTS_MAP = {
      jump:   { xKey: 'mobileBtnJumpX'   as const, yKey: 'mobileBtnJumpY'   as const, btn: this.btnJump,   dx: 91, dy: 33 },
      crouch: { xKey: 'mobileBtnCrouchX' as const, yKey: 'mobileBtnCrouchY' as const, btn: this.btnCrouch, dx: 91, dy: 53 },
      flash:  { xKey: 'mobileBtnFlashX'  as const, yKey: 'mobileBtnFlashY'  as const, btn: this.btnFlash,  dx: 83, dy: 53 },
    };

    for (const entry of Object.values(DEFAULTS_MAP)) {
      this.makeDraggable(entry.btn, entry.xKey, entry.yKey);
      // Visual hint: dashed gold border in edit mode
      entry.btn.style.border = '2px dashed #e8c56d';
      entry.btn.style.opacity = '1';
    }

    const stopEdit = () => {
      this.stopEditMode();
      for (const entry of Object.values(DEFAULTS_MAP)) {
        entry.btn.style.border = '';
        entry.btn.style.opacity = '';
      }
    };

    doneBtn.addEventListener('click', () => { stopEdit(); onDone(); });
    doneBtn.addEventListener('touchstart', (e) => { e.preventDefault(); stopEdit(); onDone(); }, { passive: false });

    resetBtn.addEventListener('click', () => {
      for (const entry of Object.values(DEFAULTS_MAP)) {
        settings.set(entry.xKey, entry.dx);
        settings.set(entry.yKey, entry.dy);
      }
      settings.set('mobileScale', 1.0);
      // update scale slider if visible
      const sl = document.getElementById('mobile-scale') as HTMLInputElement | null;
      if (sl) sl.value = '100';
      this.applyLayout();
    });
    resetBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      for (const entry of Object.values(DEFAULTS_MAP)) {
        settings.set(entry.xKey, entry.dx);
        settings.set(entry.yKey, entry.dy);
      }
      settings.set('mobileScale', 1.0);
      const sl = document.getElementById('mobile-scale') as HTMLInputElement | null;
      if (sl) sl.value = '100';
      this.applyLayout();
    }, { passive: false });
  }

  private makeDraggable(
    btn: HTMLButtonElement,
    xKey: keyof SettingsData,
    yKey: keyof SettingsData
  ) {
    let activeTouchId: number | null = null;

    const onStart = (e: TouchEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (activeTouchId !== null) return;
      activeTouchId = e.changedTouches[0].identifier;
    };

    const onMove = (e: TouchEvent) => {
      if (activeTouchId === null) return;
      const touch = Array.from(e.changedTouches).find(c => c.identifier === activeTouchId);
      if (!touch) return;
      e.preventDefault();
      const scale  = settings.get('mobileScale');
      const btnPx  = BTN_SIZE * scale;
      const x = Math.max(0, Math.min(100 - btnPx / window.innerWidth  * 100, (touch.clientX - btnPx / 2) / window.innerWidth  * 100));
      const y = Math.max(0, Math.min(100 - btnPx / window.innerHeight * 100, (touch.clientY - btnPx / 2) / window.innerHeight * 100));
      settings.set(xKey, Math.round(x * 10) / 10);
      settings.set(yKey, Math.round(y * 10) / 10);
      btn.style.left = x + '%';
      btn.style.top  = y + '%';
    };

    const onEnd = (e: TouchEvent) => {
      if (Array.from(e.changedTouches).some(c => c.identifier === activeTouchId)) activeTouchId = null;
    };

    btn.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('touchmove',  onMove, { passive: false });
    // Register end/cancel directly on the button so crouchEnd's stopPropagation()
    // doesn't prevent activeTouchId from being cleared on the document listener.
    btn.addEventListener('touchend',    onEnd, { passive: false });
    btn.addEventListener('touchcancel', onEnd, { passive: false });

    this.editCleanup.push(() => {
      btn.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      btn.removeEventListener('touchend',    onEnd);
      btn.removeEventListener('touchcancel', onEnd);
    });
  }

  private stopEditMode() {
    this.editCleanup.forEach(fn => fn());
    this.editCleanup = [];
    this.editOverlay?.remove();
    this.editOverlay = null;
  }

  private makeButton(icon: string, label: string, id: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'mobile-btn';
    btn.id = id;
    btn.innerHTML = `<span style="font-size:18px;line-height:1;filter:grayscale(1)">${icon}</span>`;
    btn.setAttribute('aria-label', label);
    return btn;
  }

  // ── Touch Handling ──────────────────────────────────────────────────────

  private attachTouchListeners() {
    const joyZone  = this.joystickZone;
    const lookZone = this.container.querySelector('#look-zone')!;

    // ── Joystick (dynamic position — appears at touch point) ──
    joyZone.addEventListener('touchstart', (e: Event) => {
      const te = e as TouchEvent;
      te.preventDefault();
      if (this.joystickTouchId !== null) return;
      const t = te.changedTouches[0];
      this.joystickTouchId = t.identifier;
      // Convert viewport coords to zone-relative coords
      const zoneRect = joyZone.getBoundingClientRect();
      const relX = t.clientX - zoneRect.left;
      const relY = t.clientY - zoneRect.top;
      // Position joystick base centered on touch point (zone-relative)
      this.joystickOriginX = t.clientX;
      this.joystickOriginY = t.clientY;
      this.joystickBase.style.left = `${relX - JOYSTICK_SIZE / 2}px`;
      this.joystickBase.style.top  = `${relY - JOYSTICK_SIZE / 2}px`;
      this.joystickBase.style.bottom = 'auto';
      this.joystickBase.style.display = 'block';
      this.joystickThumb.style.transform = 'translate(-50%, -50%)';
    }, { passive: false });

    joyZone.addEventListener('touchmove', (e: Event) => {
      const te = e as TouchEvent;
      te.preventDefault();
      for (let i = 0; i < te.changedTouches.length; i++) {
        const t = te.changedTouches[i];
        if (t.identifier === this.joystickTouchId) {
          this.updateJoystick(t.clientX, t.clientY);
        }
      }
    }, { passive: false });

    const joyEnd = (e: Event) => {
      const te = e as TouchEvent;
      for (let i = 0; i < te.changedTouches.length; i++) {
        if (te.changedTouches[i].identifier === this.joystickTouchId) {
          this.joystickTouchId = null;
          this.joyVecX = 0;
          this.joyVecY = 0;
          this.joystickBase.style.display = 'none';
          this.joystickThumb.style.transform = 'translate(-50%, -50%)';
        }
      }
    };
    joyZone.addEventListener('touchend', joyEnd, { passive: false });
    joyZone.addEventListener('touchcancel', joyEnd, { passive: false });

    // ── Look ──
    lookZone.addEventListener('touchstart', (e: Event) => {
      const te = e as TouchEvent;
      te.preventDefault();
      if (this.lookTouchId !== null) return;
      const t = te.changedTouches[0];
      this.lookTouchId = t.identifier;
      this.lookPrevX = t.clientX;
      this.lookPrevY = t.clientY;
    }, { passive: false });

    lookZone.addEventListener('touchmove', (e: Event) => {
      const te = e as TouchEvent;
      te.preventDefault();
      for (let i = 0; i < te.changedTouches.length; i++) {
        const t = te.changedTouches[i];
        if (t.identifier === this.lookTouchId) {
          const dx = t.clientX - this.lookPrevX;
          const dy = t.clientY - this.lookPrevY;
          this.player.applyLookDelta(dx * LOOK_SENSITIVITY, dy * LOOK_SENSITIVITY);
          this.lookPrevX = t.clientX;
          this.lookPrevY = t.clientY;
        }
      }
    }, { passive: false });

    const lookEnd = (e: Event) => {
      const te = e as TouchEvent;
      for (let i = 0; i < te.changedTouches.length; i++) {
        if (te.changedTouches[i].identifier === this.lookTouchId) {
          this.lookTouchId = null;
        }
      }
    };
    lookZone.addEventListener('touchend', lookEnd, { passive: false });
    lookZone.addEventListener('touchcancel', lookEnd, { passive: false });
  }

  private updateJoystick(clientX: number, clientY: number) {
    const dx = clientX - this.joystickOriginX;
    const dy = clientY - this.joystickOriginY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxR = JOYSTICK_SIZE / 2 - JOYSTICK_THUMB / 4;

    // Clamp to circle
    const clampedDist = Math.min(dist, maxR);
    const angle = Math.atan2(dy, dx);
    const cx = Math.cos(angle) * clampedDist;
    const cy = Math.sin(angle) * clampedDist;

    // Move thumb
    this.joystickThumb.style.transform = `translate(calc(-50% + ${cx}px), calc(-50% + ${cy}px))`;

    // Normalised output with dead zone
    if (dist < DEAD_ZONE) {
      this.joyVecX = 0;
      this.joyVecY = 0;
    } else {
      this.joyVecX = cx / maxR;
      this.joyVecY = cy / maxR;
    }
  }
}
