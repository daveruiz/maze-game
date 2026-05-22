/**
 * Audio manager with per-enemy 3D audio channels.
 * Each enemy gets its own PannerNode, loop, and one-shot sources.
 * Buffers (MP3s + procedural) are loaded/generated once and shared.
 */
import soundConfig from './SoundConfig';

const IDLE_FILES    = ['idle-01.mp3', 'idle-02.mp3', 'idle-03.mp3', 'idle-04.mp3', 'idle-06.mp3'];
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

  // Constant chains loop (independent of state)
  private chainsLoop: AudioBufferSourceNode | null = null;
  private chainsGain: GainNode | null = null;          // gain node for loop 1 (speed-controlled)
  // Second chains loop — added during chase for layered texture
  private chainsLoop2: AudioBufferSourceNode | null = null;
  private chainsGain2: GainNode | null = null;         // gain node for loop 2
  private chainsBufRef: AudioBuffer | null = null;
  private chainsVolumeRef = 0.3;
  private chainsSpeedFrac = 1.0;                       // current smoothed speed fraction


  // MP3 one-shot
  private oneShot: AudioBufferSourceNode | null = null;
  private oneShotPriority: number = 0;
  private nextTriggerTime: number = 0;
  private currentState: string = '';

  // Smoothed occlusion values (avoid clicks from sudden changes)
  private currentDry = 1.0;
  private currentWet = 0.1;
  private currentCutoff = 20000;

  // Rear-source attenuation (head shadow emulation)
  private rearFilter: BiquadFilterNode;
  private rearGain: GainNode;
  private currentRearCutoff = 20000;
  private currentRearGain = 1.0;

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

    // Rear-source low-pass: emulates head shadow / pinna filtering for behind sounds
    this.rearFilter = ctx.createBiquadFilter();
    this.rearFilter.type = 'lowpass';
    this.rearFilter.frequency.value = 20000;
    this.rearFilter.Q.value = 0.5;

    // Rear-source gain: slight level drop for sounds behind the listener (~3dB)
    this.rearGain = ctx.createGain();
    this.rearGain.gain.value = 1.0;

    // Dry path: panner → occlusionFilter → rearFilter → rearGain → dryGain → master
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1.0;
    this.panner.connect(this.occlusionFilter).connect(this.rearFilter).connect(this.rearGain).connect(this.dryGain).connect(master);

    // Wet path: panner → wetGain → shared reverb bus (distant/reverberant)
    // Wet path bypasses the occlusion filter — reverb tail is naturally diffuse
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.1;
    this.panner.connect(this.wetGain).connect(reverbBus);
  }

  /** Update occlusion based on distance, wall count, confidence, and line-of-sight.
   *  hasLOS=false (enemy behind a wall) strongly attenuates the direct signal and
   *  applies a low-pass muffle — reverb tail is kept prominent so the enemy remains
   *  audible but clearly feels like it's on the other side of a wall. */
  updateOcclusion(dist: number, wallCount: number, confidence = 1.0, hasLOS = true) {
    const SMOOTH = 0.08;

    const MIN_DIST = 3, MAX_DIST = 40;
    const distT = Math.max(0, Math.min(1, (dist - MIN_DIST) / (MAX_DIST - MIN_DIST)));
    const wallT = Math.min(1, wallCount / 6);

    let targetDry: number;
    let targetWet: number;
    let targetCutoff: number;

    if (hasLOS) {
      // Visible: distance + wall count drive occlusion normally
      const occlusion  = Math.min(1, wallT * 0.7 + distT * 0.4);
      const directBoost = wallCount === 0 ? 1.2 : 1.0;
      const confScale   = 0.45 + confidence * 0.55;
      targetDry    = (1.0 - occlusion * 0.75) * directBoost * confScale;
      targetWet    = 0.1 + occlusion * 1.2 + (1.0 - confidence) * 0.5;
      targetCutoff = 20000 * Math.pow(0.25, wallT);
    } else {
      // Hidden: mostly reverb, quiet + muffled direct signal
      targetDry    = 0.12 * (0.5 + confidence * 0.5) * (1 - distT * 0.5);
      targetWet    = Math.max(0.6, 0.1 + distT * 0.8);
      targetCutoff = Math.max(800, 4000 - distT * 2500);
    }

    this.currentDry    += (targetDry    - this.currentDry)    * SMOOTH;
    this.currentWet    += (targetWet    - this.currentWet)    * SMOOTH;
    this.currentCutoff += (targetCutoff - this.currentCutoff) * SMOOTH;

    this.dryGain.gain.value              = Math.max(0, this.currentDry);
    this.wetGain.gain.value              = Math.max(0, this.currentWet);
    this.occlusionFilter.frequency.value = this.currentCutoff;
  }

  /** Update rear-source effect based on how far behind the listener the sound is.
   *  @param rearFactor 0 = in front, 1 = directly behind */
  updateRear(rearFactor: number) {
    const SMOOTH = 0.1;
    const r = Math.max(0, Math.min(1, rearFactor));

    // Low-pass: front=20kHz (open), behind=3kHz (muffled treble, pinna shadow)
    const targetCutoff = 20000 * Math.pow(0.15, r); // 20k → ~3k
    // Gain: front=1.0, behind=0.7 (~3dB head shadow)
    const targetGain = 1.0 - r * 0.3;

    this.currentRearCutoff += (targetCutoff - this.currentRearCutoff) * SMOOTH;
    this.currentRearGain   += (targetGain - this.currentRearGain) * SMOOTH;

    this.rearFilter.frequency.value = this.currentRearCutoff;
    this.rearGain.gain.value = this.currentRearGain;
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
        this.stopChainsLoop2();
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
        this.startChainsLoop2();
        break;
    }
  }

  /** Start the constant chains loop (call once after channel creation, when buffer is loaded) */
  startChainsLoop(buf: AudioBuffer, volume: number) {
    if (this.chainsLoop) return; // already playing
    this.chainsBufRef = buf;
    this.chainsVolumeRef = volume;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buf.duration;
    src.playbackRate.value = 1.0;
    const g = this.ctx.createGain();
    g.gain.value = this.chainsSpeedFrac * volume; // respect current speed
    this.chainsGain = g;
    src.connect(g).connect(this.panner);
    src.start(0, Math.random() * buf.duration);
    this.chainsLoop = src;
  }

  private startChainsLoop2() {
    if (this.chainsLoop2 || !this.chainsBufRef) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.chainsBufRef;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = this.chainsBufRef.duration;
    src.playbackRate.value = 1.0;
    const g = this.ctx.createGain();
    g.gain.value = this.chainsSpeedFrac * this.chainsVolumeRef; // respect current speed
    this.chainsGain2 = g;
    src.connect(g).connect(this.panner);
    src.start(0, Math.random() * this.chainsBufRef.duration);
    this.chainsLoop2 = src;
  }

  private stopChainsLoop2() {
    if (this.chainsLoop2) {
      try { this.chainsLoop2.stop(); } catch {}
      this.chainsLoop2 = null;
      this.chainsGain2 = null;
    }
  }

  /** Scale chains volume by enemy speed fraction (0 = stopped/silent, 1 = full chase speed) */
  updateChainsSpeed(speedFraction: number) {
    const TIME_CONST = 0.15; // seconds — smooth fade in/out
    this.chainsSpeedFrac = speedFraction; // track for when loops are (re)started
    const target = speedFraction * this.chainsVolumeRef;
    const now = this.ctx.currentTime;
    if (this.chainsGain) this.chainsGain.gain.setTargetAtTime(target, now, TIME_CONST);
    if (this.chainsGain2) this.chainsGain2.gain.setTargetAtTime(target, now, TIME_CONST);
  }

  stop() {
    this.stopLoop();
    this.stopOneShot();
    if (this.chainsLoop) {
      try { this.chainsLoop.stop(); } catch {}
      this.chainsLoop = null;
      this.chainsGain = null;
    }
    this.stopChainsLoop2();
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

  playNotice(buf: AudioBuffer | null) {
    if (!buf) return;
    if (this.oneShot && this.oneShotPriority >= 2) return; // don't interrupt alert/spotted
    this.stopOneShot(); // cut any playing idle sound — enemy is no longer casually wandering
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = PLAYBACK_RATE;
    const g = this.ctx.createGain();
    g.gain.value = 0.4;
    src.connect(g).connect(this.panner);
    src.start();
    this.oneShot = src;
    this.oneShotPriority = 2;
    src.onended = () => { if (this.oneShot === src) { this.oneShot = null; this.oneShotPriority = 0; } };
    // Push idle sounds back — enemy is alert/searching, not casually vocalising
    this.scheduleNext(IDLE_MAX_INTERVAL * 1.5, IDLE_MAX_INTERVAL * 2);
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
  jumpscareMp3s: AudioBuffer[];
  ambienceBufs: (AudioBuffer | null)[];  // per-floor ambient loops
  chainsBuf: AudioBuffer | null;         // constant enemy loop (chains)
  noticeBuf: AudioBuffer | null;         // first-detection notice sound
}

export class AudioManager {
  // ── Static preload cache (persists across restarts) ───────────────────────
  private static _preloadCache = new Map<string, ArrayBuffer>();
  private static _preloadPromise: Promise<void> | null = null;

  /** Fetch all audio file bytes upfront — no AudioContext needed, safe to call on page load.
   *  loadMp3Buffers() will use these cached bytes (decode only, no fetch). */
  static preload(): Promise<void> {
    if (AudioManager._preloadPromise) return AudioManager._preloadPromise;

    const urls: string[] = [
      ALERT_FILE,
      'death-growl.mp3',
      'notice.mp3',
      ...(soundConfig.enemyLoop ? [soundConfig.enemyLoop.file] : []),
      ...IDLE_FILES,
      ...CHASING_FILES,
      ...soundConfig.jumpscares,
      ...soundConfig.floorAmbience
        .filter((a): a is NonNullable<typeof a> => !!a)
        .map(a => a.file),
    ];

    AudioManager._preloadPromise = Promise.all(
      urls.map(url =>
        fetch(url)
          .then(r => r.arrayBuffer())
          .then(ab => { AudioManager._preloadCache.set(url, ab); })
          .catch(() => {})
      )
    ).then(() => {});

    return AudioManager._preloadPromise;
  }

  private ctx: AudioContext | null = null;
  private masterGain!: GainNode;
  private reverbSend!: GainNode;
  private enemyReverbBus!: GainNode; // shared reverb bus for per-enemy distance reverb
  private shared: SharedBuffers = {
    searchingBuf: null, chasingBuf: null, alertBuf: null, deathGrowlBuf: null,
    idleMp3s: [], chasingMp3s: [], jumpscareMp3s: [], ambienceBufs: [], chainsBuf: null, noticeBuf: null,
  };
  private channels: Map<number, EnemyChannel> = new Map();
  private nextChannelId = 0;

  // Floor ambience — multiple spatialized sources per floor
  private ambienceSources: AudioBufferSourceNode[] = [];
  private currentAmbienceFloor = -1;
  private pendingAmbienceFloor = -1;
  private pendingAmbiencePositions: { x: number; y: number; z: number }[] = [];

  init() {
    this.ctx = new AudioContext();

    // Master volume (doubled from 0.2)
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.4;

    // Soft compressor on the final output — glues everything together,
    // tames peaks from layered sounds without squashing dynamics
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;  // start compressing at -18dB
    compressor.knee.value = 12;        // soft knee — gentle transition
    compressor.ratio.value = 3;        // 3:1 — moderate, not brick-wall
    compressor.attack.value = 0.01;    // 10ms — let transients through
    compressor.release.value = 0.25;   // 250ms — smooth release
    compressor.connect(this.ctx.destination);

    // Global reverb: master → mono downmix → convolver → wet gain → compressor
    //                master → dry (direct, keeps stereo/panning) → compressor
    const convolver = this.ctx.createConvolver();
    convolver.buffer = this.generateImpulseResponse(1.6, 5.0);

    const wetGain = this.ctx.createGain();
    wetGain.gain.value = 0.75;   // reverb mix level

    // Mono downmix before convolver — reverb is a diffuse room effect,
    // it shouldn't carry stereo/HRTF positioning (critical for headphones)
    const monoGain = this.ctx.createGain();
    monoGain.channelCount = 1;
    monoGain.channelCountMode = 'explicit';

    const dryGain = this.ctx.createGain();
    dryGain.gain.value = 1.0;

    this.masterGain.connect(dryGain).connect(compressor);
    // Reverb path: master → mono downmix → convolver → wet → compressor
    this.masterGain.connect(monoGain).connect(convolver).connect(wetGain).connect(compressor);

    // Keep reference so we can adjust reverb per floor
    this.reverbSend = wetGain;

    // Per-enemy distance reverb bus: enemy wet sends → convolver → destination
    // Uses a longer, more diffuse impulse for that "distant echo" effect
    const enemyConvolver = this.ctx.createConvolver();
    enemyConvolver.buffer = this.generateImpulseResponse(2.5, 3.5);
    this.enemyReverbBus = this.ctx.createGain();
    this.enemyReverbBus.gain.value = 1.0;
    this.enemyReverbBus.connect(enemyConvolver).connect(compressor);

    // Generate procedural buffers
    this.shared.searchingBuf = this.makeSearchingBuffer();
    this.shared.chasingBuf   = this.makeChasingBuffer();
    this.footstepBuf         = this.makeFootstepBuffer();

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
        const cached = AudioManager._preloadCache.get(url);
        // slice(0) clones the buffer — decodeAudioData detaches the original
        const ab = cached ? cached.slice(0) : await (await fetch(url)).arrayBuffer();
        return await this.ctx!.decodeAudioData(ab);
      } catch (e) {
        console.warn(`Failed to load audio: ${url}`, e);
        return null;
      }
    };
    // Ambience files from config (filter out undefined floors)
    const ambienceFiles = soundConfig.floorAmbience.map(a => a?.file);

    const [alertBuf, deathGrowlBuf, noticeBuf, chainsBuf, ...rest] = await Promise.all([
      load(ALERT_FILE),
      load('death-growl.mp3'),
      load('notice.mp3'),
      soundConfig.enemyLoop ? load(soundConfig.enemyLoop.file) : Promise.resolve(null),
      ...IDLE_FILES.map(f => load(f)),
      ...CHASING_FILES.map(f => load(f)),
      ...soundConfig.jumpscares.map(f => load(f)),
      ...ambienceFiles.map(f => f ? load(f) : Promise.resolve(null)),
    ]);
    this.shared.alertBuf      = alertBuf;
    this.shared.deathGrowlBuf = deathGrowlBuf;
    this.shared.noticeBuf     = noticeBuf;
    this.shared.chainsBuf     = chainsBuf;

    const idleEnd = IDLE_FILES.length;
    const chasingEnd = idleEnd + CHASING_FILES.length;
    const jumpscareEnd = chasingEnd + soundConfig.jumpscares.length;

    this.shared.idleMp3s      = rest.slice(0, idleEnd).filter(Boolean) as AudioBuffer[];
    this.shared.chasingMp3s   = rest.slice(idleEnd, chasingEnd).filter(Boolean) as AudioBuffer[];
    this.shared.jumpscareMp3s = rest.slice(chasingEnd, jumpscareEnd).filter(Boolean) as AudioBuffer[];
    this.shared.ambienceBufs  = rest.slice(jumpscareEnd);

    // Start chains loop on any channels that were created before the buffer loaded
    if (this.shared.chainsBuf && soundConfig.enemyLoop) {
      for (const ch of this.channels.values()) {
        ch.startChainsLoop(this.shared.chainsBuf, soundConfig.enemyLoop.volume);
      }
    }

    // Retry floor ambience if it was requested before buffers were ready
    if (this.pendingAmbienceFloor >= 0 && this.currentAmbienceFloor !== this.pendingAmbienceFloor) {
      this.setFloorAmbience(this.pendingAmbienceFloor, this.pendingAmbiencePositions);
    }
  }

  resume() { this.ctx?.resume(); }
  suspend() { this.ctx?.suspend(); }

  /** Create a new audio channel for an enemy. Returns channel ID. */
  createChannel(): number {
    if (!this.ctx) return -1;
    const id = this.nextChannelId++;
    const ch = new EnemyChannel(this.ctx, this.masterGain, this.enemyReverbBus);
    // Start chains loop immediately if buffer is already loaded
    if (this.shared.chainsBuf && soundConfig.enemyLoop) {
      ch.startChainsLoop(this.shared.chainsBuf, soundConfig.enemyLoop.volume);
    }
    this.channels.set(id, ch);
    return id;
  }

  /** Update position of an enemy channel */
  setChannelPosition(id: number, x: number, y: number, z: number) {
    this.channels.get(id)?.setPosition(x, y, z);
  }

  /** Update per-enemy sound occlusion (distance + wall count + confidence → reverb mix + muffle) */
  updateChannelOcclusion(id: number, dist: number, wallCount: number, confidence = 1.0, hasLOS = true) {
    this.channels.get(id)?.updateOcclusion(dist, wallCount, confidence, hasLOS);
  }

  /** Update rear-source attenuation for a channel (0=front, 1=behind) */
  updateChannelRear(id: number, rearFactor: number) {
    this.channels.get(id)?.updateRear(rearFactor);
  }

  /** Update state of an enemy channel */
  playChannelState(id: number, state: 'searching' | 'spotted' | 'chasing') {
    this.channels.get(id)?.playState(state, this.shared);
  }

  /** Stop an enemy channel */
  stopChannel(id: number) {
    this.channels.get(id)?.stop();
  }

  /** Scale chains volume by enemy movement speed (0 = stopped, 1 = full chase speed). Call every frame. */
  updateChannelSpeed(id: number, speedFraction: number) {
    this.channels.get(id)?.updateChainsSpeed(speedFraction);
  }

  /** Ensure the chains loop is running for a channel (restarts if killed while off-floor). */
  startChannelChains(id: number) {
    if (!this.shared.chainsBuf || !soundConfig.enemyLoop) return;
    this.channels.get(id)?.startChainsLoop(this.shared.chainsBuf, soundConfig.enemyLoop.volume);
  }

  /** Play the notice sound for a channel (first detection stab) */
  playChannelNotice(id: number) {
    this.channels.get(id)?.playNotice(this.shared.noticeBuf);
  }

  /** Stop all enemy channels */
  stopEnemySound() {
    for (const ch of this.channels.values()) ch.stop();
    this.channels.clear();
    this.nextChannelId = 0;
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

  // ── Player audibility tracking ─────────────────────────────────────────────
  private _playerAudibility = 0;
  private static readonly AUDIBILITY_SCALE = 8.0; // maps gain values to 0..1 range

  /** Instant-attack: register a sound by its raw gain value (auto-scaled to 0..1). */
  reportPlayerSound(gain: number) {
    const level = Math.min(1, gain * AudioManager.AUDIBILITY_SCALE);
    if (level > this._playerAudibility) this._playerAudibility = level;
  }

/** Decay audibility toward zero — call once per frame. */
  tickAudibility(dt: number) {
    const DECAY = 2.0; // units/s — sprint stays elevated between steps; walk pulses clearly
    this._playerAudibility = Math.max(0, this._playerAudibility - DECAY * dt);
  }

  get playerAudibility(): number { return this._playerAudibility; }

  // ── Footsteps ──────────────────────────────────────────────────────────

  private footstepBuf: AudioBuffer | null = null;
  private footstepTimer = 0;
  private footstepPhase = 0; // alternates left/right for stereo variation

  /** Call once after init to generate the footstep buffer */
  private makeFootstepBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const dur = 0.02; // very short tap
    const buf = ctx.createBuffer(1, Math.ceil(sr * dur), sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      // Sharp attack, fast decay
      const env = Math.exp(-t * 200) * (1 - Math.exp(-t * 4000));
      // Kick-like thump — mostly low-end, minimal noise
      const tap = Math.sin(2 * Math.PI * 60 * t) * 0.6
                + Math.sin(2 * Math.PI * 120 * t) * 0.3
                + (Math.random() - 0.5) * 0.1;
      data[i] = tap * env;
    }
    return buf;
  }

  /**
   * Tick footsteps based on player speed. Call every frame with dt.
   * @param dt        Frame delta time
   * @param speed     Current horizontal speed
   * @param maxSpeed  Max speed (for interval scaling)
   * @param onGround  Is the player on the ground?
   * @param justLanded Did the player just land this frame?
   */
  updateFootsteps(dt: number, speed: number, maxSpeed: number, onGround: boolean, justLanded: boolean, landingImpact = 0, crouching = false) {
    if (!this.ctx || !this.footstepBuf) return;

    // Landing thump — volume proportional to fall speed so obstacle drops (~6.4 u/s)
    // are naturally quieter than full jumps (~9 u/s) or hard falls (~12+ u/s)
    if (justLanded && landingImpact > 1) {
      const vol = Math.min(1.0, landingImpact / 12);
      this.playFootstep(1.0, vol);
      this.footstepTimer = 0;
      return;
    }

    // No walking footsteps when crouching, airborne, or stationary
    if (crouching || !onGround || speed < 0.5) {
      this.footstepTimer = 0;
      return;
    }

    const speedT = Math.min(1, speed / maxSpeed);
    // Step interval: slow walk ~0.625s → sprint ~0.375s (25% slower)
    const interval = 0.625 - speedT * 0.25;

    this.footstepTimer += dt;
    if (this.footstepTimer >= interval) {
      this.footstepTimer -= interval;
      this.playFootstep(speedT);
    }
  }

  private playFootstep(speedT: number, volumeMult = 1.0) {
    if (!this.ctx || !this.footstepBuf) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.footstepBuf;

    // Pitch: walking stays neutral, landings slightly higher (snappier impact)
    const impactPitch = volumeMult > 1 ? 1.0 + (volumeMult - 1) * 0.15 : 1.0;
    const basePitch = 1.0; // keep walking pitch neutral
    src.playbackRate.value = (basePitch + (Math.random() - 0.5) * 0.1) * 0.25 * impactPitch; // 2 octaves down

    // Stereo panner: alternate left/right foot
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = (this.footstepPhase % 2 === 0 ? -0.15 : 0.15);
    this.footstepPhase++;

    // Volume scales with speed — louder when sprinting
    const gain = this.ctx.createGain();
    const gainValue = (0.015 + speedT * 0.12) * volumeMult; // quieter walk → 0.135 sprint
    gain.gain.value = gainValue;
    this.reportPlayerSound(gainValue);

    src.connect(gain).connect(panner).connect(this.masterGain);
    src.start();
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

  // ── Proximity tension (low-pitch growl — one octave below chase shriek) ───

  private proxOsc1: OscillatorNode | null = null;
  private proxOsc2: OscillatorNode | null = null;
  private proxOsc3: OscillatorNode | null = null;
  private proxOsc4: OscillatorNode | null = null;
  private proxGain: GainNode | null = null;
  private proxNoiseGain: GainNode | null = null;
  private proxNoiseSource: AudioBufferSourceNode | null = null;
  private proxFilter: BiquadFilterNode | null = null;
  private proxPitch = 0;
  private proxVolume = 0;

  private initProximityLayer() {
    if (!this.ctx || this.proxOsc1) return;

    const BASE_FREQ = 200; // one octave below chase (400Hz)

    this.proxOsc1 = this.ctx.createOscillator();
    this.proxOsc1.type = 'sawtooth';
    this.proxOsc1.frequency.value = BASE_FREQ;

    this.proxOsc2 = this.ctx.createOscillator();
    this.proxOsc2.type = 'sawtooth';
    this.proxOsc2.frequency.value = BASE_FREQ + 1.5;

    this.proxOsc3 = this.ctx.createOscillator();
    this.proxOsc3.type = 'sawtooth';
    this.proxOsc3.frequency.value = BASE_FREQ;

    this.proxOsc4 = this.ctx.createOscillator();
    this.proxOsc4.type = 'sawtooth';
    this.proxOsc4.frequency.value = BASE_FREQ + 1.5;

    // Low-pass to keep it dark and rumbly (opposite of chase's highpass)
    this.proxFilter = this.ctx.createBiquadFilter();
    this.proxFilter.type = 'lowpass';
    this.proxFilter.frequency.value = 800;
    this.proxFilter.Q.value = 2;

    this.proxGain = this.ctx.createGain();
    this.proxGain.gain.value = 0;

    this.proxOsc1.connect(this.proxFilter);
    this.proxOsc2.connect(this.proxFilter);
    this.proxOsc3.connect(this.proxFilter);
    this.proxOsc4.connect(this.proxFilter);
    this.proxFilter.connect(this.proxGain);

    // Dry/wet routing with reverb
    const proxDry = this.ctx.createGain();
    proxDry.gain.value = 0.3;

    const proxConvolver = this.ctx.createConvolver();
    proxConvolver.buffer = this.generateImpulseResponse(2.0, 4.5);

    const proxWet = this.ctx.createGain();
    proxWet.gain.value = 1.5;

    this.proxGain.connect(proxDry).connect(this.masterGain);
    this.proxGain.connect(proxConvolver).connect(proxWet).connect(this.masterGain);

    // Noise layer for low rumble texture
    const sr = this.ctx.sampleRate;
    const noiseBuf = this.ctx.createBuffer(1, sr * 2, sr);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) {
      nd[i] = (Math.random() - 0.5) * 0.5;
    }
    this.proxNoiseSource = this.ctx.createBufferSource();
    this.proxNoiseSource.buffer = noiseBuf;
    this.proxNoiseSource.loop = true;

    this.proxNoiseGain = this.ctx.createGain();
    this.proxNoiseGain.gain.value = 0;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 300;
    noiseFilter.Q.value = 1.0;

    this.proxNoiseSource.connect(noiseFilter);
    noiseFilter.connect(this.proxNoiseGain);
    this.proxNoiseGain.connect(proxDry);
    this.proxNoiseGain.connect(proxConvolver);

    this.proxOsc1.start();
    this.proxOsc2.start();
    this.proxOsc3.start();
    this.proxOsc4.start();
    this.proxNoiseSource.start();
  }

  /** Call every frame with distance to nearest enemy (any state, not just chasing).
   *  Low growl that rises in pitch and volume as enemies get close. */
  updateProximityTension(nearestDist: number) {
    if (!this.ctx) return;
    this.initProximityLayer();
    if (!this.proxOsc1 || !this.proxOsc2 || !this.proxOsc3 || !this.proxOsc4 ||
        !this.proxGain || !this.proxNoiseGain) return;

    const BASE_FREQ = 200;
    const MAX_DIST = 20;
    const MIN_DIST = 2;

    if (nearestDist >= 0 && nearestDist < MAX_DIST) {
      const prox = 1.0 - Math.max(0, Math.min(1, (nearestDist - MIN_DIST) / (MAX_DIST - MIN_DIST)));

      // Quadratic pitch and volume scaling
      const targetPitch = prox * prox;
      this.proxPitch += (targetPitch - this.proxPitch) * 0.06;

      // Note 1: base freq rises up to 2 semitones
      const semitoneShift = this.proxPitch * 2;
      const freq1 = BASE_FREQ * Math.pow(AudioManager.SEMITONE_RATIO, semitoneShift);
      this.proxOsc1.frequency.value = freq1;
      this.proxOsc2.frequency.value = freq1 + 1.5;

      // Note 2: detuned by up to 1 semitone
      const stDetune = this.proxPitch * 4;
      const freq2 = freq1 * Math.pow(AudioManager.QUARTER_ST_RATIO, stDetune);
      this.proxOsc3.frequency.value = freq2;
      this.proxOsc4.frequency.value = freq2 + 1.5;

      // Volume: quadratic, starting from 0
      const targetVol = prox * prox * 0.025;
      this.proxVolume += (targetVol - this.proxVolume) * 0.08;
      this.proxGain.gain.value = this.proxVolume;
      this.proxNoiseGain.gain.value = this.proxVolume * 0.5;

      // Filter opens as it gets closer
      this.proxFilter!.frequency.value = 400 + prox * 600;

    } else {
      // Fade out
      this.proxVolume *= 0.92;
      this.proxPitch *= 0.95;
      if (this.proxVolume < 0.001) this.proxVolume = 0;
      this.proxGain.gain.value = this.proxVolume;
      this.proxNoiseGain.gain.value = this.proxVolume * 0.5;

      if (this.proxVolume === 0) {
        this.proxOsc1.frequency.value = BASE_FREQ;
        this.proxOsc2.frequency.value = BASE_FREQ + 1.5;
        this.proxOsc3.frequency.value = BASE_FREQ;
        this.proxOsc4.frequency.value = BASE_FREQ + 1.5;
      }
    }
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

    // Play a random jumpscare sound on top
    if (this.shared.jumpscareMp3s.length > 0) {
      const idx = Math.floor(Math.random() * this.shared.jumpscareMp3s.length);
      const js = this.ctx.createBufferSource();
      js.buffer = this.shared.jumpscareMp3s[idx];
      const jsGain = this.ctx.createGain();
      jsGain.gain.value = 0.8;
      js.connect(jsGain).connect(this.masterGain);
      js.start();
    }

    // Kill the chase tension layer immediately
    if (this.chaseGain) this.chaseGain.gain.value = 0;
    if (this.chaseNoiseGain) this.chaseNoiseGain.gain.value = 0;
    this.chaseVolume = 0;
    this.chasePitch = 0;
    this.chaseActive = false;
    // Kill proximity tension too
    if (this.proxGain) this.proxGain.gain.value = 0;
    if (this.proxNoiseGain) this.proxNoiseGain.gain.value = 0;
    this.proxVolume = 0;
    this.proxPitch = 0;
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
      // Mostly percussive noise with a subtle tonal hint
      data[i] = (Math.sin(2 * Math.PI * freq * t) * 0.05
              + (Math.random() - 0.5) * 0.6) * env * env;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.03;  // ~5% volume
    this.reportPlayerSound(0.03);
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

  /**
   * Start or switch spatialized floor ambience. Each source is placed at a
   * different position and starts at a random offset for variation.
   * @param positions World-space positions for each source (from MapDistribution)
   */
  setFloorAmbience(floorIndex: number, positions: { x: number; y: number; z: number }[]) {
    if (!this.ctx || floorIndex === this.currentAmbienceFloor) return;

    // Always store latest request so we can retry after buffers load
    this.pendingAmbienceFloor = floorIndex;
    this.pendingAmbiencePositions = positions;

    const buf = this.shared.ambienceBufs[floorIndex];
    const config = soundConfig.floorAmbience[floorIndex];
    // If buffer hasn't loaded yet, don't update currentAmbienceFloor so we retry after load
    if (!buf || !config) return;

    // Stop current ambience sources
    this.stopAmbience();
    this.currentAmbienceFloor = floorIndex;

    const count = Math.min(config.sources, positions.length);
    for (let i = 0; i < count; i++) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      // Spatialized panner — HRTF for realistic 3D positioning
      const panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 3;
      panner.maxDistance = 60;
      panner.rolloffFactor = 1.5;
      panner.setPosition(positions[i].x, positions[i].y, positions[i].z);

      const gain = this.ctx.createGain();
      gain.gain.value = config.volume;

      src.connect(panner).connect(gain).connect(this.masterGain);

      // Start at a random offset so sources are out of phase
      const offset = Math.random() * buf.duration;
      src.start(0, offset);
      this.ambienceSources.push(src);
    }
  }

  stopAmbience() {
    for (const src of this.ambienceSources) {
      try { src.stop(); } catch {}
    }
    this.ambienceSources = [];
    this.currentAmbienceFloor = -1;
  }

  /** Silence every sound source without closing the AudioContext (safe to restart). */
  stopAll() {
    this.stopEnemySound();
    if (this.droneSource) { try { this.droneSource.stop(); } catch {} this.droneSource = null; }
    if (this.flickerSource) { try { this.flickerSource.stop(); } catch {} this.flickerSource = null; }
    if (this.chaseOsc1) { try { this.chaseOsc1.stop(); } catch {} this.chaseOsc1 = null; }
    if (this.chaseOsc2) { try { this.chaseOsc2.stop(); } catch {} this.chaseOsc2 = null; }
    if (this.chaseOsc3) { try { this.chaseOsc3.stop(); } catch {} this.chaseOsc3 = null; }
    if (this.chaseOsc4) { try { this.chaseOsc4.stop(); } catch {} this.chaseOsc4 = null; }
    if (this.chaseNoiseSource) { try { this.chaseNoiseSource.stop(); } catch {} this.chaseNoiseSource = null; }
    if (this.proxOsc1) { try { this.proxOsc1.stop(); } catch {} this.proxOsc1 = null; }
    if (this.proxOsc2) { try { this.proxOsc2.stop(); } catch {} this.proxOsc2 = null; }
    if (this.proxOsc3) { try { this.proxOsc3.stop(); } catch {} this.proxOsc3 = null; }
    if (this.proxOsc4) { try { this.proxOsc4.stop(); } catch {} this.proxOsc4 = null; }
    if (this.proxNoiseSource) { try { this.proxNoiseSource.stop(); } catch {} this.proxNoiseSource = null; }
    this.stopAmbience();
    // Zero out master gain to kill any lingering scheduled notes / tails
    if (this.masterGain) this.masterGain.gain.value = 0;
  }

  /** Restore master gain after stopAll (called on restart). */
  resumeAudio() {
    if (this.masterGain) this.masterGain.gain.value = 0.4;
  }

  dispose() {
    this.stopAll();
    this.ctx?.close();
  }
}
