/**
 * Audio manager with per-enemy 3D audio channels.
 * Each enemy gets its own PannerNode, loop, and one-shot sources.
 * Buffers (MP3s + procedural) are loaded/generated once and shared.
 */

const IDLE_FILES    = ['idle-01.mp3', 'idle-02.mp3', 'idle-03.mp3', 'idle-04.mp3', 'idle-05.mp3', 'idle-06.mp3'];
const CHASING_FILES = ['chasing-01.mp3', 'chasing-02.mp3', 'chasing-03.mp3', 'chasing-04.mp3', 'chasing-05.mp3', 'chasing-06.mp3'];
const ALERT_FILE    = 'alert.mp3';

const IDLE_MIN_INTERVAL    = 6;
const IDLE_MAX_INTERVAL    = 14;
const CHASING_MIN_INTERVAL = 2;
const CHASING_MAX_INTERVAL = 5;

const PLAYBACK_RATE = 0.75;

/** One audio channel per enemy — own panner, own loop, own one-shot.
 *  Each channel splits into dry (direct) and wet (reverb send) paths,
 *  with the mix controlled by distance to the listener. */
class EnemyChannel {
  panner: PannerNode;
  private ctx: AudioContext;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private occlusionFilter: BiquadFilterNode;

  // Procedural loop
  private loop: AudioBufferSourceNode | null = null;
  private loopGain: GainNode | null = null;
  private loopState: string = '';

  // MP3 one-shot
  private oneShot: AudioBufferSourceNode | null = null;
  private oneShotPriority: number = 0;
  private nextTriggerTime: number = 0;
  private currentState: string = '';

  // Smoothed occlusion values (avoid clicks from sudden changes)
  private currentDry = 1.0;
  private currentWet = 0.1;
  private currentCutoff = 20000;

  constructor(ctx: AudioContext, master: GainNode, reverbBus: GainNode) {
    this.ctx = ctx;

    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 4;
    this.panner.maxDistance = 60;
    this.panner.rolloffFactor = 1.5;

    // Low-pass filter for wall occlusion muffle
    this.occlusionFilter = ctx.createBiquadFilter();
    this.occlusionFilter.type = 'lowpass';
    this.occlusionFilter.frequency.value = 20000; // wide open by default
    this.occlusionFilter.Q.value = 0.7;

    // Dry path: panner → filter → dryGain → master (direct/close sound)
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1.0;
    this.panner.connect(this.occlusionFilter).connect(this.dryGain).connect(master);

    // Wet path: panner → wetGain → shared reverb bus (distant/reverberant)
    // Wet path bypasses the occlusion filter — reverb tail is naturally diffuse
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.1;
    this.panner.connect(this.wetGain).connect(reverbBus);
  }

