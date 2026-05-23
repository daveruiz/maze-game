import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { MazeGenerator, MazeRenderer, WALL_HEIGHT, CELL_SIZE } from './Maze';
import { Player } from './Player';
import { Enemy } from './Enemy';
import { Item, ItemType } from './Item';
import { AudioManager } from './AudioManager';
import { EnemyState } from './types';
import { HorrorShader } from './HorrorShader';
import { MobileControls } from './MobileControls';
import { inputMode, isMobileDevice } from './InputMode';
import { GamepadManager } from './GamepadManager';
import { distributePositions } from './MapDistribution';
import soundConfig from './SoundConfig';
import { computeSoundField, computeSoundEnergies } from './SoundField';

const NUM_FLOORS = 3;

// Flashlight drain/recharge rates (% per second)
const FLASHLIGHT_DRAIN   = 5;
const FLASHLIGHT_CHARGE  = 5;

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene:    THREE.Scene;
  private camera:   THREE.PerspectiveCamera;
  private maze:     MazeGenerator;
  private mazeRenderer: MazeRenderer;
  private player!:  Player;
  private enemies:  Enemy[] = [];
  private audio:    AudioManager;
  private lights:   THREE.Light[] = [];
  private composer!:    EffectComposer;
  private horrorPass!:  ShaderPass;
  private clock = new THREE.Clock();
  private running = false;
  private raf = 0;

  // Flashlight
  private flashlight!:    THREE.SpotLight;
  private flashlightOn  = false;
  private flashBattery  = 100;
  private torchLight!:   THREE.PointLight; // very dim ambient torch (replaces flashlight when dead)
  private debugLight    = false;
  private debugRevealMap = false;
  private debugFastForward = false;
  private debugSoundField = false;
  private debugInfiniteResources = false;
  private debugAmbient!: THREE.AmbientLight;
  private debugMenuOpen = false;
  private mobileControls: MobileControls | null = null;
  private gamepad: GamepadManager;

  // Floor culling
  private currentVisibleFloor = -1;
  /** Per-floor lights (for culling) */
  private floorLights: THREE.Light[][] = [];
  private globalLights: THREE.Light[] = [];  // lights that are always visible
  /** Fixed pool of lantern lights repositioned each frame to nearest lanterns */
  private lanternPool: THREE.PointLight[] = [];
  private readonly LANTERN_POOL_SIZE = 8;
  private readonly LANTERN_PARK_Y = -1000;

  // Death animation
  private dying = false;
  private deathTimer = 0;
  private deathEnemy: Enemy | null = null;
  private deathYaw = 0;
  private deathPitch = 0;
  private deathStartPos = new THREE.Vector3();
  private deathMaxStumble = 0.6;
  private deathHitApplied = false;

  // Items
  private items: Item[] = [];
  /** Per-floor collected items */
  private collected: Record<number, Set<ItemType>> = {};

  // Sound pings for compass minimap (enemy sounds → temporary dots)
  private soundPings: { x: number; z: number; floor: number; time: number }[] = [];
  private prevEnemyStates: Map<Enemy, EnemyState> = new Map();
  private enemySoundTimers: Map<Enemy, number> = new Map();

  // HUD
  private minimapCtx:        CanvasRenderingContext2D;
  private minimapCanvas:     HTMLCanvasElement;
  private hudEl:             HTMLElement;
  private floorTextEl:       HTMLElement;
  private staminaHudEl!:     HTMLElement;
  private staminaIconEl!:    HTMLElement;
  private batteryLowEl!:     HTMLElement;
  private messageEl:         HTMLElement;
  private batteryFillEl!:    HTMLElement;
  private batteryIconEl!:    HTMLElement;
  private itemKeyEl!:        HTMLElement;
  private itemMapEl!:        HTMLElement;
  private itemCompassEl!:    HTMLElement;
  private keyNeededEl!:      HTMLElement;
  private staminaFillEl!:      HTMLElement;
  private suspicionDebugEl!:   HTMLElement;
  private visibilityFillEl!:   HTMLElement;
  private visibilityIconEl!:   HTMLElement;
  private noiseFillEl!:        HTMLElement;
  private noiseIconEl!:        HTMLElement;
  private noiseHudEl!:         HTMLElement;
  private visibilityHudEl!:    HTMLElement;
  // Crosshair-adjacent indicators (always visible)
  private ciVisibilityEl!:     HTMLElement;
  private ciNoiseEl!:          HTMLElement;

  // Haptic feedback
  private vibrationEnabled = false;
  private vibrationTimer   = 0;

  // Microphone
  private micEnabled       = false;
  private micReverbEnabled = false;

  // Unified player visibility (0=dark/hidden, 1=fully lit) — computed each frame
  private playerVisibility = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    // Default 4× downscale for performance; debug menu can adjust
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) / 4);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap; // hard shadows, cheapest
    container.appendChild(this.renderer.domElement);

    // Camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 1000);

    // Scene — camera must be added for spotlight target to work
    this.scene = new THREE.Scene();
    this.scene.add(this.camera);

    // Flashlight (SpotLight on camera) — casts hard shadows from enemies
    this.flashlight = new THREE.SpotLight(0xffffff, 28.0, 140, Math.PI / 4, 0.4, 1.0);
    this.flashlight.position.set(0, -0.15, 0);
    this.flashlight.target.position.set(0, -0.1, -1);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(512, 512);
    this.flashlight.shadow.camera.near = 0.5;
    this.flashlight.shadow.camera.far = 40;
    this.flashlight.shadow.bias = -0.002;
    this.camera.add(this.flashlight);
    this.camera.add(this.flashlight.target);

    // Dim torch glow (always on, mimics ambient bounce near player)
    this.torchLight = new THREE.PointLight(0xc4a68a, 1.2, 10);  // desaturated warm (70% less saturation)
    this.torchLight.position.set(0, -0.3, -0.4);
    this.camera.add(this.torchLight);

    // Post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.horrorPass = new ShaderPass(HorrorShader);
    this.composer.addPass(this.horrorPass);

    // Maze
    this.maze        = new MazeGenerator();
    this.mazeRenderer = new MazeRenderer();

    this.audio = new AudioManager();

    // HUD
    this.hudEl            = document.getElementById('hud')!;
    this.floorTextEl      = document.getElementById('floor-text')!;
    this.staminaHudEl     = document.getElementById('stamina-hud')!;
    this.staminaIconEl    = document.getElementById('stamina-icon')!;
    this.batteryLowEl     = document.getElementById('battery-low')!;
    this.messageEl        = document.getElementById('message')!;
    this.batteryFillEl    = document.getElementById('battery-fill')!;
    this.batteryIconEl    = document.getElementById('battery-icon')!;

    this.minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
    this.minimapCtx    = this.minimapCanvas.getContext('2d')!;

    this.itemKeyEl     = document.getElementById('item-key')!;
    this.itemMapEl     = document.getElementById('item-map')!;
    this.itemCompassEl = document.getElementById('item-compass')!;
    this.keyNeededEl   = document.getElementById('key-needed')!;
    this.staminaFillEl      = document.getElementById('stamina-fill')!;
    this.suspicionDebugEl   = document.getElementById('suspicion-debug')!;
    this.visibilityFillEl   = document.getElementById('visibility-fill')!;
    this.visibilityIconEl   = document.getElementById('visibility-icon')!;
    this.noiseFillEl        = document.getElementById('noise-fill')!;
    this.noiseIconEl        = document.getElementById('noise-icon')!;
    this.noiseHudEl         = document.getElementById('noise-hud')!;
    this.visibilityHudEl    = document.getElementById('visibility-hud')!;
    this.ciVisibilityEl     = document.getElementById('ci-visibility')!;
    this.ciNoiseEl          = document.getElementById('ci-noise')!;

    // Debug full-bright light (added to scene on demand)
    this.debugAmbient = new THREE.AmbientLight(0xffffff, 6);

    // Flashlight toggle + keyboard/mouse reclaims control from gamepad
    document.addEventListener('keydown', e => {
      this.gamepad.onKeyboardInput();
      if (e.code === 'KeyF' && !e.repeat) this.toggleFlashlight();
      if (e.code === 'Backquote' && !e.repeat) this.toggleDebugMenu();
    });
    document.addEventListener('mousemove', () => {
      this.gamepad.onKeyboardInput();
    });
    document.addEventListener('mousedown', e => {
      if (e.button === 0) {
        const debugMenu = document.getElementById('debug-menu');
        if (debugMenu && debugMenu.contains(e.target as Node)) return; // ignore clicks on debug menu
        this.toggleFlashlight();
      }
    });

    this.setupDebugMenu();

    // Input mode detection (touch vs mouse — switches dynamically)
    inputMode.install();

    // Gamepad support
    this.gamepad = new GamepadManager({
      toggleFlashlight: () => this.toggleFlashlight()
    });

    window.addEventListener('resize', this.onResize.bind(this));
  }

  start() {
    this.audio.init();
    this.audio.resume();

    this.maze.generate();
    this.mazeRenderer.build(this.maze, this.scene);

    this.buildLights();

    this.player = new Player(this.camera, this.maze);
    this.player.spawn(0);

    // Spawn collectible items first (so we know key positions for enemy placement)
    this.items = [];
    this.collected = {};
    const keyPositions: Record<number, THREE.Vector3> = {};
    for (let fi = 0; fi < NUM_FLOORS; fi++) {
      this.collected[fi] = new Set();
      const itemCells = this.maze.getItemCells(fi, 3);
      const types: ItemType[] = ['key', 'map', 'compass'];
      for (let i = 0; i < types.length && i < itemCells.length; i++) {
        const cell = itemCells[i];
        const wp = this.maze.cellToWorld(cell.x, cell.z, fi);
        const item = new Item(this.scene, types[i], wp, fi);
        this.items.push(item);
        if (types[i] === 'key') keyPositions[fi] = wp.clone();
      }
    }

    // Collect interest points per floor (key, stairs, exit) for enemy spawning
    const interestPoints: Record<number, THREE.Vector3[]> = {};
    for (let fi = 0; fi < NUM_FLOORS; fi++) {
      const pts: THREE.Vector3[] = [];
      if (keyPositions[fi]) pts.push(keyPositions[fi]);
      // Find stairs and exit cells
      const floor = this.maze.floors[fi];
      for (let z = 0; z < floor.height; z++) {
        for (let x = 0; x < floor.width; x++) {
          const c = floor.cells[z][x];
          if (c.stairs === 'up' || c.isExit) {
            pts.push(this.maze.cellToWorld(x, z, fi));
          }
        }
      }
      interestPoints[fi] = pts;
    }

    // Spawn enemies near interest points (key, stairs, exit)
    const ENEMIES_PER_FLOOR = [1, 3, 6];
    this.enemies = [];
    this.soundPings = [];
    this.prevEnemyStates.clear();
    this.enemySoundTimers.clear();
    for (let fi = 0; fi < NUM_FLOORS; fi++) {
      const count = ENEMIES_PER_FLOOR[fi] ?? 1;
      const floorPositions: THREE.Vector3[] = [];
      for (let i = 0; i < count; i++) {
        const enemy = new Enemy(this.scene, this.maze, this.audio);
        enemy.setPatrolZone(i);
        enemy.spawn(fi, floorPositions, interestPoints[fi] ?? []);
        floorPositions.push(enemy.getPosition());
        this.enemies.push(enemy);
      }
    }
    // Wire up sibling references so enemies can separate and alert each other
    for (const enemy of this.enemies) {
      enemy.setSiblings(this.enemies);
    }

    this.flashBattery  = 100;
    this.flashlightOn  = true;

    // Floor culling — show only floor 0 at start
    this.currentVisibleFloor = -1;
    this.setVisibleFloor(0);

    // Reset death state
    this.dying = false;
    this.deathTimer = 0;
    this.deathEnemy = null;
    this.horrorPass.uniforms['vhsIntensity'].value = 0;

    this.hudEl.style.display = 'block';

    // Touch controls (always init — they show/hide reactively based on input mode)
    if (!this.mobileControls) {
      this.mobileControls = new MobileControls(this.player, {
        toggleFlashlight: () => this.toggleFlashlight()
      });
      this.mobileControls.init();
    } else {
      this.mobileControls.setPlayer(this.player);
      if (inputMode.isTouch) this.mobileControls.show();
    }

    // Gamepad: update player reference
    this.gamepad.setPlayer(this.player);

    // Fullscreen CTA only on actual mobile hardware
    if (isMobileDevice()) {
      this.mobileControls.showCTAIfNeeded();
    }

    // Desktop mouse: request pointer lock
    if (!inputMode.isTouch) {
      this.player.requestLock();
    }

    // Read vibration preference from checkbox
    const vibCb = document.getElementById('vibration-cb') as HTMLInputElement | null;
    this.vibrationEnabled = vibCb?.checked ?? false;

    // Read mic preferences and request permission if needed
    const micCb      = document.getElementById('mic-cb')        as HTMLInputElement | null;
    const micRevCb   = document.getElementById('mic-reverb-cb') as HTMLInputElement | null;
    this.micEnabled       = micCb?.checked ?? false;
    this.micReverbEnabled = micRevCb?.checked ?? false;
    if (this.micEnabled) {
      this.setupMicrophone();
    } else {
      this.audio.disconnectMicrophone();
    }

    this.running = true;
    this.clock.start();
    this.loop();
  }

  private buildLights() {
    this.lights.forEach(l => this.scene.remove(l));
    this.lights = [];
    this.floorLights = [];
    this.globalLights = [];

    // Global fill — ensures nothing is ever pitch black
    const ambient = new THREE.AmbientLight(0x555555, 7.0);
    this.scene.add(ambient);
    this.lights.push(ambient);
    this.globalLights.push(ambient);

    this.maze.floors.forEach((floor, fi) => {
      const flLights: THREE.Light[] = [];
      const yMid = fi * (WALL_HEIGHT + 1.0) + WALL_HEIGHT / 2;
      const theme = floor.theme;

      // Floor 0 = full brightness, floors 1+ = half
      const brightScale = fi === 0 ? 1.0 : 0.5;

      // Hemisphere (sky/ground) per floor
      const hemi = new THREE.HemisphereLight(theme.ambientColor, 0x000000, 3.0 * brightScale);
      hemi.position.y = yMid;
      this.scene.add(hemi);
      this.lights.push(hemi);
      flLights.push(hemi);

      // Sparse point lights spread across floor — scale with map size
      const W = floor.width, H = floor.height;
      const GRID = floor.type === 'village' ? 12 : floor.type === 'house' ? 6 : 4;
      const countX = Math.max(2, Math.floor(W / GRID));
      const countZ = Math.max(2, Math.floor(H / GRID));
      for (let iz = 0; iz < countZ; iz++) {
        for (let ix = 0; ix < countX; ix++) {
          const lx = Math.floor((ix + 0.5) * W / countX) * CELL_SIZE;
          const lz = Math.floor((iz + 0.5) * H / countZ) * CELL_SIZE;
          const light = new THREE.PointLight(theme.lightColor, 4.5 * brightScale, 50);
          light.position.set(lx, yMid + 0.3, lz);
          this.scene.add(light);
          this.lights.push(light);
          flLights.push(light);
        }
      }
      this.floorLights[fi] = flLights;
    });

    // Pass floor lights to maze renderer too
    this.mazeRenderer.floorLights = this.floorLights;

    // Create a fixed pool of lantern lights (reused each frame for nearest lanterns)
    // First 2 cast shadows (closest to player), rest are light-only
    this.lanternPool = [];
    for (let i = 0; i < this.LANTERN_POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xbfa687, 45.0, 18, 1.5);
      light.position.set(0, this.LANTERN_PARK_Y, 0);
      if (i < 2) {
        light.castShadow = true;
        light.shadow.mapSize.set(256, 256);
        light.shadow.camera.near = 0.3;
        light.shadow.camera.far = 18;
        light.shadow.bias = -0.003;
      }
      this.scene.add(light);
      this.lanternPool.push(light);
      this.lights.push(light);
    }

    this.updateFog(0);
  }

  private updateFog(floorIdx: number) {
    const theme = this.maze.floors[floorIdx].theme;
    this.scene.fog = new THREE.FogExp2(theme.fogColor, theme.fogDensity);
    this.renderer.setClearColor(theme.fogColor);

    // Scale global ambient per floor — floors 2/3 have brighter materials so need less fill
    const ambientScale = floorIdx === 0 ? 7.0 : 3.0;
    if (this.globalLights[0]) (this.globalLights[0] as THREE.AmbientLight).intensity = ambientScale;

    // Reverb per floor: catacombs = very reverberant, house = moderate, village = open air
    const reverbLevels = [1.2, 0.65, 0.35];
    this.audio.setReverbLevel(reverbLevels[floorIdx] ?? 0.3);

    // Floor ambience (from SoundConfig)
    const ambCfg = soundConfig.floorAmbience[floorIdx];
    const floor = this.maze.floors[floorIdx];
    const ambiencePositions = ambCfg
      ? distributePositions(ambCfg.sources, floor.width, floor.height, WALL_HEIGHT * floorIdx)
      : [];
    this.audio.setFloorAmbience(floorIdx, ambiencePositions);
  }

  private loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const rawDt = Math.min(this.clock.getDelta(), 0.05);
    const dt = this.debugFastForward ? rawDt * 3 : rawDt;
    const t  = this.clock.getElapsedTime();

    // ── Death animation ──────────────────────────────────────────────────
    if (this.dying) {
      this.deathTimer += dt;
      // VHS ramp: 0→1 over 2 seconds
      const vhs = Math.min(1.0, this.deathTimer / 2.0);
      this.horrorPass.uniforms['vhsIntensity'].value = vhs;

      // Camera stumble: small backward step away from enemy + shake
      if (this.deathEnemy) {
        const ep = this.deathEnemy.getPosition();
        const pp = this.player.getPosition();
        const dx = ep.x - pp.x, dz = ep.z - pp.z;
        const hDist = Math.sqrt(dx * dx + dz * dz);

        // Direction away from enemy (normalized)
        const awayX = hDist > 0.01 ? -dx / hDist : 0;
        const awayZ = hDist > 0.01 ? -dz / hDist : 0;

        // Stumble backward: ease-out over 1s, max 0.6 units back (subtle)
        const stumbleT = Math.min(1, this.deathTimer / 1.0);
        const stumbleEased = 1 - (1 - stumbleT) * (1 - stumbleT); // ease-out
        // Cap distance by wall check — don't push through walls
        const maxStumble = this.deathMaxStumble;
        const stumbleDist = stumbleEased * maxStumble;
        const camX = this.deathStartPos.x + awayX * stumbleDist;
        const camZ = this.deathStartPos.z + awayZ * stumbleDist;

        // Camera shake: rapid random offsets that decay over time
        const shakeIntensity = Math.min(1, this.deathTimer / 0.3) * Math.max(0, 1 - this.deathTimer / 2.5);
        const shakeX = (Math.sin(this.deathTimer * 37.3) * Math.cos(this.deathTimer * 23.1)) * 0.03 * shakeIntensity;
        const shakeY = (Math.cos(this.deathTimer * 41.7) * Math.sin(this.deathTimer * 29.3)) * 0.02 * shakeIntensity;

        // Also sink camera slightly (stumble down)
        const sinkY = stumbleEased * 0.15;

        this.camera.position.set(
          camX + shakeX,
          this.deathStartPos.y - sinkY + shakeY,
          camZ,
        );

        // Before the hit: fast lerp toward enemy's head so camera faces them
        if (!this.deathHitApplied) {
          const headPos = this.deathEnemy.getHeadPosition();
          const cdx = headPos.x - this.camera.position.x;
          const cdz = headPos.z - this.camera.position.z;
          const targetYaw = Math.atan2(-cdx, -cdz);
          const cdy = headPos.y - this.camera.position.y;
          const cHDist = Math.sqrt(cdx * cdx + cdz * cdz);
          const targetPitch = Math.atan2(cdy, cHDist);

          const lerpSpeed = 12.0 * dt;
          let yawDiff = targetYaw - this.deathYaw;
          if (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
          if (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
          this.deathYaw += yawDiff * lerpSpeed;
          this.deathPitch += (targetPitch - this.deathPitch) * lerpSpeed;

          // Hit flinch at ~1.2s: enemy strikes the player, camera jerks away
          if (this.deathTimer >= 1.2) {
            this.deathHitApplied = true;
            this.deathYaw += 0.6;
            this.deathPitch -= 0.35;
          }
        }
        // After hit: no tracking — camera stays where the blow sent it

        // Add shake to rotation too — intensify briefly after hit
        const hitShake = (this.deathHitApplied && this.deathTimer < 1.4) ? 0.06 : 0;
        const rotShake = shakeIntensity * 0.02 + hitShake;
        this.camera.rotation.order = 'YXZ';
        this.camera.rotation.y = this.deathYaw + Math.sin(this.deathTimer * 31) * rotShake;
        this.camera.rotation.x = this.deathPitch + Math.cos(this.deathTimer * 43) * rotShake;
      }

      // Phase 1 (0–2.5s): FOV narrows 75 → 45
      // Phase 2 (2.5–3.3s): dramatic zoom FOV 45 → 7.5 with ease-in + camera roll
      const PHASE1_END = 1.75;
      const PHASE2_DUR = 0.8;
      const TOTAL_DEATH = PHASE1_END + PHASE2_DUR;

      if (this.deathTimer <= PHASE1_END) {
        const zoomProgress = this.deathTimer / PHASE1_END;
        this.camera.fov = 75 - 30 * zoomProgress;
      } else {
        // Ease-in (quadratic) for dramatic final zoom
        const p = Math.min(1.0, (this.deathTimer - PHASE1_END) / PHASE2_DUR);
        const eased = p * p;  // ease-in
        this.camera.fov = 45 - 37.5 * eased;  // 45 → 7.5
        // Small camera roll for disorientation
        this.camera.rotation.z = eased * 0.15;  // ~8.6° max roll
      }
      this.camera.updateProjectionMatrix();

      // Keep the caught enemy's attack animation playing + face the player
      if (this.deathEnemy) {
        this.deathEnemy.tickMixer(dt, this.player.getPosition());
      }

      this.horrorPass.uniforms['time'].value = t;
      this.composer.render();

      if (this.deathTimer >= TOTAL_DEATH) {
        this.dying = false;
        this.horrorPass.uniforms['vhsIntensity'].value = 0;
        // Restore FOV and roll
        this.camera.fov = 75;
        this.camera.rotation.z = 0;
        this.camera.updateProjectionMatrix();
        this.endGame();
      }
      return;
    }

    // Decay player audibility from last frame
    this.audio.tickAudibility(dt);

    // Mic input → player noise (feeds enemy detection directly)
    if (this.micEnabled) {
      const micLevel = this.audio.getMicLevel();
      if (micLevel > 0.05) this.audio.reportPlayerSound(micLevel);
    }

    // Debug: infinite flashlight + stamina
    if (this.debugInfiniteResources) {
      this.flashBattery = 100;
      if (this.player) this.player.stamina = 100;
    }

    // Sync virtual controls before player tick (touch + gamepad)
    this.mobileControls?.update();
    this.gamepad.update();

    // Player
    const { stairsUp, isExit } = this.player.update(dt);

    // Sprint FOV: widen to 85 when sprinting, smoothly lerp back to 75
    const targetFov = this.player.sprinting ? 85 : 75;
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, 8 * dt);
    this.camera.updateProjectionMatrix();

    const fi = this.player.floorIndex;
    const pp  = this.player.getPosition();
    const fwd = this.player.getForwardDirection();
    const hasKey = this.collected[fi]?.has('key');

    if (stairsUp) {
      if (hasKey) {
        this.player.goUpFloor();
        this.updateFog(this.player.floorIndex);
        this.setVisibleFloor(this.player.floorIndex);
      } else {
        this.showKeyNeeded();
      }
    }

    if (isExit && fi === NUM_FLOORS - 1) {
      if (hasKey) {
        this.showMessage('YOU ESCAPED!', '#0f8', 4000);
        this.endGame();
        return;
      } else {
        this.showKeyNeeded();
      }
    }

    // Items
    for (const item of this.items) {
      const justCollected = item.update(t, pp, fi, this.camera);
      if (justCollected) {
        this.collected[fi].add(item.type);
        this.onItemCollected(item.type);
      }
    }

    // Floor culling — only render the active floor
    this.setVisibleFloor(this.player.floorIndex);

    // Lantern light pool: reposition pool lights to the nearest lantern positions
    const lanterns = this.mazeRenderer.lanternPositions[fi] ?? [];
    if (this.debugLight || lanterns.length === 0) {
      for (const pl of this.lanternPool) pl.position.y = this.LANTERN_PARK_Y;
    } else {
      const scored: { idx: number; distSq: number }[] = [];
      for (let i = 0; i < lanterns.length; i++) {
        const lp = lanterns[i];
        const dx = lp.x - pp.x, dz = lp.z - pp.z;
        scored.push({ idx: i, distSq: dx * dx + dz * dz });
      }
      scored.sort((a, b) => a.distSq - b.distSq);

      for (let i = 0; i < this.lanternPool.length; i++) {
        if (i < scored.length) {
          const lp = lanterns[scored[i].idx];
          this.lanternPool[i].position.set(lp.x, lp.y, lp.z);
        } else {
          this.lanternPool[i].position.y = this.LANTERN_PARK_Y;
        }
      }
    }

    // Unified player visibility (0=pitch dark, 1=fully lit) — pure gameplay, unaffected by debug modes
    // Flashlight = 1.0; scene lanterns scale up to 0.75 based on proximity to their map positions
    let lanternExposure = 0;
    const LANTERN_FULL = 2.5;  // within this = full exposure
    const LANTERN_MAX  = 8.0;  // beyond this = no exposure
    for (const lp of lanterns) {
      const dx = lp.x - pp.x, dz = lp.z - pp.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < LANTERN_MAX) {
        const t = Math.max(0, dist - LANTERN_FULL) / (LANTERN_MAX - LANTERN_FULL);
        lanternExposure = Math.max(lanternExposure, 1 - t);
      }
    }
    this.playerVisibility = this.flashlightOn ? 1.0 : lanternExposure * 0.75;

    // Audio listener + footsteps
    this.audio.setListenerPose(pp.x, pp.y, pp.z, fwd.x, fwd.y, fwd.z);
    this.audio.updateFootsteps(dt, this.player.currentSpeed, 5.625, this.player.onGround, this.player.justLanded, this.player.landingImpact, this.player.crouching);

    // Enemies + proximity drone
    let nearestDist = Infinity;
    let caughtBy: Enemy | null = null;
    for (const enemy of this.enemies) {
      // Feed player hint + key status to enemies on this floor
      if (enemy.homeFloor === fi) {
        enemy.setPlayerHint(pp);
        enemy.setKeyCollected(hasKey === true);
      }
      const caught = enemy.update(dt, pp, this.player.floorIndex, this.camera, this.playerVisibility, this.audio.playerAudibility);
if (caught && !caughtBy) {
        caughtBy = enemy;
      }
      // Track nearest enemy on this floor
      if (enemy.homeFloor === this.player.floorIndex) {
        const d = enemy.getPosition().distanceTo(pp);
        if (d < nearestDist) nearestDist = d;
      }
    }

    // ── Sound pings for compass minimap ──────────────────────────────────
    const now = performance.now() / 1000;
    const PING_DURATION = 3.0; // seconds a ping stays visible
    const PING_INTERVAL = 4.0; // seconds between periodic sound pings
    // Prune expired pings
    this.soundPings = this.soundPings.filter(p => now - p.time < PING_DURATION);
    // Record pings from enemy sounds
    for (const enemy of this.enemies) {
      if (enemy.homeFloor !== this.player.floorIndex) continue;
      const prevState = this.prevEnemyStates.get(enemy);
      const curState = enemy.state;

      // State transition = sound event (spotted alert, chase growl, etc.)
      if (prevState !== undefined && prevState !== curState) {
        const ep = enemy.getPosition();
        this.soundPings.push({ x: ep.x, z: ep.z, floor: enemy.floorIndex, time: now });
        this.enemySoundTimers.set(enemy, now);
      }
      this.prevEnemyStates.set(enemy, curState);

      // Periodic pings while enemy is actively making noise (searching loop, chasing growls)
      if (curState === EnemyState.SEARCHING || curState === EnemyState.CHASING) {
        const lastPing = this.enemySoundTimers.get(enemy) ?? 0;
        if (now - lastPing >= PING_INTERVAL) {
          const ep = enemy.getPosition();
          this.soundPings.push({ x: ep.x, z: ep.z, floor: enemy.floorIndex, time: now });
          this.enemySoundTimers.set(enemy, now);
        }
      }
    }

    // Track nearest chasing enemy distance
    let nearestChasingDist = Infinity;
    for (const enemy of this.enemies) {
      if (enemy.floorIndex === this.player.floorIndex && enemy.state === EnemyState.CHASING) {
        const d = enemy.getPosition().distanceTo(pp);
        if (d < nearestChasingDist) nearestChasingDist = d;
      }
    }

    // Update proximity drone + proximity tension growl
    this.audio.updateProximityDrone(nearestDist);
    this.audio.updateProximityTension(nearestDist);
    this.updateVibration(dt, nearestDist);

    // Chase tension — rising high-pitch shriek
    const isChasing = nearestChasingDist < Infinity;
    this.audio.updateChaseTension(isChasing, nearestChasingDist);

    // Flashlight (needs nearestDist for proximity flicker)
    this.updateFlashlight(dt, t, nearestDist);

    if (caughtBy) {
      this.showMessage('TE ATRAPÓ...', '#f44', 4000);
      this.startDeathAnimation(caughtBy);
      return;
    }

    this.updateHUD(t);
    this.mazeRenderer.update(t);
    this.horrorPass.uniforms['time'].value = t;
    this.composer.render();
  };

  private setVisibleFloor(fi: number) {
    if (fi === this.currentVisibleFloor) return;
    this.currentVisibleFloor = fi;
    this.mazeRenderer.setFloorVisible(fi);
  }

  private startDeathAnimation(enemy: Enemy) {
    this.dying = true;
    this.deathTimer = 0;
    this.deathHitApplied = false;
    this.deathEnemy = enemy;
    // Trigger the enemy's attack animation and face the player
    enemy.playCaughtAnimation();
    // Reset crouch so death camera isn't low — also snap camera Y back up
    this.player.resetCrouch();
    this.camera.position.copy(this.player.getPosition());
    // Capture current camera state as starting point (after crouch reset)
    this.deathYaw = this.camera.rotation.y;
    this.deathPitch = this.camera.rotation.x;
    this.deathStartPos.copy(this.camera.position);

    // Compute max stumble distance: check wall clearance behind the player
    const ep = enemy.getPosition();
    const pp = this.camera.position;
    const ddx = ep.x - pp.x, ddz = ep.z - pp.z;
    const dh = Math.sqrt(ddx * ddx + ddz * ddz);
    const awayX = dh > 0.01 ? -ddx / dh : 0;
    const awayZ = dh > 0.01 ? -ddz / dh : 0;
    // Sample backward in small steps to find wall clearance
    const DESIRED_STUMBLE = 0.6;
    const STEP = 0.15;
    let maxClear = 0;
    for (let d = STEP; d <= DESIRED_STUMBLE; d += STEP) {
      const testX = pp.x + awayX * d;
      const testZ = pp.z + awayZ * d;
      // Check if this point is in a valid cell (not through a wall)
      const fi = this.player.floorIndex;
      const floor = this.maze.floors[fi];
      if (!floor) break;
      const cx = Math.round(testX / CELL_SIZE);
      const cz = Math.round(testZ / CELL_SIZE);
      const startCx = Math.round(pp.x / CELL_SIZE);
      const startCz = Math.round(pp.z / CELL_SIZE);
      // If we crossed into a different cell, check walls
      if (cx !== startCx || cz !== startCz) {
        const startCell = floor.cells[startCz]?.[startCx];
        const destCell = floor.cells[cz]?.[cx];
        if (!startCell || !destCell) break;
        // Check wall crossing
        if (cx > startCx && (startCell.walls.E || destCell.walls.W)) break;
        if (cx < startCx && (startCell.walls.W || destCell.walls.E)) break;
        if (cz > startCz && (startCell.walls.S || destCell.walls.N)) break;
        if (cz < startCz && (startCell.walls.N || destCell.walls.S)) break;
      }
      maxClear = d;
    }
    this.deathMaxStumble = Math.min(DESIRED_STUMBLE, maxClear);
    // Force flashlight on so the monster is visible
    this.flashlightOn = true;
    this.flashlight.intensity = 28.0;
    this.torchLight.intensity = 0.6;
    // Death audio: explosive stinger + kill chase/drone/enemy sounds/ambience
    this.audio.playDeathStinger();
    this.audio.stopEnemySound();
    this.audio.stopAmbience();
    this.audio.updateProximityDrone(-1);
    this.audio.updateProximityTension(-1);
  }

  private flickerState = true;
  private nextFlickerEvent = 0;   // when the next flicker burst starts
  private flickerBurstEnd = 0;    // when current burst ends
  private flickerBurstOn = true;  // is light on during current burst frame
  private flickerSubTimer = 0;    // rapid on/off within a burst

  private updateFlashlight(dt: number, _t: number, nearestDist: number) {
    // Drain / recharge
    if (this.flashlightOn && this.flashBattery > 0) {
      this.flashBattery = Math.max(0, this.flashBattery - FLASHLIGHT_DRAIN * dt);
      if (this.flashBattery === 0) this.flashlightOn = false;
    } else if (!this.flashlightOn) {
      this.flashBattery = Math.min(100, this.flashBattery + FLASHLIGHT_CHARGE * dt);
    }

    if (!this.flashlightOn) {
      this.flashlight.intensity = 0;
      this.torchLight.intensity = 1.4;
      this.audio.updateFlickerBuzz(0);
      return;
    }

    // ── Flicker probability ──────────────────────────────────────────────
    // batteryFlicker: 0 above 35%, ramps to 1 at 0%
    const batteryFlicker = this.flashBattery < 15
      ? 1.0 - (this.flashBattery / 15)
      : 0;

    // proximityFlicker: 0 beyond 15 units, ramps to 1 at 3 units
    const PROX_MAX = 15, PROX_MIN = 3;
    const proximityFlicker = nearestDist < PROX_MAX
      ? Math.pow(1.0 - Math.max(0, Math.min(1, (nearestDist - PROX_MIN) / (PROX_MAX - PROX_MIN))), 2)
      : 0;

    const flickerIntensity = Math.min(1, batteryFlicker + proximityFlicker);

    const now = performance.now() / 1000;
    let lightOn = true;

    if (flickerIntensity > 0.01) {
      // Schedule random flicker bursts
      if (now >= this.nextFlickerEvent && now >= this.flickerBurstEnd) {
        // Random gap between bursts: shorter when intensity is high
        const minGap = 0.3 / (flickerIntensity + 0.1);
        const maxGap = 3.0 / (flickerIntensity + 0.1);
        const gap = minGap + Math.random() * (maxGap - minGap);
        this.nextFlickerEvent = now + gap;
      }

      if (now >= this.nextFlickerEvent && now >= this.flickerBurstEnd) {
        // Start a new burst — random duration
        const burstLen = 0.05 + Math.random() * 0.3 * flickerIntensity;
        this.flickerBurstEnd = now + burstLen;
        this.flickerSubTimer = 0;
        this.nextFlickerEvent = Infinity; // wait until burst ends
      }

      if (now < this.flickerBurstEnd) {
        // Inside a flicker burst — rapid random on/off
        this.flickerSubTimer += dt;
        // Random sub-flicker intervals (20-80ms)
        if (this.flickerSubTimer > 0.02 + Math.random() * 0.06) {
          this.flickerSubTimer = 0;
          this.flickerBurstOn = Math.random() > 0.5;
        }
        lightOn = this.flickerBurstOn;
      } else {
        // Between bursts — light is on, schedule next
        lightOn = true;
        if (this.nextFlickerEvent === Infinity) {
          const minGap = 0.5 / (flickerIntensity + 0.1);
          const maxGap = 4.0 / (flickerIntensity + 0.1);
          this.nextFlickerEvent = now + minGap + Math.random() * (maxGap - minGap);
        }
      }

      // Final battery death: intense rapid flashing
      if (this.flashBattery < 5 && this.flashBattery > 0) {
        lightOn = Math.random() > 0.4;
      }
    }

    this.flickerState = lightOn;
    this.flashlight.intensity = lightOn ? 28.0 : 0;
    this.torchLight.intensity = lightOn ? 0.6 : 1.4;

    // Electrical buzz — only when light is off during a flicker burst
    const buzzLevel = (!lightOn && now < this.flickerBurstEnd) ? flickerIntensity : 0;
    this.audio.updateFlickerBuzz(buzzLevel);
  }

  private onItemCollected(_type: ItemType) {
    this.audio.playPickupSound();
    this.updateItemsHUD();
  }

  private updateVibration(dt: number, nearestDist: number) {
    if (!this.vibrationEnabled) return;
    const MAX_DIST = 18, MIN_DIST = 3;
    if (nearestDist > MAX_DIST) { this.vibrationTimer = 0; return; }

    const t = 1 - Math.max(0, Math.min(1, (nearestDist - MIN_DIST) / (MAX_DIST - MIN_DIST)));
    const intensity = t * t; // 0..1, quadratic

    // Gamepad low-frequency (left) motor
    const gamepads = navigator.getGamepads?.() ?? [];
    for (const gp of gamepads) {
      if (!gp) continue;
      const actuator = (gp as any).vibrationActuator;
      if (!actuator) continue;
      actuator.playEffect?.('dual-rumble', {
        startDelay: 0, duration: 150,
        weakMagnitude: 0,           // high-freq (right motor) — silent
        strongMagnitude: intensity * 0.85, // low-freq (left motor)
      })?.catch?.(() => {});
    }

    // Mobile vibration — pulse that gets longer and more frequent as enemy nears
    this.vibrationTimer -= dt;
    if (this.vibrationTimer <= 0) {
      const pulse = Math.round(40 + intensity * 160);   // 40–200 ms
      const gap   = Math.round(500 - intensity * 380);  // 500–120 ms
      navigator.vibrate?.([pulse, gap]);
      this.vibrationTimer = (pulse + gap) / 1000;
    }
  }

  private async setupMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.audio.connectMicrophone(stream, this.micReverbEnabled);
    } catch {
      // Permission denied or mic unavailable — silently disable
      this.micEnabled = false;
      const cb = document.getElementById('mic-cb') as HTMLInputElement | null;
      if (cb) cb.checked = false;
    }
  }

  private updateItemsHUD() {
    const fi = this.player.floorIndex;
    const has = this.collected[fi] ?? new Set();
    this.itemKeyEl.classList.toggle('collected', has.has('key'));
    this.itemMapEl.classList.toggle('collected', has.has('map'));
    this.itemCompassEl.classList.toggle('collected', has.has('compass'));
  }

  private showKeyNeeded() {
    this.keyNeededEl.textContent = '🔑 YOU NEED THE KEY';
    this.keyNeededEl.style.opacity = '1';
    setTimeout(() => { this.keyNeededEl.style.opacity = '0'; }, 1500);
  }

  private updateHUD(t: number) {
    const fi = this.player.floorIndex;
    this.floorTextEl.textContent =
      `FLOOR ${fi + 1} / ${NUM_FLOORS}  —  ${this.maze.floors[fi].theme.name.toUpperCase()}`;

    // Noise / visibility — update fills + debug bar icons, and crosshair indicators
    const noisePct = Math.round(this.audio.playerAudibility * 100);
    this.noiseFillEl.style.width = `${noisePct}%`;
    this.noiseFillEl.style.background = noisePct > 60 ? '#f44' : noisePct > 20 ? '#fa4' : '#484';
    const noiseOpacity = String(0.1 + 0.9 * (noisePct / 100));
    this.noiseIconEl.style.opacity = noiseOpacity;
    this.ciNoiseEl.style.opacity = noiseOpacity;

    const visPct = Math.round(this.playerVisibility * 100);
    this.visibilityFillEl.style.width = `${visPct}%`;
    this.visibilityFillEl.style.background =
      visPct > 70 ? '#eee' : visPct > 35 ? '#99c' : '#446';
    const visOpacity = String(0.1 + 0.9 * (visPct / 100));
    this.visibilityIconEl.style.opacity = visOpacity;
    this.ciVisibilityEl.style.opacity = visOpacity;

    // Battery bar
    const pct = this.flashBattery;
    this.batteryFillEl.style.width = `${pct}%`;
    this.batteryFillEl.style.background =
      pct > 60 ? '#4af' : pct > 25 ? '#fa4' : '#f44';
    this.batteryIconEl.textContent = this.flashlightOn ? '🔦' : '🔋';

    // Battery low blinking warning
    if (pct < 20 && pct > 0 && this.flashlightOn) {
      const blink = Math.sin(t * 6) > 0;
      this.batteryLowEl.style.opacity = blink ? '1' : '0';
    } else {
      this.batteryLowEl.style.opacity = '0';
    }

    // Stamina bar — visible whenever stamina is being consumed or not full
    const stam = this.player.stamina;
    const showStamina = this.player.sprinting || stam < 99.9;
    this.staminaHudEl.style.display = 'block';
    this.staminaHudEl.style.opacity = showStamina ? '1' : '0';
    this.staminaFillEl.style.width = `${stam}%`;
    this.staminaFillEl.style.background =
      stam > 50 ? '#4f8' : stam > 25 ? '#fa4' : '#f44';
    this.staminaIconEl.style.opacity = this.player.sprinting ? '1' : '0';

    this.updateItemsHUD();
    this.drawMinimap();
    this.updateSuspicionDebug();
  }

  private updateSuspicionDebug() {
    const debugOn = this.debugRevealMap;
    this.noiseHudEl.style.display      = debugOn ? 'flex' : 'none';
    this.visibilityHudEl.style.display = debugOn ? 'flex' : 'none';

    if (!debugOn) {
      this.suspicionDebugEl.style.display = 'none';
      return;
    }
    const fi = this.player.floorIndex;
    const floorEnemies = this.enemies.filter(e => e.homeFloor === fi);
    if (floorEnemies.length === 0) {
      this.suspicionDebugEl.style.display = 'none';
      return;
    }
    this.suspicionDebugEl.style.display = 'flex';

    let html = '';
    for (let i = 0; i < floorEnemies.length; i++) {
      const e = floorEnemies[i];
      const pct = Math.round(e.suspicion * 100);
      const fillColor = pct >= 80 ? '#f44' : pct >= 40 ? '#fa4' : '#4af';
      const iconColor =
        e.state === EnemyState.CHASING ? '#f44' :
        e.suspicion > 0.6             ? '#fa4' : '#888';
      html += `<div class="hud-bar">` +
        `<span class="hud-bar-icon" style="color:${iconColor}">E${i}</span>` +
        `<div class="hud-bar-track">` +
        `<div class="hud-bar-fill" style="width:${pct}%;background:${fillColor}"></div>` +
        `</div></div>`;
    }
    this.suspicionDebugEl.innerHTML = html;
  }

  private drawMinimap() {
    const fi    = this.player.floorIndex;
    const floor = this.maze.floors[fi];
    const W = floor.width, H = floor.height;
    const S = 120;
    // Use separate scale for X and Z so the full map always fits the canvas
    const cellW = S / W;
    const cellH = S / H;
    const ctx = this.minimapCtx;
    const has = this.collected[fi] ?? new Set<ItemType>();
    const hasMap     = has.has('map') || this.debugRevealMap || this.debugSoundField;
    const hasCompass = has.has('compass') || this.debugRevealMap;

    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, S, S);

    // Minimum dot size so things are visible on large maps
    const dotMin = Math.max(Math.min(cellW, cellH), 2);

    // Draw the maze layout — solid blocks + wall segments (works with both thick and thin walls)
    if (hasMap) {
      // First pass: fill fully-solid cells as blocks
      for (let z = 0; z < H; z++) {
        for (let x = 0; x < W; x++) {
          const c = floor.cells[z][x];
          if (c.walls.N && c.walls.S && c.walls.E && c.walls.W) {
            ctx.fillStyle = '#334';
            ctx.fillRect(x * cellW, z * cellH, cellW + 0.5, cellH + 0.5);
          }
        }
      }
      // Sound field heatmap — drawn between solid-cell fill and wall segments
      // so walls render on top and remain readable.
      if (this.debugSoundField) {
        const enemyColors = ['#00ffcc', '#ff66ff', '#ffcc00', '#88ff44'];
        let ei = 0;
        for (const enemy of this.enemies) {
          if (enemy.floorIndex !== fi) { ei++; continue; }
          const ep = enemy.getPosition();
          const ec = this.maze.worldToCell(ep.x, ep.z, fi);
          const energies = computeSoundEnergies(floor, ec.x, ec.z);
          ctx.fillStyle = enemyColors[ei % enemyColors.length];
          for (let ez = 0; ez < H; ez++) {
            for (let ex = 0; ex < W; ex++) {
              const e = energies[ez * W + ex];
              if (e < 0.01) continue;
              ctx.globalAlpha = e * 0.6;
              ctx.fillRect(ex * cellW, ez * cellH, cellW + 0.5, cellH + 0.5);
            }
          }
          ei++;
        }
        ctx.globalAlpha = 1.0;
      }

      // Second pass: draw individual wall segments (for thin-wall mazes)
      ctx.strokeStyle = '#556';
      ctx.lineWidth = Math.max(0.5, Math.min(cellW, cellH) * 0.3);
      for (let z = 0; z < H; z++) {
        for (let x = 0; x < W; x++) {
          const c = floor.cells[z][x];
          const px = x * cellW, pz = z * cellH;
          if (c.walls.N) { ctx.beginPath(); ctx.moveTo(px, pz); ctx.lineTo(px + cellW, pz); ctx.stroke(); }
          if (c.walls.W) { ctx.beginPath(); ctx.moveTo(px, pz); ctx.lineTo(px, pz + cellH); ctx.stroke(); }
          if (z === H - 1 && c.walls.S) { ctx.beginPath(); ctx.moveTo(px, pz + cellH); ctx.lineTo(px + cellW, pz + cellH); ctx.stroke(); }
          if (x === W - 1 && c.walls.E) { ctx.beginPath(); ctx.moveTo(px + cellW, pz); ctx.lineTo(px + cellW, pz + cellH); ctx.stroke(); }
          // Stairs / exit markers
          if (c.stairs === 'up') { ctx.fillStyle = '#fc4'; ctx.fillRect(px, pz, Math.max(cellW, 2), Math.max(cellH, 2)); }
          if (c.isExit)   { ctx.fillStyle = '#0f8'; ctx.fillRect(px, pz, Math.max(cellW, 2), Math.max(cellH, 2)); }
        }
      }
    }

    // Compass: show player, enemies, and items on map (even without map = black background with dots)
    if (hasCompass) {
      // Draw uncollected items on this floor
      for (const item of this.items) {
        if (item.floorIndex !== fi || item.collected) continue;
        const ic = this.maze.worldToCell(item.mesh.position.x, item.mesh.position.z, fi);
        const itemColor = item.type === 'key' ? '#fc4' : item.type === 'map' ? '#4af' : '#4f8';
        ctx.fillStyle = itemColor;
        ctx.fillRect(ic.x * cellW, ic.z * cellH, dotMin, dotMin);
      }

      // Player arrow (directional)
      this.drawPlayerArrow(ctx, fi, cellW, cellH, dotMin);

      // Enemies — debug mode shows real-time positions; compass shows fading sound pings
      if (this.debugRevealMap) {
        // Debug: always show all enemies in real-time
        for (const enemy of this.enemies) {
          if (enemy.floorIndex !== fi) continue;
          const ep = enemy.mesh.position;
          const ec = this.maze.worldToCell(ep.x, ep.z, fi);
          ctx.fillStyle = enemy.state === EnemyState.CHASING ? '#f44' : '#f84';
          ctx.beginPath();
          ctx.arc(ec.x * cellW + cellW / 2, ec.z * cellH + cellH / 2, Math.max(dotMin * 0.8, 1.5), 0, Math.PI * 2);
          ctx.fill();

          // Debug: show enemy's current target as a small ×
          const tgt = enemy.getSearchTarget();
          if (tgt) {
            const tc = this.maze.worldToCell(tgt.x, tgt.z, fi);
            const tx = tc.x * cellW + cellW / 2;
            const tz = tc.z * cellH + cellH / 2;
            const r = Math.max(dotMin * 0.6, 1.2);
            ctx.strokeStyle = enemy.state === EnemyState.CHASING ? '#f44' : '#f84';
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.7;
            // × marker
            ctx.beginPath();
            ctx.moveTo(tx - r, tz - r); ctx.lineTo(tx + r, tz + r);
            ctx.moveTo(tx + r, tz - r); ctx.lineTo(tx - r, tz + r);
            ctx.stroke();
            // Line from enemy to target
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(ec.x * cellW + cellW / 2, ec.z * cellH + cellH / 2);
            ctx.lineTo(tx, tz);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1.0;
          }
        }
      } else {
        // Compass: show sound pings that fade over 3 seconds
        const now = performance.now() / 1000;
        for (const ping of this.soundPings) {
          if (ping.floor !== fi) continue;
          const age = now - ping.time;
          if (age >= 3.0) continue;
          const alpha = 1.0 - age / 3.0; // fade out linearly
          const pc = this.maze.worldToCell(ping.x, ping.z, fi);
          // Pulsing ring effect that expands as it fades
          const ringRadius = Math.max(dotMin * 0.8, 1.5) + age * 0.8;
          ctx.globalAlpha = alpha * 0.9;
          ctx.fillStyle = '#f84';
          ctx.beginPath();
          ctx.arc(pc.x * cellW + cellW / 2, pc.z * cellH + cellH / 2, Math.max(dotMin * 0.6, 1.2), 0, Math.PI * 2);
          ctx.fill();
          // Expanding ring
          ctx.strokeStyle = '#f84';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.arc(pc.x * cellW + cellW / 2, pc.z * cellH + cellH / 2, ringRadius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1.0;
        }
      }

      // Sound field: direction arrows at the player's cell (one per enemy)
      if (this.debugSoundField) {
        const pp = this.player.getPosition();
        const pc = this.maze.worldToCell(pp.x, pp.z, fi);
        const px = pc.x * cellW + cellW / 2;
        const pz = pc.z * cellH + cellH / 2;
        const arrowLen = Math.min(cellW, cellH) * 2.5;
        const enemyColors = ['#00ffcc', '#ff66ff', '#ffcc00', '#88ff44'];
        let ei = 0;
        for (const enemy of this.enemies) {
          if (enemy.floorIndex !== fi) { ei++; continue; }
          const ep = enemy.getPosition();
          const ec = this.maze.worldToCell(ep.x, ep.z, fi);
          const sf = computeSoundField(floor, ec.x, ec.z, pc.x, pc.z);
          if (sf.energy > 0.01 && (sf.dirX !== 0 || sf.dirZ !== 0)) {
            ctx.strokeStyle = enemyColors[ei % enemyColors.length];
            ctx.lineWidth = 1.5;
            ctx.globalAlpha = 0.5 + sf.confidence * 0.5; // bolder when more directional
            ctx.beginPath();
            ctx.moveTo(px, pz);
            ctx.lineTo(px + sf.dirX * arrowLen, pz + sf.dirZ * arrowLen);
            ctx.stroke();
          }
          ei++;
        }
        ctx.globalAlpha = 1.0;
      }

      // Stairs / exit markers (show as blinking targets even without map)
      if (!hasMap) {
        const blink = Math.sin(Date.now() * 0.005) > 0;
        if (blink) {
          for (let z = 0; z < H; z++) {
            for (let x = 0; x < W; x++) {
              const c = floor.cells[z][x];
              if (c.stairs === 'up') {
                ctx.fillStyle = '#fc4';
                ctx.fillRect(x * cellW, z * cellH, dotMin, dotMin);
              }
              if (c.isExit) {
                ctx.fillStyle = '#0f8';
                ctx.fillRect(x * cellW, z * cellH, dotMin, dotMin);
              }
            }
          }
        }
      }
    } else if (hasMap) {
      // Has map but no compass — show layout but only player arrow (no enemies/items)
      this.drawPlayerArrow(ctx, fi, cellW, cellH, dotMin);
    }

    // No map AND no compass = completely black minimap (just the dark background)
  }

  /** Draw a directional arrow for the player on the minimap */
  private drawPlayerArrow(ctx: CanvasRenderingContext2D, fi: number, cellW: number, cellH: number, dotMin: number) {
    const pc = this.maze.worldToCell(this.player.getPosition().x, this.player.getPosition().z, fi);
    const cx = pc.x * cellW + cellW / 2;
    const cy = pc.z * cellH + cellH / 2;
    const yaw = this.player.getYaw();

    // Arrow size scales with dot size but has a minimum
    const arrowLen = Math.max(dotMin * 1.8, 4);

    ctx.save();
    ctx.translate(cx, cy);
    // yaw 0 = looking toward -Z (north = up on minimap), so rotate by -yaw
    // In minimap coords: up = -Y, and canvas rotation is clockwise.
    // yaw=0 → arrow points up (-Y), yaw=PI/2 → arrow points left (-X)
    // Canvas needs: angle from +X axis. Arrow pointing up = -PI/2.
    // Final rotation = -yaw - PI/2... but simpler: just negate yaw and offset.
    ctx.rotate(-yaw);

    // Draw arrow pointing UP (toward -Y in local space = "north" = yaw 0)
    ctx.beginPath();
    ctx.moveTo(0, -arrowLen);           // tip
    ctx.lineTo(-arrowLen * 0.5, arrowLen * 0.4);  // bottom-left
    ctx.lineTo(0, arrowLen * 0.15);     // notch
    ctx.lineTo(arrowLen * 0.5, arrowLen * 0.4);   // bottom-right
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.restore();
  }

  private showMessage(text: string, color: string, duration: number) {
    this.messageEl.textContent = text;
    this.messageEl.style.color = color;
    this.messageEl.style.opacity = '1';
    setTimeout(() => { this.messageEl.style.opacity = '0'; }, duration);
  }

  // ── Debug menu ──────────────────────────────────────────────────────────
  private setupDebugMenu() {
    const menu = document.getElementById('debug-menu')!;

    // Floor jump buttons (only buttons with data-floor, not pixel scale buttons)
    menu.querySelectorAll<HTMLButtonElement>('button[data-floor]').forEach(btn => {
      btn.addEventListener('click', () => {
        const fi = parseInt(btn.dataset.floor ?? '0', 10);
        this.debugJumpToFloor(fi);
      });
    });

    // Full-bright toggle
    const fullbrightCb = document.getElementById('dbg-fullbright') as HTMLInputElement;
    fullbrightCb.addEventListener('change', () => {
      this.debugLight = fullbrightCb.checked;
      if (this.debugLight) {
        this.scene.fog = null;
        this.scene.add(this.debugAmbient);
      } else {
        this.scene.remove(this.debugAmbient);
        this.updateFog(this.player?.floorIndex ?? 0);
      }
    });

    // Fast forward toggle (3× game speed for observing enemy behavior)
    const ffCb = document.getElementById('dbg-fastforward') as HTMLInputElement;
    ffCb.addEventListener('change', () => {
      this.debugFastForward = ffCb.checked;
    });

    // Reveal map + enemies toggle
    const revealCb = document.getElementById('dbg-revealmap') as HTMLInputElement;
    revealCb.addEventListener('change', () => {
      this.debugRevealMap = revealCb.checked;
    });

    // Sound field heatmap overlay
    const sfCb = document.getElementById('dbg-soundfield') as HTMLInputElement;
    sfCb.addEventListener('change', () => {
      this.debugSoundField = sfCb.checked;
    });

    // Disable enemy detection
    const ndCb = document.getElementById('dbg-nodetection') as HTMLInputElement;
    ndCb.addEventListener('change', () => {
      for (const enemy of this.enemies) {
        enemy.detectionEnabled = !ndCb.checked;
      }
    });

    // Infinite flashlight + stamina
    const irCb = document.getElementById('dbg-infiniteresources') as HTMLInputElement;
    irCb.addEventListener('change', () => {
      this.debugInfiniteResources = irCb.checked;
    });

    // Pixel scale buttons — live in the options menu, wired once here
    // Use the real DPR (uncapped) so 1× gives true native resolution
    const baseDPR = window.devicePixelRatio;
    document.querySelectorAll<HTMLButtonElement>('button[data-pixelscale]').forEach(btn => {
      btn.addEventListener('click', () => {
        const scale = parseInt(btn.dataset.pixelscale ?? '1', 10);
        this.renderer.setPixelRatio(baseDPR / scale);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        document.querySelectorAll<HTMLButtonElement>('button[data-pixelscale]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Shadows toggle
    const shadowsCb = document.getElementById('opt-shadows') as HTMLInputElement;
    shadowsCb.addEventListener('change', () => {
      const on = shadowsCb.checked;
      this.flashlight.castShadow = on;
      this.lanternPool.slice(0, 2).forEach(l => { l.castShadow = on; });
    });

    // Posterize effect toggle
    const posterizeCb = document.getElementById('opt-posterize') as HTMLInputElement;
    posterizeCb.addEventListener('change', () => {
      this.horrorPass.uniforms['posterLevels'].value = posterizeCb.checked ? 12.0 : 256.0;
    });
  }

  private toggleFlashlight() {
    if (!this.flashlightOn && this.flashBattery < 5) return;
    this.flashlightOn = !this.flashlightOn;
    if (this.flashlightOn) {
      this.flashBattery = Math.max(0, this.flashBattery - 1);
    }
    this.audio.playFlashlightToggle(this.flashlightOn);
  }

  private toggleDebugMenu() {
    this.debugMenuOpen = !this.debugMenuOpen;
    const menu = document.getElementById('debug-menu')!;
    menu.style.display = this.debugMenuOpen ? 'block' : 'none';

    // Update active floor button highlight
    if (this.debugMenuOpen) {
      this.updateDebugFloorButtons();
      // Release pointer lock so we can click the menu
      document.exitPointerLock();
    }
  }

  private updateDebugFloorButtons() {
    const menu = document.getElementById('debug-menu')!;
    const fi = this.player?.floorIndex ?? 0;
    menu.querySelectorAll<HTMLButtonElement>('button[data-floor]').forEach(btn => {
      const bfi = parseInt(btn.dataset.floor ?? '-1', 10);
      btn.classList.toggle('active', bfi === fi);
    });
  }

  private debugJumpToFloor(fi: number) {
    if (fi < 0 || fi >= NUM_FLOORS || !this.player) return;
    // Teleport player to the entry cell of the target floor
    const entry = this.maze.floors[fi].entryCell;
    this.player.spawn(fi, entry.x, entry.z);
    this.updateFog(fi);
    this.setVisibleFloor(fi);
    this.updateItemsHUD();
    this.updateDebugFloorButtons();
    // Close debug menu and re-lock pointer
    this.debugMenuOpen = false;
    document.getElementById('debug-menu')!.style.display = 'none';
    this.player.requestLock();
  }

  private endGame() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.exitPointerLock();
    // Close debug menu if open
    this.debugMenuOpen = false;
    document.getElementById('debug-menu')!.style.display = 'none';
    setTimeout(() => {
      // Reset blackout in case the fade-in was still in progress
      const blackout = document.getElementById('blackout')!;
      blackout.style.transition = 'none';
      blackout.style.opacity = '0';

      const overlay = document.getElementById('overlay')!;
      document.getElementById('start-btn')!.textContent = 'RETRY';
      overlay.style.display = 'flex';
      this.mobileControls?.hide(); // hide joystick so it doesn't block the RETRY button
      // Double-rAF ensures display:flex is painted before transitioning opacity
      requestAnimationFrame(() => requestAnimationFrame(() => {
        overlay.classList.add('ready');
      }));
    }, 2500);
  }

  deactivateGamepad() { this.gamepad.deactivate(); }

  pauseGame() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.audio.suspend();
  }

  resumeGame() {
    if (this.running) return;
    this.running = true;
    this.audio.resume();
    this.clock.start();
    this.loop();
  }

  restart() {
    this.audio.stopAll();
    this.mazeRenderer.dispose(this.scene);
    this.lights.forEach(l => this.scene.remove(l));
    this.lights = [];
    this.enemies.forEach(e => e.dispose());
    this.enemies = [];
    this.soundPings = [];
    this.prevEnemyStates.clear();
    this.enemySoundTimers.clear();
    this.items.forEach(i => i.dispose(this.scene));
    this.items = [];
    // Reset debug state
    this.debugLight = false;
    this.debugRevealMap = false;
    this.debugFastForward = false;
    this.scene.remove(this.debugAmbient);
    (document.getElementById('dbg-fullbright') as HTMLInputElement).checked = false;
    (document.getElementById('dbg-revealmap') as HTMLInputElement).checked = false;
    (document.getElementById('dbg-fastforward') as HTMLInputElement).checked = false;
    (document.getElementById('dbg-nodetection') as HTMLInputElement).checked = false;
    (document.getElementById('dbg-infiniteresources') as HTMLInputElement).checked = false;
    this.debugInfiniteResources = false;
    // Clear dynamic objects (keep camera)
    this.scene.children
      .filter(c => c !== this.camera)
      .forEach(c => this.scene.remove(c));
    this.scene.add(this.camera);
    this.audio.resumeAudio();
    this.start();
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
