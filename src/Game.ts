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
  private debugNoEnemy  = false;
  private debugRevealMap = false;
  private debugAmbient!: THREE.AmbientLight;
  private debugMenuOpen = false;
  private mobileControls: MobileControls | null = null;
  private gamepad: GamepadManager;

  // Floor culling
  private currentVisibleFloor = -1;
  /** Per-floor lights (for culling) */
  private floorLights: THREE.Light[][] = [];
  private globalLights: THREE.Light[] = [];  // lights that are always visible

  // Death animation
  private dying = false;
  private deathTimer = 0;
  private deathEnemy: Enemy | null = null;
  private deathYaw = 0;
  private deathPitch = 0;

  // Items
  private items: Item[] = [];
  /** Per-floor collected items */
  private collected: Record<number, Set<ItemType>> = {};

  // HUD
  private minimapCtx:        CanvasRenderingContext2D;
  private minimapCanvas:     HTMLCanvasElement;
  private hudEl:             HTMLElement;
  private floorTextEl:       HTMLElement;
  private staminaHudEl!:     HTMLElement;
  private batteryLowEl!:     HTMLElement;
  private messageEl:         HTMLElement;
  private batteryFillEl!:    HTMLElement;
  private batteryIconEl!:    HTMLElement;
  private flashStatusEl!:    HTMLElement;
  private batteryPctEl!:     HTMLElement;
  private itemKeyEl!:        HTMLElement;
  private itemMapEl!:        HTMLElement;
  private itemCompassEl!:    HTMLElement;
  private keyNeededEl!:      HTMLElement;
  private staminaFillEl!:    HTMLElement;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    // Camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 80);

    // Scene — camera must be added for spotlight target to work
    this.scene = new THREE.Scene();
    this.scene.add(this.camera);

    // Flashlight (SpotLight on camera)
    this.flashlight = new THREE.SpotLight(0xffffff, 28.0, 140, Math.PI / 4, 0.4, 1.0);
    this.flashlight.position.set(0, -0.15, 0);
    this.flashlight.target.position.set(0, -0.1, -1);
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
    this.batteryLowEl     = document.getElementById('battery-low')!;
    this.messageEl        = document.getElementById('message')!;
    this.batteryFillEl    = document.getElementById('battery-fill')!;
    this.batteryIconEl    = document.getElementById('battery-icon')!;
    this.flashStatusEl    = document.getElementById('flashlight-status')!;
    this.batteryPctEl     = document.getElementById('battery-pct')!;

    this.minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
    this.minimapCtx    = this.minimapCanvas.getContext('2d')!;

    this.itemKeyEl     = document.getElementById('item-key')!;
    this.itemMapEl     = document.getElementById('item-map')!;
    this.itemCompassEl = document.getElementById('item-compass')!;
    this.keyNeededEl   = document.getElementById('key-needed')!;
    this.staminaFillEl = document.getElementById('stamina-fill')!;

    // Debug full-bright light (added to scene on demand)
    this.debugAmbient = new THREE.AmbientLight(0xffffff, 6);

    // Flashlight toggle + keyboard reclaims control from gamepad
    document.addEventListener('keydown', e => {
      this.gamepad.onKeyboardInput();
      if (e.code === 'KeyF' && !e.repeat) this.toggleFlashlight();
      if (e.code === 'Backquote' && !e.repeat) this.toggleDebugMenu();
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
    const ENEMIES_PER_FLOOR = [1, 2, 4];
    this.enemies = [];
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

    this.updateFog(0);
  }

  private updateFog(floorIdx: number) {
    const theme = this.maze.floors[floorIdx].theme;
    this.scene.fog = new THREE.FogExp2(theme.fogColor, theme.fogDensity);
    this.renderer.setClearColor(theme.hasCeiling ? theme.fogColor : 0x01020a);

    // Scale global ambient per floor — floors 2/3 have brighter materials so need less fill
    const ambientScale = floorIdx === 0 ? 7.0 : 3.0;
    if (this.globalLights[0]) (this.globalLights[0] as THREE.AmbientLight).intensity = ambientScale;

    // Reverb per floor: catacombs = very reverberant, house = moderate, village = open air
    const reverbLevels = [1.2, 0.65, 0.35];
    this.audio.setReverbLevel(reverbLevels[floorIdx] ?? 0.3);
  }

  private loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t  = this.clock.getElapsedTime();

    // ── Death animation ──────────────────────────────────────────────────
    if (this.dying) {
      this.deathTimer += dt;
      // VHS ramp: 0→1 over 2 seconds
      const vhs = Math.min(1.0, this.deathTimer / 2.0);
      this.horrorPass.uniforms['vhsIntensity'].value = vhs;

      // Rotate camera to face the enemy's face (3/4 height)
      if (this.deathEnemy) {
        const ep = this.deathEnemy.getPosition();
        const pp = this.player.getPosition();
        const dx = ep.x - pp.x, dz = ep.z - pp.z;
        const targetYaw = Math.atan2(-dx, -dz);
        // Aim at 3/4 of enemy height (face level)
        const faceY = ep.y + 0.5;  // offset up toward face
        const dy = faceY - pp.y;
        const hDist = Math.sqrt(dx * dx + dz * dz);
        const targetPitch = Math.atan2(dy, hDist);

        // Smoothly rotate toward enemy (fast snap)
        const lerpSpeed = 12.0 * dt;
        // Shortest rotation path for yaw
        let yawDiff = targetYaw - this.deathYaw;
        if (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
        if (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
        this.deathYaw += yawDiff * lerpSpeed;
        this.deathPitch += (targetPitch - this.deathPitch) * lerpSpeed;

        this.camera.rotation.order = 'YXZ';
        this.camera.rotation.y = this.deathYaw;
        this.camera.rotation.x = this.deathPitch;
      }

      // Slow zoom in: FOV narrows from 75 → 45 over the death duration
      const zoomProgress = Math.min(1.0, this.deathTimer / 2.5);
      this.camera.fov = 75 - 30 * zoomProgress;
      this.camera.updateProjectionMatrix();

      this.horrorPass.uniforms['time'].value = t;
      this.composer.render();

      if (this.deathTimer >= 2.5) {
        this.dying = false;
        this.horrorPass.uniforms['vhsIntensity'].value = 0;
        // Restore FOV
        this.camera.fov = 75;
        this.camera.updateProjectionMatrix();
        this.endGame();
      }
      return;
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
        this.showMessage('¡ESCAPASTE!', '#0f8', 4000);
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

    // Audio listener
    this.audio.setListenerPose(pp.x, pp.y, pp.z, fwd.x, fwd.y, fwd.z);

    // Enemies + proximity drone
    let nearestDist = Infinity;
    let caughtBy: Enemy | null = null;
    if (!this.debugNoEnemy) {
      for (const enemy of this.enemies) {
        const caught = enemy.update(dt, pp, this.player.floorIndex, this.camera, this.flashlightOn);
        if (caught && !caughtBy) {
          caughtBy = enemy;
        }
        // Track nearest enemy on this floor
        if (enemy.homeFloor === this.player.floorIndex) {
          const d = enemy.getPosition().distanceTo(pp);
          if (d < nearestDist) nearestDist = d;
        }
      }
    }

    // Track nearest chasing enemy distance
    let nearestChasingDist = Infinity;
    if (!this.debugNoEnemy) {
      for (const enemy of this.enemies) {
        if (enemy.floorIndex === this.player.floorIndex && enemy.state === EnemyState.CHASING) {
          const d = enemy.getPosition().distanceTo(pp);
          if (d < nearestChasingDist) nearestChasingDist = d;
        }
      }
    }

    // Update proximity drone
    this.audio.updateProximityDrone(this.debugNoEnemy ? -1 : nearestDist);

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
    this.deathEnemy = enemy;
    // Capture current camera rotation as starting point
    this.deathYaw = this.camera.rotation.y;
    this.deathPitch = this.camera.rotation.x;
    // Force flashlight on so the monster is visible
    this.flashlightOn = true;
    this.flashlight.intensity = 28.0;
    this.torchLight.intensity = 0.6;
    // Death audio: explosive stinger + kill chase/drone/enemy sounds
    this.audio.playDeathStinger();
    this.audio.stopEnemySound();
    this.audio.updateProximityDrone(-1);
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

  private updateItemsHUD() {
    const fi = this.player.floorIndex;
    const has = this.collected[fi] ?? new Set();
    this.itemKeyEl.classList.toggle('collected', has.has('key'));
    this.itemMapEl.classList.toggle('collected', has.has('map'));
    this.itemCompassEl.classList.toggle('collected', has.has('compass'));
  }

  private showKeyNeeded() {
    this.keyNeededEl.textContent = '🔑 NECESITAS LA LLAVE';
    this.keyNeededEl.style.opacity = '1';
    setTimeout(() => { this.keyNeededEl.style.opacity = '0'; }, 1500);
  }

  private updateHUD(t: number) {
    const fi = this.player.floorIndex;
    this.floorTextEl.textContent =
      `PLANTA ${fi + 1} / ${NUM_FLOORS}  —  ${this.maze.floors[fi].theme.name.toUpperCase()}`;

    // Battery bar
    const pct = this.flashBattery;
    this.batteryFillEl.style.width = `${pct}%`;
    this.batteryFillEl.style.background =
      pct > 60 ? '#4af' : pct > 25 ? '#fa4' : '#f44';
    this.batteryIconEl.textContent = this.flashlightOn ? '🔦' : '🔋';
    this.flashStatusEl.textContent = this.flashlightOn ? 'ON' : 'OFF';
    this.flashStatusEl.style.color = this.flashlightOn ? '#4af' : '#888';
    this.batteryPctEl.textContent = `${Math.round(pct)}%`;

    // Battery low blinking warning
    if (pct < 20 && pct > 0 && this.flashlightOn) {
      const blink = Math.sin(t * 6) > 0;
      this.batteryLowEl.style.opacity = blink ? '1' : '0';
    } else {
      this.batteryLowEl.style.opacity = '0';
    }

    // Stamina bar — only visible below 50%, centered under crosshair
    const stam = this.player.stamina;
    if (stam < 50) {
      this.staminaHudEl.style.display = 'block';
      this.staminaFillEl.style.width = `${stam * 2}%`;  // scale: 50% stamina = 100% bar width
      this.staminaFillEl.style.background =
        stam > 25 ? '#fa4' : '#f44';
    } else {
      this.staminaHudEl.style.display = 'none';
    }

    this.updateItemsHUD();
    this.drawMinimap();
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
    const hasMap     = has.has('map') || this.debugRevealMap;
    const hasCompass = has.has('compass') || this.debugRevealMap;

    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, S, S);

    // Minimum dot size so things are visible on large maps
    const dotMin = Math.max(Math.min(cellW, cellH), 2);

    // Only draw the maze layout if we have the map
    if (hasMap) {
      for (let z = 0; z < H; z++) {
        for (let x = 0; x < W; x++) {
          const c  = floor.cells[z][x];
          const px = x * cellW, pz = z * cellH;
          const solid = c.walls.N && c.walls.S && c.walls.E && c.walls.W;
          if (solid)      { ctx.fillStyle = '#334'; ctx.fillRect(px, pz, cellW + 0.5, cellH + 0.5); }
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

      // Enemies
      for (const enemy of this.enemies) {
        if (enemy.floorIndex !== fi) continue;
        const ep = enemy.mesh.position;
        const ec = this.maze.worldToCell(ep.x, ep.z, fi);
        ctx.fillStyle = enemy.state === EnemyState.CHASING ? '#f44' : '#f84';
        ctx.beginPath();
        ctx.arc(ec.x * cellW + cellW / 2, ec.z * cellH + cellH / 2, Math.max(dotMin * 0.8, 1.5), 0, Math.PI * 2);
        ctx.fill();
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

    // Floor jump buttons
    menu.querySelectorAll<HTMLButtonElement>('.floor-btns button').forEach(btn => {
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

    // No-enemy toggle
    const noEnemyCb = document.getElementById('dbg-noenemy') as HTMLInputElement;
    noEnemyCb.addEventListener('change', () => {
      this.debugNoEnemy = noEnemyCb.checked;
      if (this.debugNoEnemy) {
        for (const enemy of this.enemies) {
          enemy.mesh.visible = false;
        }
        this.audio.updateProximityDrone(-1);
      }
    });

    // Reveal map + enemies toggle
    const revealCb = document.getElementById('dbg-revealmap') as HTMLInputElement;
    revealCb.addEventListener('change', () => {
      this.debugRevealMap = revealCb.checked;
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
    menu.querySelectorAll<HTMLButtonElement>('.floor-btns button').forEach(btn => {
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
    this.audio.stopEnemySound();
    document.exitPointerLock();
    // Close debug menu if open
    this.debugMenuOpen = false;
    document.getElementById('debug-menu')!.style.display = 'none';
    setTimeout(() => {
      const overlay = document.getElementById('overlay')!;
      document.getElementById('start-btn')!.textContent = 'REINTENTAR';
      overlay.style.display = 'flex';
    }, 2500);
  }

  restart() {
    this.mazeRenderer.dispose(this.scene);
    this.lights.forEach(l => this.scene.remove(l));
    this.lights = [];
    this.enemies.forEach(e => e.dispose());
    this.enemies = [];
    this.items.forEach(i => i.dispose(this.scene));
    this.items = [];
    // Reset debug state
    this.debugLight = false;
    this.debugNoEnemy = false;
    this.debugRevealMap = false;
    this.scene.remove(this.debugAmbient);
    (document.getElementById('dbg-fullbright') as HTMLInputElement).checked = false;
    (document.getElementById('dbg-noenemy') as HTMLInputElement).checked = false;
    (document.getElementById('dbg-revealmap') as HTMLInputElement).checked = false;
    // Clear dynamic objects (keep camera)
    this.scene.children
      .filter(c => c !== this.camera)
      .forEach(c => this.scene.remove(c));
    this.scene.add(this.camera);
    this.start();
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }
}