  /** Update occlusion based on distance + wall count between player and enemy.
   *  Walls add muffle (low-pass) + push dry→wet. Distance also contributes. */
  updateOcclusion(dist: number, wallCount: number) {
    const SMOOTH = 0.08; // lerp speed per call (~frame rate)

    // ── Distance contribution ──
    const MIN_DIST = 3, MAX_DIST = 40;
    const distT = Math.max(0, Math.min(1, (dist - MIN_DIST) / (MAX_DIST - MIN_DIST)));

    // ── Wall contribution (each wall adds significant muffle + reverb) ──
    const wallT = Math.min(1, wallCount / 6); // 6+ walls = fully occluded

    // Combined occlusion factor (walls dominate, distance adds to it)
    const occlusion = Math.min(1, wallT * 0.7 + distT * 0.4);

    // Dry/wet: more occlusion = less dry, more reverb
    const targetDry = 1.0 - occlusion * 0.75;     // 1.0 → 0.25
    const targetWet = 0.1 + occlusion * 1.2;       // 0.1 → 1.3

    // Low-pass cutoff: walls muffle high frequencies
    // 0 walls = 20kHz (open), 6+ walls = ~800Hz (very muffled)
    const targetCutoff = 20000 * Math.pow(0.25, wallT); // exponential: 20k → ~1.25k

    // Smooth toward targets
    this.currentDry    += (targetDry - this.currentDry) * SMOOTH;
    this.currentWet    += (targetWet - this.currentWet) * SMOOTH;
    this.currentCutoff += (targetCutoff - this.currentCutoff) * SMOOTH;

    this.dryGain.gain.value = this.currentDry;
    this.wetGain.gain.value = this.currentWet;
    this.occlusionFilter.frequency.value = this.currentCutoff;
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
  deathGrowlBuf: AudioBuffer | null;
  idleMp3s:     AudioBuffer[];
  chasingMp3s:  AudioBuffer[];
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain!: GainNode;
  private reverbSend!: GainNode;
  private enemyReverbBus!: GainNode; // shared reverb bus for per-enemy distance reverb
  private shared: SharedBuffers = {
    searchingBuf: null, chasingBuf: null, alertBuf: null, deathGrowlBuf: null,
    idleMp3s: [], chasingMp3s: [],
  };
  private channels: Map<number, EnemyChannel> = new Map();
  private nextChannelId = 0;

  init() {
    this.ctx = new AudioContext();

    // Master volume → destination
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.2;

    // Global reverb: master → convolver → wet gain → destination
    //                master → dry (direct) → destination
    const convolver = this.ctx.createConvolver();
    convolver.buffer = this.generateImpulseResponse(1.6, 5.0);

    const wetGain = this.ctx.createGain();
    wetGain.gain.value = 0.75;   // reverb mix level

    const dryGain = this.ctx.createGain();
    dryGain.gain.value = 1.0;

    this.masterGain.connect(dryGain).connect(this.ctx.destination);
    this.masterGain.connect(convolver).connect(wetGain).connect(this.ctx.destination);

    // Keep reference so we can adjust reverb per floor
    this.reverbSend = wetGain;

    // Per-enemy distance reverb bus: enemy wet sends → convolver → destination
    // Uses a longer, more diffuse impulse for that "distant echo" effect
    const enemyConvolver = this.ctx.createConvolver();
    enemyConvolver.buffer = this.generateImpulseResponse(2.5, 3.5);
    this.enemyReverbBus = this.ctx.createGain();
    this.enemyReverbBus.gain.value = 1.0;
    this.enemyReverbBus.connect(enemyConvolver).connect(this.ctx.destination);

    // Generate procedural buffers
    this.shared.searchingBuf = this.makeSearchingBuffer();
    this.shared.chasingBuf   = this.makeChasingBuffer();

    // Load MP3s
    this.loadMp3Buffers();

    // Start proximity tension drone (silent until enemies are near)
    this.initDrone();
  }

  /**
   * Generate a synthetic impulse response for convolution reverb.
   * @param decay   Time in seconds for the reverb tail to decay
   * @param density Higher values = more diffuse (more random reflections)
   */
  private generateImpulseResponse(decay: number, density: number): AudioBuffer {
    const sr = this.ctx!.sampleRate;
    const len = sr * decay;
    const buf = this.ctx!.createBuffer(2, len, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);

    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // Exponential decay envelope
      const env = Math.exp(-t * density);
      // Diffuse white noise with some early reflection clustering
      const earlyBoost = t < 0.08 ? 1.5 : 1.0;
      L[i] = (Math.random() * 2 - 1) * env * earlyBoost;
      R[i] = (Math.random() * 2 - 1) * env * earlyBoost;
    }

    // Add a few discrete early reflections for realism
    const reflections = [0.012, 0.025, 0.038, 0.055, 0.073];
    for (const rt of reflections) {
      const idx = Math.floor(rt * sr);
      if (idx < len) {
        const amp = 0.4 * Math.exp(-rt * 2);
        L[idx] += amp * (Math.random() > 0.5 ? 1 : -1);
        R[idx] += amp * (Math.random() > 0.5 ? 1 : -1);
      }
    }

    return buf;
  }

  /** Adjust reverb intensity per floor (called on floor change) */
  setReverbLevel(level: number) {
    if (this.reverbSend) this.reverbSend.gain.value = level;
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
    const [alertBuf, deathGrowlBuf, ...rest] = await Promise.all([
      load(ALERT_FILE),
      load('death-growl.mp3'),
      ...IDLE_FILES.map(f => load(f)),
      ...CHASING_FILES.map(f => load(f)),
    ]);
    this.shared.alertBuf      = alertBuf;
    this.shared.deathGrowlBuf = deathGrowlBuf;
    this.shared.idleMp3s    = rest.slice(0, IDLE_FILES.length).filter(Boolean) as AudioBuffer[];
    this.shared.chasingMp3s = rest.slice(IDLE_FILES.length).filter(Boolean) as AudioBuffer[];
  }

