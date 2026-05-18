/**
 * Audio manager with per-enemy 3D audio channels.
 * Each enemy gets its own PannerNode, loop, and one-shot sources.
 * Buffers (MP3s + procedural) are loaded/generated once and shared.
 */

const IDLE_FILES    = ['idle-01.mp3', 'idle-02.mp3', 'idle-03.mp3', 'idle-04.mp3', 'idle-05.mp3'];
const CHASING_FILES = ['chasing-01.mp3', 'chasing-02.mp3', 'chasing-03.mp3', 'chasing-04.mp3'];
const ALERT_FILE    = 'alert.mp3';

const IDLE_MIN_INTERVAL    = 6;
const IDLE_MAX_INTERVAL    = 14;
const CHASING_MIN_INTERVAL = 2;
const CHASING_MAX_INTERVAL = 5;

const PLAYBACK_RATE = 0.75;

/** One audio channel per enemy — own panner, own loop, own one-shot */
class EnemyChannel {
  panner: PannerNode;
  private ctx: AudioContext;
  private master: GainNode;

  // Procedural loop
  private loop: AudioBufferSourceNode | null = null;
  private loopGain: GainNode | null = null;
  private loopState: string = '';

  // MP3 one-shot
  private oneShot: AudioBufferSourceNode | null = null;
  private oneShotPriority: number = 0;
  private nextTriggerTime: number = 0;
  private currentState: string = '';

  constructor(ctx: AudioContext, master: GainNode) {
    this.ctx = ctx;
    this.master = master;

    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 4;
    this.panner.maxDistance = 60;
    this.panner.rolloffFactor = 1.5;
    this.panner.connect(master);
  }

  setPosition(x: number, y: number, z: number) {
    if (this.panner.positionX) {
      this.panner.positionX.value = x;
      this.panner.positionY.value = y;
      this.panner.positionZ.value = z;
    } else {
      (this.panner as any).setPosition(x, y, z);
    }
  }

  playState(
    state: 'searching' | 'spotted' | 'chasing',
    shared: SharedBuffers
  ) {
    if (state === this.currentState) {
      this.tickRandom(shared);
      return;
    }

    const prev = this.currentState;
    this.currentState = state;

    switch (state) {
      case 'searching':
        this.setLoop(shared.searchingBuf, 0.4);
        if (this.oneShotPriority < 3) this.stopOneShot();
        this.scheduleNext(IDLE_MIN_INTERVAL, IDLE_MAX_INTERVAL);
        break;

      case 'spotted':
        this.playAlert(shared);
        break;

      case 'chasing':
        this.setLoop(shared.chasingBuf, 0.6);
        if (this.oneShotPriority < 3) {
          this.playRandomOneShot(shared.chasingMp3s, 0.7, 2);
        }
        this.scheduleNext(CHASING_MIN_INTERVAL, CHASING_MAX_INTERVAL);
        break;
    }
  }

  stop() {
    this.stopLoop();
    this.stopOneShot();
    this.currentState = '';
    this.nextTriggerTime = 0;
  }

  // ── Loop ────────────────────────────────────────────────────────────────

  private setLoop(buf: AudioBuffer | null, volume: number) {
    if (!buf) return;
    // Don't restart if same loop
    const key = buf === null ? '' : (buf as any).__id;
    if (this.loopState === this.currentState && this.loop) return;
    this.stopLoop();
    this.loopState = this.currentState;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.panner);
    src.start();
    this.loop = src;
    this.loopGain = g;
  }

  private stopLoop() {
    if (this.loop) {
      try { this.loop.stop(); } catch {}
      this.loop = null;
      this.loopState = '';
    }
  }

  // ── One-shots ───────────────────────────────────────────────────────────

  private stopOneShot() {
    if (this.oneShot) {
      try { this.oneShot.stop(); } catch {}
      this.oneShot = null;
      this.oneShotPriority = 0;
    }
  }

  private playAlert(shared: SharedBuffers) {
    if (!shared.alertBuf) return;
    this.stopOneShot();
    const src = this.ctx.createBufferSource();
    src.buffer = shared.alertBuf;
    src.playbackRate.value = PLAYBACK_RATE;
    const g = this.ctx.createGain();
    g.gain.value = 0.8;
    src.connect(g).connect(this.panner);
    src.start();
    this.oneShot = src;
    this.oneShotPriority = 3;
    src.onended = () => {
      if (this.oneShot === src) { this.oneShot = null; this.oneShotPriority = 0; }
    };
  }

  private playRandomOneShot(pool: AudioBuffer[], volume: number, priority: number) {
    if (pool.length === 0) return;
    if (this.oneShot && this.oneShotPriority >= priority) return;
    this.stopOneShot();
    const buf = pool[Math.floor(Math.random() * pool.length)];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = PLAYBACK_RATE;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.panner);
    src.start();
    this.oneShot = src;
    this.oneShotPriority = priority;
    src.onended = () => {
      if (this.oneShot === src) { this.oneShot = null; this.oneShotPriority = 0; }
    };
  }

  private scheduleNext(min: number, max: number) {
    this.nextTriggerTime = this.ctx.currentTime + min + Math.random() * (max - min);
  }

  private tickRandom(shared: SharedBuffers) {
    if (this.nextTriggerTime <= 0 || this.ctx.currentTime < this.nextTriggerTime) return;
    if (this.oneShot && this.oneShotPriority >= 3) return;

    if (this.currentState === 'searching') {
      this.playRandomOneShot(shared.idleMp3s, 0.5, 1);
      this.scheduleNext(IDLE_MIN_INTERVAL, IDLE_MAX_INTERVAL);
    } else if (this.currentState === 'chasing') {
      this.playRandomOneShot(shared.chasingMp3s, 0.7, 2);
      this.scheduleNext(CHASING_MIN_INTERVAL, CHASING_MAX_INTERVAL);
    }
  }
}

