import * as THREE from 'three';
import { MazeGenerator, CELL_SIZE, WALL_HEIGHT, OBSTACLE_HEIGHT } from './Maze';
import { settings } from './Settings';

const BASE_SPEED    = 2.8125; // 25% slower than original 3.75
const SPRINT_MULT   = 2.0;    // shift doubles speed (back to original 7.5)
const EXHAUSTED_MULT = 0.5;   // half speed when stamina depleted
const CROUCH_MULT   = 0.4;   // slow when crouching
const PLAYER_HEIGHT = 1.6;
const CROUCH_HEIGHT = 0.7;   // camera height when crouching (bigger drop)
const PLAYER_RADIUS = 0.65;
const GRAVITY       = -24;
const JUMP_FORCE    = 7;
const WALL_MARGIN   = 0.55;

// Inertia
const ACCEL         = 28;     // units/s² — how fast we reach target speed
const FRICTION      = 12;     // units/s² — how fast we slow down when no input

// Stamina
const MAX_STAMINA        = 100;
const STAMINA_SPRINT_DRAIN = 10;  // per second while sprinting
const STAMINA_JUMP_COST   = 15;   // flat cost per jump
const STAMINA_REGEN       = 12;   // per second when not sprinting
const EXHAUSTED_THRESHOLD = 15;   // must recover to 15% before normal speed returns

export class Player {
  camera: THREE.PerspectiveCamera;
  private maze: MazeGenerator;
  floorIndex: number = 0;

  private keys: Record<string, boolean> = {};
  private yaw   = 0;
  private pitch  = 0;
  private locked = false;

  private pos: THREE.Vector3 = new THREE.Vector3();
  private velocity: THREE.Vector3 = new THREE.Vector3(); // horizontal velocity (inertia)
  private verticalVelocity  = 0;
  private isOnGround        = true;
  private wasOnGround       = true;
  private _preLandSpeed     = 0;
  /** True on the frame the player lands after being airborne */
  justLanded = false;
  /** Impact speed on landing (0 = soft step-down, higher = harder fall) */
  landingImpact = 0;
  /** True on the frame the player jumps */
  justJumped = false;
  /** True while the player is on the ground */
  onGround = true;
  private stairCooldown     = 0;

  // Stamina
  stamina   = MAX_STAMINA;
  private exhausted = false; // true when stamina hit 0, clears at 15%
  sprinting = false;
  crouching = false;
  private crouchToggled = false; // for toggle mode

  // Head bob
  private bobPhase = 0;         // oscillation phase (radians)
  private bobIntensity = 0;     // smoothed intensity (0 = still, 1 = full bob)
  /** Current horizontal speed — read by Game for footstep timing */
  currentSpeed = 0;

  // Smooth crouch (camera-only offset, doesn't affect physics)
  private currentCrouchDip = 0;

  constructor(camera: THREE.PerspectiveCamera, maze: MazeGenerator) {
    this.camera = camera;
    this.maze   = maze;
    this.setupInput();
  }

  spawn(floorIndex: number, cx = 1, cz = 1) {
    this.floorIndex = floorIndex;
    const wp = this.maze.cellToWorld(cx, cz, floorIndex);
    this.pos.set(wp.x, wp.y + PLAYER_HEIGHT, wp.z);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.isOnGround = true;
    this.stamina = MAX_STAMINA;
    this.exhausted = false;
    this.camera.position.copy(this.pos);

    // Face toward an open direction instead of a wall
    this.yaw = this.findOpenYaw(cx, cz, floorIndex);
    this.pitch = 0;
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = 0;
  }

  /** Find a yaw angle pointing toward an open neighbor cell */
  private findOpenYaw(cx: number, cz: number, fi: number): number {
    const floor = this.maze.floors[fi];
    if (!floor) return 0;
    const cell = floor.cells[cz]?.[cx];
    if (!cell) return 0;

    if (!cell.walls.S) return Math.PI;
    if (!cell.walls.E) return -Math.PI / 2;
    if (!cell.walls.N) return 0;
    if (!cell.walls.W) return Math.PI / 2;
    return 0;
  }