  resume() { this.ctx?.resume(); }

  /** Create a new audio channel for an enemy. Returns channel ID. */
  createChannel(): number {
    if (!this.ctx) return -1;
    const id = this.nextChannelId++;
    const ch = new EnemyChannel(this.ctx, this.masterGain, this.enemyReverbBus);
    this.channels.set(id, ch);
    return id;
  }

  /** Update position of an enemy channel */
  setChannelPosition(id: number, x: number, y: number, z: number) {
    this.channels.get(id)?.setPosition(x, y, z);
  }

  /** Update per-enemy sound occlusion (distance + wall count → reverb mix + muffle) */
  updateChannelOcclusion(id: number, dist: number, wallCount: number) {
    this.channels.get(id)?.updateOcclusion(dist, wallCount);
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

  // ── Chase tension (high-pitch rising shriek) ─────────────────────────────

  // Note 1: main pair (osc1 + osc2 with small fixed beating)
  private chaseOsc1: OscillatorNode | null = null;
  private chaseOsc2: OscillatorNode | null = null;
  // Note 2: detuned pair (osc3 + osc4, quarter-semitone offset, widens with proximity)
  private chaseOsc3: OscillatorNode | null = null;
  private chaseOsc4: OscillatorNode | null = null;
  private chaseNoiseSource: AudioBufferSourceNode | null = null;
  private chaseGain: GainNode | null = null;
  private chaseNoiseGain: GainNode | null = null;
  private chaseFilter: BiquadFilterNode | null = null;
  private chaseActive = false;
  private chasePitch = 0;     // current smoothed pitch 0..1
  private chaseVolume = 0;    // current smoothed volume

  // Semitone = 2^(1/12); quarter-semitone = 2^(0.25/12)
  private static readonly SEMITONE_RATIO = Math.pow(2, 1 / 12);         // ~1.05946
  private static readonly QUARTER_ST_RATIO = Math.pow(2, 0.25 / 12);    // ~1.01449

  private initChaseLayer() {
    if (!this.ctx || this.chaseOsc1) return;

    const BASE_FREQ = 400;

    // Note 1: two detuned sawtooths (small fixed beating)
    this.chaseOsc1 = this.ctx.createOscillator();
    this.chaseOsc1.type = 'sawtooth';
    this.chaseOsc1.frequency.value = BASE_FREQ;

    this.chaseOsc2 = this.ctx.createOscillator();
    this.chaseOsc2.type = 'sawtooth';
    this.chaseOsc2.frequency.value = BASE_FREQ + 2; // small fixed beat

    // Note 2: second pair, quarter-semitone detune that grows with proximity
    this.chaseOsc3 = this.ctx.createOscillator();
    this.chaseOsc3.type = 'sawtooth';
    this.chaseOsc3.frequency.value = BASE_FREQ;

    this.chaseOsc4 = this.ctx.createOscillator();
    this.chaseOsc4.type = 'sawtooth';
    this.chaseOsc4.frequency.value = BASE_FREQ + 2;

    // High-pass filter to keep it shrill
    this.chaseFilter = this.ctx.createBiquadFilter();
    this.chaseFilter.type = 'highpass';
    this.chaseFilter.frequency.value = 600;
    this.chaseFilter.Q.value = 2;

    // Main gain (starts silent)
    this.chaseGain = this.ctx.createGain();
    this.chaseGain.gain.value = 0;

    this.chaseOsc1.connect(this.chaseFilter);
    this.chaseOsc2.connect(this.chaseFilter);
    this.chaseOsc3.connect(this.chaseFilter);
    this.chaseOsc4.connect(this.chaseFilter);
    this.chaseFilter.connect(this.chaseGain);

    // Chase-specific dry/wet routing: 10% dry, 200% wet reverb
    const chaseDry = this.ctx.createGain();
    chaseDry.gain.value = 0.1;

    const chaseConvolver = this.ctx.createConvolver();
    chaseConvolver.buffer = this.generateImpulseResponse(2.2, 4.0);

    const chaseWet = this.ctx.createGain();
    chaseWet.gain.value = 2.0;

    this.chaseGain.connect(chaseDry).connect(this.masterGain);
    this.chaseGain.connect(chaseConvolver).connect(chaseWet).connect(this.masterGain);

    // Noise layer for texture
    const sr = this.ctx.sampleRate;
    const noiseBuf = this.ctx.createBuffer(1, sr * 2, sr);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) {
      nd[i] = (Math.random() - 0.5) * 0.6;
    }
    this.chaseNoiseSource = this.ctx.createBufferSource();
    this.chaseNoiseSource.buffer = noiseBuf;
    this.chaseNoiseSource.loop = true;

    this.chaseNoiseGain = this.ctx.createGain();
    this.chaseNoiseGain.gain.value = 0;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 3000;
    noiseFilter.Q.value = 1.5;

    this.chaseNoiseSource.connect(noiseFilter);
    noiseFilter.connect(this.chaseNoiseGain);
    // Noise also goes through the same chase reverb
    this.chaseNoiseGain.connect(chaseDry).connect(this.masterGain);
    this.chaseNoiseGain.connect(chaseConvolver);

    this.chaseOsc1.start();
    this.chaseOsc2.start();
    this.chaseOsc3.start();
    this.chaseOsc4.start();
    this.chaseNoiseSource.start();
  }