/** Shared buffers loaded once, used by all channels */
interface SharedBuffers {
  searchingBuf: AudioBuffer | null;
  chasingBuf:   AudioBuffer | null;
  alertBuf:     AudioBuffer | null;
  idleMp3s:     AudioBuffer[];
  chasingMp3s:  AudioBuffer[];
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain!: GainNode;
  private shared: SharedBuffers = {
    searchingBuf: null, chasingBuf: null, alertBuf: null,
    idleMp3s: [], chasingMp3s: [],
  };
  private channels: Map<number, EnemyChannel> = new Map();
  private nextChannelId = 0;

  init() {
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.6;
    this.masterGain.connect(this.ctx.destination);

    // Generate procedural buffers
    this.shared.searchingBuf = this.makeSearchingBuffer();
    this.shared.chasingBuf   = this.makeChasingBuffer();

    // Load MP3s
    this.loadMp3Buffers();

    // Start proximity tension drone (silent until enemies are near)
    this.initDrone();
  }

  private async loadMp3Buffers() {
    if (!this.ctx) return;
    const load = async (url: string): Promise<AudioBuffer | null> => {
      try {
        const resp = await fetch(url);
        const ab   = await resp.arrayBuffer();
        return await this.ctx!.decodeAudioData(ab);
      } catch (e) {
        console.warn(`Failed to load audio: ${url}`, e);
        return null;
      }
    };
    const [alertBuf, ...rest] = await Promise.all([
      load(ALERT_FILE),
      ...IDLE_FILES.map(f => load(f)),
      ...CHASING_FILES.map(f => load(f)),
    ]);
    this.shared.alertBuf    = alertBuf;
    this.shared.idleMp3s    = rest.slice(0, IDLE_FILES.length).filter(Boolean) as AudioBuffer[];
    this.shared.chasingMp3s = rest.slice(IDLE_FILES.length).filter(Boolean) as AudioBuffer[];
  }

  resume() { this.ctx?.resume(); }

  /** Create a new audio channel for an enemy. Returns channel ID. */
  createChannel(): number {
    if (!this.ctx) return -1;
    const id = this.nextChannelId++;
    const ch = new EnemyChannel(this.ctx, this.masterGain);
    this.channels.set(id, ch);
    return id;
  }

  /** Update position of an enemy channel */
  setChannelPosition(id: number, x: number, y: number, z: number) {
    this.channels.get(id)?.setPosition(x, y, z);
  }

  /** Update state of an enemy channel */
  playChannelState(id: number, state: 'searching' | 'spotted' | 'chasing') {
    this.channels.get(id)?.playState(state, this.shared);
  }

  /** Stop an enemy channel */
  stopChannel(id: number) {
    this.channels.get(id)?.stop();
  }

  /** Stop all enemy channels */
  stopEnemySound() {
    for (const ch of this.channels.values()) ch.stop();
  }

  /** Update listener (player) position and orientation */
  setListenerPose(px: number, py: number, pz: number, fx: number, fy: number, fz: number) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = px; l.positionY.value = py; l.positionZ.value = pz;
      l.forwardX.value = fx;  l.forwardY.value = fy;  l.forwardZ.value = fz;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      (l as any).setPosition(px, py, pz);
      (l as any).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  // ── Procedural buffer synthesis (shared) ────────────────────────────────

