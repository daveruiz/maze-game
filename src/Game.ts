import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { MazeGenerator, MazeRenderer, WALL_HEIGHT, CELL_SIZE } from './Maze';
import { Player } from './Player';
import { Enemy } from './Enemy';
import { AudioManager } from './AudioManager';
import { EnemyState } from './types';
import { HorrorShader } from './HorrorShader';

const NUM_FLOORS = 3;

// Flashlight drain/recharge rates (% per second)
const FLASHLIGHT_DRAIN   = 10;
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
  private debugAmbient!: THREE.AmbientLight;

  // HUD
  private minimapCtx:        CanvasRenderingContext2D;
  private minimapCanvas:     HTMLCanvasElement;
  private hudEl:             HTMLElement;
  private floorTextEl:       HTMLElement;
  private enemyIndicatorEl:  HTMLElement;
  private messageEl:         HTMLElement;
  private batteryFillEl!:    HTMLElement;
  private batteryIconEl!:    HTMLElement;
  private flashStatusEl!:    HTMLElement;
  private batteryPctEl!:     HTMLElement;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    // Camera
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 800);

    // Scene — camera must be added for spotlight target to work
    this.scene = new THREE.Scene();
    this.scene.add(this.camera);

    // Flashlight (SpotLight on camera)
    this.flashlight = new THREE.SpotLight(0xffffff, 20.0, 80, Math.PI / 4, 0.4, 1.2);
    this.flashlight.position.set(0, -0.15, 0);
    this.flashlight.target.position.set(0, -0.1, -1);
    this.camera.add(this.flashlight);
    this.camera.add(this.flashlight.target);

    // Dim torch glow (always on, mimics ambient bounce near player)
    this.torchLight = new THREE.PointLight(0xff6622, 0.9, 7);
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
    this.enemyIndicatorEl = document.getElementById('enemy-indicator')!;
    this.messageEl        = document.getElementById('message')!;
    this.batteryFillEl    = document.getElementById('battery-fill')!;
    this.batteryIconEl    = document.getElementById('battery-icon')!;
    this.flashStatusEl    = document.getElementById('flashlight-status')!;
    this.batteryPctEl     = document.getElementById('battery-pct')!;

    this.minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
    this.minimapCtx    = this.minimapCanvas.getContext('2d')!;

    // Debug full-bright light (added to scene on demand)
    this.debugAmbient = new THREE.AmbientLight(0xffffff, 6);

    // Flashlight toggle + debug lighting toggle
    document.addEventListener('keydown', e => {
      if (e.code === 'KeyF') {
        this.flashlightOn = !this.flashlightOn;
        this.audio.playFlashlightToggle(this.flashlightOn);
      }
      if (e.code === 'KeyL') {
        this.debugLight = !this.debugLight;
        if (this.debugLight) {
          this.scene.fog = null;
          this.scene.add(this.debugAmbient);
        } else {
          this.scene.remove(this.debugAmbient);
          this.updateFog(this.player.floorIndex);
        }
      }
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

    // Spawn enemies: 1 on floor 0, 2 on floor 1, 4 on floor 2
    const ENEMIES_PER_FLOOR = [1, 2, 4];
    this.enemies = [];
    for (let fi = 0; fi < NUM_FLOORS; fi++) {
      const count = ENEMIES_PER_FLOOR[fi] ?? 1;
      for (let i = 0; i < count; i++) {
        const enemy = new Enemy(this.scene, this.maze, this.audio);
        enemy.spawn(fi);
        this.enemies.push(enemy);
      }
    }

    this.flashBattery  = 100;
    this.flashlightOn  = true;

    this.hudEl.style.display = 'block';
    this.player.requestLock();

    this.running = true;
    this.clock.start();
    this.loop();
  }

  private buildLights() {
    this.lights.forEach(l => this.scene.remove(l));
    this.lights = [];

    // Global fill — ensures nothing is ever pitch black
    const ambient = new THREE.AmbientLight(0x444444, 5.0);
    this.scene.add(ambient);
    this.lights.push(ambient);

    this.maze.floors.forEach((floor, fi) => {
      const yMid = fi * (WALL_HEIGHT + 1.0) + WALL_HEIGHT / 2;
      const theme = floor.theme;

      // Hemisphere (sky/ground) per floor
      const hemi = new THREE.HemisphereLight(theme.ambientColor, 0x000000, 3.0);
      hemi.position.y = yMid;
      this.scene.add(hemi);
      this.lights.push(hemi);

      // Sparse point lights spread across floor — scale with map size
      const W = floor.width, H = floor.height;
      const GRID = floor.type === 'village' ? 20 : floor.type === 'house' ? 10 : 6;
      const countX = Math.max(2, Math.floor(W / GRID));
      const countZ = Math.max(2, Math.floor(H / GRID));
      for (let iz = 0; iz < countZ; iz++) {
        for (let ix = 0; ix < countX; ix++) {
          const lx = Math.floor((ix + 0.5) * W / countX) * CELL_SIZE;
          const lz = Math.floor((iz + 0.5) * H / countZ) * CELL_SIZE;
          const light = new THREE.PointLight(theme.lightColor, 3.0, 40);
          light.position.set(lx, yMid + 0.3, lz);
          this.scene.add(light);
          this.lights.push(light);
        }
      }
    });

    this.updateFog(0);
  }

  private updateFog(floorIdx: number) {
    const theme = this.maze.floors[floorIdx].theme;
    this.scene.fog = new THREE.FogExp2(theme.fogColor, theme.fogDensity);
    this.renderer.setClearColor(theme.hasCeiling ? theme.fogColor : 0x01020a);
  }

  private loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t  = this.clock.getElapsedTime();

    // Flashlight battery
    this.updateFlashlight(dt);

    // Player
    const { stairsUp, isExit } = this.player.update(dt);
    if (stairsUp) { this.player.goUpFloor(); this.updateFog(this.player.floorIndex); }

    if (isExit && this.player.floorIndex === NUM_FLOORS - 1) {
      this.showMessage('¡ESCAPASTE!', '#0f8', 4000);
      this.endGame();
      return;
    }

    // Audio listener
    const pp  = this.player.getPosition();
    const fwd = this.player.getForwardDirection();
    this.audio.setListenerPose(pp.x, pp.y, pp.z, fwd.x, fwd.y, fwd.z);

    // Enemies
    for (const enemy of this.enemies) {
      const caught = enemy.update(dt, pp, this.player.floorIndex, this.camera, this.flashlightOn);
      if (caught) {
        this.showMessage('TE ATRAPÓ...', '#f44', 4000);
        this.endGame();
        return;
      }
    }

    this.updateHUD(t);
    this.mazeRenderer.update(t);
    this.horrorPass.uniforms['time'].value = t;
    this.composer.render();
  };

  private updateFlashlight(dt: number) {
    if (this.flashlightOn && this.flashBattery > 0) {
      this.flashBattery = Math.max(0, this.flashBattery - FLASHLIGHT_DRAIN * dt);
      if (this.flashBattery === 0) this.flashlightOn = false;
    } else if (!this.flashlightOn) {
      this.flashBattery = Math.min(100, this.flashBattery + FLASHLIGHT_CHARGE * dt);
    }
    this.flashlight.intensity = this.flashlightOn ? 20.0 * (this.flashBattery / 100) : 0;
    this.torchLight.intensity = this.flashlightOn ? 0.6 : 1.4;
  }

  private updateHUD(t: number) {
    const fi = this.player.floorIndex;
    this.floorTextEl.textContent =
      `PLANTA ${fi + 1} / ${NUM_FLOORS}  —  ${this.maze.floors[fi].theme.name.toUpperCase()}`;

    // Show the most threatening enemy state across all enemies on this floor
    let worstState: EnemyState = EnemyState.SEARCHING;
    for (const enemy of this.enemies) {
      if (enemy.floorIndex !== fi) continue;
      if (enemy.state === EnemyState.CHASING) { worstState = EnemyState.CHASING; break; }
      if (enemy.state === EnemyState.SPOTTED) worstState = EnemyState.SPOTTED;
    }
    let label = '◉ BUSCANDO', color = '#4af';
    if (worstState === EnemyState.CHASING) {
      label = '⬛ PERSIGUIENDO';
      color = `hsl(${Math.sin(t * 10) > 0 ? 0 : 20}, 100%, 55%)`;
    } else if (worstState === EnemyState.SPOTTED) {
      label = '! TE VIO !'; color = '#f80';
    }
    this.enemyIndicatorEl.textContent = label;
    this.enemyIndicatorEl.style.color = color;

    // Battery bar
    const pct = this.flashBattery;
    this.batteryFillEl.style.width = `${pct}%`;
    this.batteryFillEl.style.background =
      pct > 60 ? '#4af' : pct > 25 ? '#fa4' : '#f44';
    this.batteryIconEl.textContent = this.flashlightOn ? '🔦' : '🔋';
    this.flashStatusEl.textContent = this.flashlightOn ? 'ON' : 'OFF';
    this.flashStatusEl.style.color = this.flashlightOn ? '#4af' : '#888';
    this.batteryPctEl.textContent = `${Math.round(pct)}%`;

    this.drawMinimap();
  }

  private drawMinimap() {
    const fi    = this.player.floorIndex;
    const floor = this.maze.floors[fi];
    const W = floor.width, H = floor.height;
    const S = 120;
    const cellPx = S / Math.max(W, H);
    const ctx = this.minimapCtx;

    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, S, S);

    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const c  = floor.cells[z][x];
        const px = x * cellPx, pz = z * cellPx;
        const solid = c.walls.N && c.walls.S && c.walls.E && c.walls.W;
        if (solid)      { ctx.fillStyle = '#334'; ctx.fillRect(px, pz, cellPx, cellPx); }
        if (c.stairs === 'up') { ctx.fillStyle = '#fc4'; ctx.fillRect(px+1, pz+1, cellPx-2, cellPx-2); }
        if (c.isExit)   { ctx.fillStyle = '#0f8'; ctx.fillRect(px+1, pz+1, cellPx-2, cellPx-2); }
      }
    }

    const pc = this.maze.worldToCell(this.player.getPosition().x, this.player.getPosition().z, fi);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(pc.x * cellPx + cellPx/2, pc.z * cellPx + cellPx/2, cellPx, 0, Math.PI * 2);
    ctx.fill();

    for (const enemy of this.enemies) {
      if (enemy.floorIndex !== fi) continue;
      const ep = enemy.mesh.position;
      const ec = this.maze.worldToCell(ep.x, ep.z, fi);
      ctx.fillStyle = enemy.state === EnemyState.CHASING ? '#f44' : '#f84';
      ctx.beginPath();
      ctx.arc(ec.x * cellPx + cellPx/2, ec.z * cellPx + cellPx/2, cellPx * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private showMessage(text: string, color: string, duration: number) {
    this.messageEl.textContent = text;
    this.messageEl.style.color = color;
    this.messageEl.style.opacity = '1';
    setTimeout(() => { this.messageEl.style.opacity = '0'; }, duration);
  }

  private endGame() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.audio.stopEnemySound();
    document.exitPointerLock();
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