  /**
   * Call every frame during gameplay.
   * @param chasing  true if any enemy is in CHASING state
   * @param nearestDist  distance to nearest chasing enemy (Infinity if none)
   */
  updateChaseTension(chasing: boolean, nearestDist: number) {
    if (!this.ctx) return;
    this.initChaseLayer();
    if (!this.chaseOsc1 || !this.chaseOsc2 || !this.chaseOsc3 || !this.chaseOsc4 ||
        !this.chaseGain || !this.chaseNoiseGain) return;

    const BASE_FREQ = 400;
    const MAX_DIST = 25;
    const MIN_DIST = 2;

    if (chasing && nearestDist < MAX_DIST) {
      // Proximity 0..1 (1 = touching)
      const prox = 1.0 - Math.max(0, Math.min(1, (nearestDist - MIN_DIST) / (MAX_DIST - MIN_DIST)));

      // Pitch rises quadratically: subtle at distance, dramatic up close
      const targetPitch = prox * prox;
      this.chasePitch += (targetPitch - this.chasePitch) * 0.06;

      // Note 1: base freq rises up to 2 semitones (400 → ~449 Hz)
      const semitoneShift = this.chasePitch * 2; // 0..1 → 0..2 semitones
      const freq1 = BASE_FREQ * Math.pow(AudioManager.SEMITONE_RATIO, semitoneShift);
      this.chaseOsc1.frequency.value = freq1;
      this.chaseOsc2.frequency.value = freq1 + 2; // small fixed beating

      // Note 2: detuned by up to a full semitone, increasing with proximity
      // At prox=0 → same as note 1; at prox=1 → 1 semitone above note 1
      const stDetune = this.chasePitch * 4; // 0..1 → 0..4 quarter-semitones = 0..1 semitone
      const freq2 = freq1 * Math.pow(AudioManager.QUARTER_ST_RATIO, stDetune);
      this.chaseOsc3.frequency.value = freq2;
      this.chaseOsc4.frequency.value = freq2 + 2;

      // Volume ramps up: quadratic for dramatic curve
      const targetVol = prox * prox * 0.03;
      this.chaseVolume += (targetVol - this.chaseVolume) * 0.08;
      this.chaseGain.gain.value = this.chaseVolume;

      // Noise layer increases
      this.chaseNoiseGain.gain.value = this.chaseVolume * 0.4;

      // Filter opens up as it gets closer
      this.chaseFilter!.frequency.value = 600 - prox * 400;

      this.chaseActive = true;
    } else {
      // Fade out smoothly
      this.chaseVolume *= 0.92;
      this.chasePitch *= 0.95;
      if (this.chaseVolume < 0.001) this.chaseVolume = 0;
      this.chaseGain.gain.value = this.chaseVolume;
      this.chaseNoiseGain.gain.value = this.chaseVolume * 0.4;

      if (this.chaseVolume === 0) {
        this.chaseOsc1.frequency.value = BASE_FREQ;
        this.chaseOsc2.frequency.value = BASE_FREQ + 2;
        this.chaseOsc3.frequency.value = BASE_FREQ;
        this.chaseOsc4.frequency.value = BASE_FREQ + 2;
        this.chaseActive = false;
      }
    }
  }