  private makeSearchingBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const dur = 3.0;
    const buf = ctx.createBuffer(1, sr * dur, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      const env = Math.sin(Math.PI * t / dur);
      const osc = Math.sin(2 * Math.PI * 60 * t) * 0.5
                + Math.sin(2 * Math.PI * 90 * t + Math.sin(t * 0.5)) * 0.3
                + (Math.random() - 0.5) * 0.05;
      data[i] = osc * env * 0.4;
    }
    return buf;
  }

  private makeChasingBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const dur = 1.0;
    const buf = ctx.createBuffer(1, sr * dur, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      const lfo = 0.5 + 0.5 * Math.sin(2 * Math.PI * 8 * t);
      const osc = Math.sin(2 * Math.PI * 80 * t) * 0.6
                + Math.sin(2 * Math.PI * 160 * t) * 0.3
                + (Math.random() - 0.5) * 0.1;
      data[i] = osc * lfo * 0.6;
    }
    return buf;
  }

  // ── Proximity tension drone (non-positional, always running) ─────────────

  private droneSource: AudioBufferSourceNode | null = null;
  private droneGain: GainNode | null = null;
  private droneTarget = 0;
  private droneCurrent = 0;

  private initDrone() {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const dur = 6.0;
    const buf = this.ctx.createBuffer(1, sr * dur, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      // Layered sub-bass + rumble + dissonant overtone
      const sub     = Math.sin(2 * Math.PI * 32 * t) * 0.4;
      const rumble  = Math.sin(2 * Math.PI * 48 * t + Math.sin(t * 2.0) * 3.0) * 0.3;
      const grind   = Math.sin(2 * Math.PI * 73 * t) * 0.15;
      const noise   = (Math.random() - 0.5) * 0.08;
      const lfo     = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.25 * t);
      data[i] = (sub + rumble + grind + noise) * lfo;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(this.masterGain);
    src.start();
    this.droneSource = src;
    this.droneGain = g;
  }

  /** Call every frame with distance to nearest enemy on current floor */
  updateProximityDrone(nearestDist: number) {
    if (!this.droneGain) return;
    const MAX_DIST = 18;
    const MIN_DIST = 3;
    if (nearestDist > MAX_DIST || nearestDist < 0) {
      this.droneTarget = 0;
      // Immediate silence when explicitly killed (negative dist)
      if (nearestDist < 0) { this.droneCurrent = 0; this.droneGain.gain.value = 0; return; }
    } else {
      const t = 1.0 - Math.max(0, Math.min(1, (nearestDist - MIN_DIST) / (MAX_DIST - MIN_DIST)));
      this.droneTarget = t * t * 0.7; // quadratic ramp, max 0.7
    }
    // Smooth toward target
    this.droneCurrent += (this.droneTarget - this.droneCurrent) * 0.05;
    this.droneGain.gain.value = this.droneCurrent;
  }

  // ── Flashlight click (non-positional) ───────────────────────────────────

  playFlashlightToggle(on: boolean) {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const dur = on ? 0.06 : 0.08;
    const buf = this.ctx.createBuffer(1, sr * dur, sr);
    const data = buf.getChannelData(0);
    const freq = on ? 3200 : 1800;
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      const env = Math.max(0, 1 - t / dur);
      data[i] = (Math.sin(2 * Math.PI * freq * t) * 0.3
              + (Math.random() - 0.5) * 0.4) * env * env;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.03;  // ~5% volume
    src.connect(g).connect(this.masterGain);
    src.start();
  }

  // ── Electrical flicker buzz (non-positional, looping) ────────────────────

  private flickerSource: AudioBufferSourceNode | null = null;
  private flickerGain: GainNode | null = null;

  /** Start or update the electrical buzz volume (0 = silent, 1 = full) */
  updateFlickerBuzz(intensity: number) {
    if (!this.ctx) return;

    // Lazy init — create the looping buzz on first call
    if (!this.flickerSource) {
      const sr = this.ctx.sampleRate;
      const dur = 0.5;
      const buf = this.ctx.createBuffer(1, sr * dur, sr);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const t = i / sr;
        // 50/60Hz electrical hum + harmonics + crackle
        const hum = Math.sin(2 * Math.PI * 60 * t) * 0.3
                  + Math.sin(2 * Math.PI * 120 * t) * 0.25
                  + Math.sin(2 * Math.PI * 180 * t) * 0.15;
        const crackle = (Math.random() - 0.5) * 0.3;
        // Random pops
        const pop = Math.random() > 0.97 ? (Math.random() - 0.5) * 0.8 : 0;
        data[i] = hum + crackle + pop;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.masterGain);
      src.start();
      this.flickerSource = src;
      this.flickerGain = g;
    }

    this.flickerGain!.gain.value = intensity * 0.15; // max 15% volume at full flicker
  }

  /** Short percussive pickup thud */
  playPickupSound() {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const dur = 0.12;
    const buf = this.ctx.createBuffer(1, sr * dur, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      // Fast exponential decay
      const env = Math.exp(-t * 40);
      // Low thump + noise burst
      const thump = Math.sin(2 * Math.PI * 120 * t * Math.exp(-t * 15));
      const snap = (Math.random() - 0.5) * Math.exp(-t * 60);
      data[i] = (thump * 0.6 + snap * 0.4) * env;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.12;  // 20% volume
    src.connect(g).connect(this.masterGain);
    src.start();
  }

  dispose() {
    this.stopEnemySound();
    if (this.droneSource) { try { this.droneSource.stop(); } catch {} this.droneSource = null; }
    if (this.flickerSource) { try { this.flickerSource.stop(); } catch {} this.flickerSource = null; }
    this.ctx?.close();
  }
}