  private setupInput() {
    document.addEventListener('keydown', e => {
      this.keys[e.code] = true;
      if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
        e.preventDefault();
      }
      // Prevent Ctrl+W from closing the tab during gameplay
      if (e.code === 'KeyW' && (e.ctrlKey || e.metaKey) && this.locked) {
        e.preventDefault();
      }
      if (e.code === 'Space' && this.isOnGround && this.stamina >= STAMINA_JUMP_COST * 0.5) {
        this.verticalVelocity = JUMP_FORCE;
        this.isOnGround = false;
        this.justJumped = true;
        this.stamina = Math.max(0, this.stamina - STAMINA_JUMP_COST);
        if (this.stamina <= 0) this.exhausted = true;
      }
      // Toggle crouch on key press (when toggle mode is enabled)
      if ((e.code === 'KeyC' || e.code === 'ControlLeft' || e.code === 'ControlRight') && settings.get('toggleCrouch')) {
        this.crouchToggled = !this.crouchToggled;
      }
    });
    document.addEventListener('keyup', e => { this.keys[e.code] = false; });

    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      // Clamp to reject browser pointer-lock spikes (Chromium sometimes fires
      // movementX/Y in the hundreds on a single frame — causes view teleporting)
      const MAX_MOVEMENT = 150;  // px per event — well above any real flick
      let mx = e.movementX;
      let my = e.movementY;
      if (Math.abs(mx) > MAX_MOVEMENT || Math.abs(my) > MAX_MOVEMENT) return; // discard spike
      const sens = 0.002 * settings.get('mouseSensitivity');
      this.yaw   -= mx * sens;
      this.pitch  -= my * sens;
      this.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.pitch));
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = !!document.pointerLockElement;
    });
  }

  requestLock() { document.body.requestPointerLock(); }
  isLocked()    { return this.locked; }

  /** Reset crouch state (call on death) */
  resetCrouch() {
    this.crouching = false;
    this.crouchToggled = false;
    this.currentCrouchDip = 0;
  }

  /** Mobile: set a virtual key state */
  setKey(code: string, pressed: boolean) { this.keys[code] = pressed; }

  /** Mobile: apply look delta (touch drag) */
  applyLookDelta(dx: number, dy: number) {
    this.yaw   -= dx;
    this.pitch  -= dy;
    this.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.pitch));
  }

  /** Mobile: trigger jump (mirrors keydown Space logic) */
  triggerJump() {
    if (this.isOnGround && this.stamina >= STAMINA_JUMP_COST * 0.5) {
      this.verticalVelocity = JUMP_FORCE;
      this.isOnGround = false;
      this.justJumped = true;
      this.stamina = Math.max(0, this.stamina - STAMINA_JUMP_COST);
      if (this.stamina <= 0) this.exhausted = true;
    }
  }

  getYaw(): number { return this.yaw; }

  update(dt: number): { stairsUp: boolean; stairsDown: boolean; isExit: boolean } {
    this.stairCooldown -= dt;
    this.justJumped  = false;

    // ── Crouch, Sprint & stamina ──────────────────────────────────────
    const holdCrouch = !!(this.keys['KeyC'] || this.keys['ControlLeft'] || this.keys['ControlRight']);
    const wantCrouch = settings.get('toggleCrouch') ? this.crouchToggled : holdCrouch;
    const wantSprint = !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']);
    const hasInput = !!(this.keys['KeyW'] || this.keys['KeyS'] || this.keys['KeyA'] || this.keys['KeyD']
                      || this.keys['ArrowUp'] || this.keys['ArrowDown'] || this.keys['ArrowLeft'] || this.keys['ArrowRight']);
    this.crouching = wantCrouch && this.isOnGround;
    this.sprinting = wantSprint && hasInput && this.stamina > 0 && !this.exhausted && !this.crouching;

    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - STAMINA_SPRINT_DRAIN * dt);
      if (this.stamina <= 0) this.exhausted = true;
    } else {
      this.stamina = Math.min(MAX_STAMINA, this.stamina + STAMINA_REGEN * dt);
      if (this.exhausted && this.stamina >= EXHAUSTED_THRESHOLD) {
        this.exhausted = false;
      }
    }

    // ── Speed multiplier ────────────────────────────────────────────────
    let speedMult = 1.0;
    if (this.crouching) speedMult = CROUCH_MULT;
    else if (this.exhausted) speedMult = EXHAUSTED_MULT;
    else if (this.sprinting) speedMult = SPRINT_MULT;

    const targetSpeed = BASE_SPEED * speedMult;

    // ── Desired direction ───────────────────────────────────────────────
    const fwd   = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3( Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wishDir = new THREE.Vector3();

    if (this.keys['KeyW'] || this.keys['ArrowUp'])    wishDir.add(fwd);
    if (this.keys['KeyS'] || this.keys['ArrowDown'])   wishDir.sub(fwd);
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])   wishDir.sub(right);
    if (this.keys['KeyD'] || this.keys['ArrowRight'])  wishDir.add(right);

    // ── Inertia ─────────────────────────────────────────────────────────
    if (wishDir.lengthSq() > 0) {
      wishDir.normalize();
      const wishVel = wishDir.multiplyScalar(targetSpeed);
      // Accelerate toward desired velocity
      const diff = wishVel.clone().sub(this.velocity);
      const accelAmount = ACCEL * dt;
      if (diff.length() <= accelAmount) {
        this.velocity.copy(wishVel);
      } else {
        this.velocity.add(diff.normalize().multiplyScalar(accelAmount));
      }
    } else {
      // No input — apply friction to slow down
      const speed = this.velocity.length();
      if (speed > 0.01) {
        const drop = FRICTION * dt;
        const newSpeed = Math.max(0, speed - drop);
        this.velocity.multiplyScalar(newSpeed / speed);
      } else {
        this.velocity.set(0, 0, 0);
      }
    }

    // Apply horizontal velocity
    const move = this.velocity.clone().multiplyScalar(dt);
    this.tryMove(move.x, 0);
    this.tryMove(0, move.z);

    // Vertical physics
    this.verticalVelocity += GRAVITY * dt;
    this.pos.y += this.verticalVelocity * dt;

    const cellPos = this.maze.worldToCell(this.pos.x, this.pos.z, this.floorIndex);
    const floor   = this.maze.floors[this.floorIndex];
    const cell    = floor?.cells[cellPos.z]?.[cellPos.x];
    const baseY   = this.floorIndex * (WALL_HEIGHT + 1.0);
    // Crouch is a camera-only offset — physics always use full PLAYER_HEIGHT
    const crouchOffset = PLAYER_HEIGHT - CROUCH_HEIGHT; // how much to lower camera
    const targetCrouchDip = this.crouching ? crouchOffset : 0;
    const crouchSpeed = 10.0;
    this.currentCrouchDip += (targetCrouchDip - this.currentCrouchDip) * Math.min(1, crouchSpeed * dt);

    const groundY = baseY + (cell?.hasObstacle ? OBSTACLE_HEIGHT : 0) + PLAYER_HEIGHT;

    if (this.pos.y <= groundY) {
      this._preLandSpeed = Math.abs(this.verticalVelocity);
      this.pos.y = groundY;
      this.verticalVelocity = 0;
      this.isOnGround = true;
    } else {
      this.isOnGround = false;
    }

    // Expose landing event + impact magnitude
    this.justLanded = this.isOnGround && !this.wasOnGround;
    if (this.justLanded) {
      // Impact proportional to how fast we were falling (verticalVelocity is already 0 here,
      // so we track it before the ground clamp — use wasOnGround + gravity to estimate)
      // We stored pre-clamp velocity below
      this.landingImpact = this._preLandSpeed;
    }
    this.onGround = this.isOnGround;
    this.wasOnGround = this.isOnGround;

    // ── Speed tracking ────────────────────────────────────────────────────
    const hSpeed = this.velocity.length();
    this.currentSpeed = hSpeed;
    const speedT = Math.min(1, hSpeed / (BASE_SPEED * SPRINT_MULT));

    // Ceiling clamp — prevent jumping through ceiling on floors that have one
    if (floor?.theme.hasCeiling) {
      const ceilY = baseY + WALL_HEIGHT - 0.1; // small margin below ceiling plane
      if (this.pos.y > ceilY) {
        this.pos.y = ceilY;
        this.verticalVelocity = 0;
      }
    }

    // Wall depenetration
    this.enforceWallMargin();

    // ── Head bob ─────────────────────────────────────────────────────────
    // Smooth bob intensity (ramps up/down naturally)
    const targetIntensity = this.isOnGround && hSpeed > 0.3 ? speedT : 0;
    const bobSmooth = targetIntensity > this.bobIntensity ? 8.0 : 4.0;
    this.bobIntensity += (targetIntensity - this.bobIntensity) * Math.min(1, bobSmooth * dt);

    // Frequency synced with footstep interval (0.5s walk → 0.3s sprint)
    const bobFreq = 1 / (0.625 - speedT * 0.25);
    this.bobPhase += bobFreq * dt * Math.PI * 2;

    // Vertical bob: subtle — max ~3cm at full sprint
    const BOB_Y = 0.03;
    // Horizontal sway: very subtle lateral rock — max ~1.5cm
    const BOB_X = 0.015;
    // Slight pitch tilt for natural head movement
    const BOB_PITCH = 0.004;

    const bobY = Math.sin(this.bobPhase) * BOB_Y * this.bobIntensity;
    const bobX = Math.sin(this.bobPhase * 0.5) * BOB_X * this.bobIntensity;
    const bobPitch = Math.sin(this.bobPhase) * BOB_PITCH * this.bobIntensity;

    // Camera
    this.camera.position.copy(this.pos);
    this.camera.position.y += bobY - this.currentCrouchDip;
    // Apply lateral sway in camera-local right direction
    this.camera.position.x += Math.cos(this.yaw) * bobX;
    this.camera.position.z -= Math.sin(this.yaw) * bobX;

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch + bobPitch;

    // Stair / exit detection
    if (!cell) return { stairsUp: false, stairsDown: false, isExit: false };
    let stairsUp = false, isExit = false;
    if (cell.stairs === 'up' && this.stairCooldown <= 0) { stairsUp = true; this.stairCooldown = 1.5; }
    if (cell.isExit) isExit = true;

    return { stairsUp, stairsDown: false, isExit };
  }

  private enforceWallMargin() {
    const floor = this.maze.floors[this.floorIndex];
    if (!floor) return;

    const cx = Math.round(this.pos.x / CELL_SIZE);
    const cz = Math.round(this.pos.z / CELL_SIZE);

    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= floor.width || nz < 0 || nz >= floor.height) continue;
        const c = floor.cells[nz]?.[nx];
        if (!c) continue;

        const wx = nx * CELL_SIZE;
        const wz = nz * CELL_SIZE;
        const half = CELL_SIZE / 2;

        const inX = this.pos.x >= wx - half && this.pos.x <= wx + half;
        const inZ = this.pos.z >= wz - half && this.pos.z <= wz + half;

        if (c.walls.N && inX) this.pushZ(wz - half);
        if (c.walls.S && inX) this.pushZ(wz + half);
        if (c.walls.W && inZ) this.pushX(wx - half);
        if (c.walls.E && inZ) this.pushX(wx + half);
      }
    }
  }

  private pushZ(face: number) {
    const dist = this.pos.z - face;
    if (dist > -WALL_MARGIN && dist < WALL_MARGIN)
      this.pos.z = face + (dist >= 0 ? WALL_MARGIN : -WALL_MARGIN);
  }

  private pushX(face: number) {
    const dist = this.pos.x - face;
    if (dist > -WALL_MARGIN && dist < WALL_MARGIN)
      this.pos.x = face + (dist >= 0 ? WALL_MARGIN : -WALL_MARGIN);
  }

  private tryMove(dx: number, dz: number) {
    const floor = this.maze.floors[this.floorIndex];
    if (!floor) return;
    const nx = this.pos.x + dx, nz = this.pos.z + dz;
    if (this.canPass(nx / CELL_SIZE, nz / CELL_SIZE, floor)) {
      this.pos.x = nx;
      this.pos.z = nz;
    } else {
      // Kill velocity component on collision so inertia doesn't keep pushing into wall
      if (dx !== 0) this.velocity.x = 0;
      if (dz !== 0) this.velocity.z = 0;
    }
  }

  private canPass(fxNew: number, fzNew: number, floor: { cells: any[][]; width: number; height: number }): boolean {
    const fxPrev = this.pos.x / CELL_SIZE;
    const fzPrev = this.pos.z / CELL_SIZE;
    const baseY  = this.floorIndex * (WALL_HEIGHT + 1.0);
    const steps  = 4;

    for (let i = 1; i <= steps; i++) {
      const t  = i / steps;
      const fx = fxPrev + (fxNew - fxPrev) * t;
      const fz = fzPrev + (fzNew - fzPrev) * t;

      for (const [ox, oz] of [[0,0],[PLAYER_RADIUS/CELL_SIZE,0],[-PLAYER_RADIUS/CELL_SIZE,0],[0,PLAYER_RADIUS/CELL_SIZE],[0,-PLAYER_RADIUS/CELL_SIZE]]) {
        const cx = Math.round(fx + ox), cz = Math.round(fz + oz);
        if (cx < 0 || cx >= floor.width || cz < 0 || cz >= floor.height) return false;
        const cell = floor.cells[cz]?.[cx];
        if (!cell) return false;
        if (cell.walls.N && cell.walls.S && cell.walls.E && cell.walls.W) return false;
      }

      const ccx = Math.round(fx), ccz = Math.round(fz);
      const centerCell = floor.cells[ccz]?.[ccx];
      if (centerCell?.hasObstacle && this.pos.y < baseY + OBSTACLE_HEIGHT + PLAYER_HEIGHT - 0.1) return false;
    }
    return true;
  }

  getPosition(): THREE.Vector3 { return this.pos.clone(); }

  getForwardDirection(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
  }

  goUpFloor(entryX?: number, entryZ?: number) {
    if (this.floorIndex >= this.maze.floors.length - 1) return;
    this.floorIndex++;
    this.stairCooldown = 1.5;
    const entry = this.maze.floors[this.floorIndex].entryCell;
    const cx = entryX ?? entry.x, cz = entryZ ?? entry.z;
    const wp = this.maze.cellToWorld(cx, cz, this.floorIndex);
    this.pos.set(wp.x, wp.y + PLAYER_HEIGHT + 0.5, wp.z);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.yaw = this.findOpenYaw(cx, cz, this.floorIndex);
    this.pitch = 0;
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = 0;
  }

  goDownFloor() {
    if (this.floorIndex <= 0) return;
    this.floorIndex--;
    this.stairCooldown = 1.5;
    const entry = this.maze.floors[this.floorIndex].entryCell;
    const wp = this.maze.cellToWorld(entry.x, entry.z, this.floorIndex);
    this.pos.set(wp.x, wp.y + PLAYER_HEIGHT + 0.5, wp.z);
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.yaw = this.findOpenYaw(entry.x, entry.z, this.floorIndex);
    this.pitch = 0;
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = 0;
  }
}