  /** Explosive death stinger — harsh atonal blast that decays */
  playDeathStinger() {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const dur = 3.0;
    const buf = this.ctx.createBuffer(2, sr * dur, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);

    // Dissonant string cluster — minor 2nds and tritones, like horror movie strings
    // Notes: E4, F4 (minor 2nd), Bb4 (tritone from E), B4 (minor 2nd from Bb), + low octave
    // Octave up from before, each note has a detune rate (Hz/s drift) and pitch drop
    const notes = [
      { freq: 659.26, amp: 0.20, decay: 1.8, pan: -0.3, detune:  12, drop: 0.97 },  // E5
      { freq: 698.46, amp: 0.22, decay: 1.6, pan:  0.3, detune: -15, drop: 0.96 },  // F5
      { freq: 932.33, amp: 0.18, decay: 2.0, pan: -0.5, detune:  18, drop: 0.95 },  // Bb5
      { freq: 987.77, amp: 0.16, decay: 1.7, pan:  0.5, detune: -20, drop: 0.97 },  // B5
      { freq: 329.63, amp: 0.15, decay: 2.5, pan:  0.0, detune:   8, drop: 0.98 },  // E4 — anchor
      { freq: 349.23, amp: 0.12, decay: 2.2, pan:  0.0, detune: -10, drop: 0.97 },  // F4
    ];

    for (let i = 0; i < L.length; i++) {
      const t = i / sr;

      // Sharp attack, long sustain that slowly dies
      const attack = 1 - Math.exp(-t * 80);
      let sampleL = 0, sampleR = 0;

      for (const n of notes) {
        const env = attack * Math.exp(-t / n.decay);
        // Pitch drops over time + progressive detuning
        const pitchMult = 1.0 + (n.drop - 1.0) * (t / dur);   // slides toward drop ratio
        const freq = n.freq * pitchMult + n.detune * t;         // detune widens over time
        // Sawtooth-ish timbre (sum of harmonics) for string-like quality
        const phase = 2 * Math.PI * freq * t;
        const fundamental = Math.sin(phase);
        const h2 = Math.sin(phase * 2) * 0.5;
        const h3 = Math.sin(phase * 3) * 0.25;
        const h4 = Math.sin(phase * 4) * 0.12;
        // Vibrato intensifies over time — increasingly unstable
        const vibrato = Math.sin(2 * Math.PI * (4.5 + t * 1.5) * t) * 0.006 * t;
        const tone = (fundamental + h2 + h3 + h4) * (1 + vibrato);

        const val = tone * env * n.amp;
        // Simple stereo panning
        const lGain = Math.cos((n.pan + 1) * Math.PI / 4);
        const rGain = Math.sin((n.pan + 1) * Math.PI / 4);
        sampleL += val * lGain;
        sampleR += val * rGain;
      }

      // Subtle low rumble underneath
      const rumble = Math.sin(2 * Math.PI * 36 * t) * 0.08 * Math.exp(-t / 2.5);

      L[i] = sampleL + rumble;
      R[i] = sampleR + rumble;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.45;
    src.connect(g).connect(this.masterGain);
    src.start();

    // Play monster growl MP3 at normal speed
    if (this.shared.deathGrowlBuf) {
      const growl = this.ctx.createBufferSource();
      growl.buffer = this.shared.deathGrowlBuf;
      growl.playbackRate.value = 1.0;
      const growlGain = this.ctx.createGain();
      growlGain.gain.value = 0.7;
      growl.connect(growlGain).connect(this.masterGain);
      growl.start();
    }

    // Kill the chase tension layer immediately
    if (this.chaseGain) this.chaseGain.gain.value = 0;
    if (this.chaseNoiseGain) this.chaseNoiseGain.gain.value = 0;
    this.chaseVolume = 0;
    this.chasePitch = 0;
    this.chaseActive = false;
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
    if (this.chaseOsc1) { try { this.chaseOsc1.stop(); } catch {} this.chaseOsc1 = null; }
    if (this.chaseOsc2) { try { this.chaseOsc2.stop(); } catch {} this.chaseOsc2 = null; }
    if (this.chaseOsc3) { try { this.chaseOsc3.stop(); } catch {} this.chaseOsc3 = null; }
    if (this.chaseOsc4) { try { this.chaseOsc4.stop(); } catch {} this.chaseOsc4 = null; }
    if (this.chaseNoiseSource) { try { this.chaseNoiseSource.stop(); } catch {} this.chaseNoiseSource = null; }
    this.ctx?.close();
  }
}
