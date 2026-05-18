import * as THREE from 'three';
import { MazeGenerator, CELL_SIZE, WALL_HEIGHT, OBSTACLE_HEIGHT } from './Maze';

const MOVE_SPEED    = 7.5;
const PLAYER_HEIGHT = 1.6;
const PLAYER_RADIUS = 0.65;
const GRAVITY       = -24;
const JUMP_FORCE    = 9;
const WALL_MARGIN   = 0.55; // min distance from any wall face

export class Player {
  camera: THREE.PerspectiveCamera;
  private maze: MazeGenerator;
  floorIndex: number = 0;

  private keys: Record<string, boolean> = {};
  private yaw   = 0;
  private pitch  = 0;
  private locked = false;

  private pos: THREE.Vector3 = new THREE.Vector3();
  private verticalVelocity  = 0;
  private isOnGround        = true;
  private stairCooldown     = 0;

  constructor(camera: THREE.PerspectiveCamera, maze: MazeGenerator) {
    this.camera = camera;
    this.maze   = maze;
    this.setupInput();
  }

  spawn(floorIndex: number, cx = 1, cz = 1) {
    this.floorIndex = floorIndex;
    const wp = this.maze.cellToWorld(cx, cz, floorIndex);
    this.pos.set(wp.x, wp.y + PLAYER_HEIGHT, wp.z);
    this.verticalVelocity = 0;
    this.isOnGround = true;
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

    // Check each direction; prefer S, E, N, W
    // yaw 0 = looking toward -Z (north), PI = +Z (south)
    if (!cell.walls.S) return Math.PI;          // south (+Z)
    if (!cell.walls.E) return -Math.PI / 2;     // east (+X)
    if (!cell.walls.N) return 0;                // north (-Z)
    if (!cell.walls.W) return Math.PI / 2;      // west (-X)
    return 0;
  }

  private setupInput() {
    document.addEventListener('keydown', e => {
      this.keys[e.code] = true;
      if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.code === 'Space' && this.isOnGround) {
        this.verticalVelocity = JUMP_FORCE;
        this.isOnGround = false;
      }
    });
    document.addEventListener('keyup', e => { this.keys[e.code] = false; });

    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.yaw   -= e.movementX * 0.002;
      this.pitch  -= e.movementY * 0.002;
      this.pitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.pitch));
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = !!document.pointerLockElement;
    });
  }

  requestLock() { document.body.requestPointerLock(); }
  isLocked()    { return this.locked; }

  update(dt: number): { stairsUp: boolean; stairsDown: boolean; isExit: boolean } {
    this.stairCooldown -= dt;

    // Horizontal movement
    const fwd   = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3( Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const move  = new THREE.Vector3();

    if (this.keys['KeyW'] || this.keys['ArrowUp'])    move.add(fwd);
    if (this.keys['KeyS'] || this.keys['ArrowDown'])   move.sub(fwd);
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])   move.sub(right);
    if (this.keys['KeyD'] || this.keys['ArrowRight'])  move.add(right);
    if (move.length() > 0) move.normalize().multiplyScalar(MOVE_SPEED * dt);

    this.tryMove(move.x, 0);
    this.tryMove(0, move.z);

    // Vertical physics
    this.verticalVelocity += GRAVITY * dt;
    this.pos.y += this.verticalVelocity * dt;

    const cellPos = this.maze.worldToCell(this.pos.x, this.pos.z, this.floorIndex);
    const floor   = this.maze.floors[this.floorIndex];
    const cell    = floor?.cells[cellPos.z]?.[cellPos.x];
    const baseY   = this.floorIndex * (WALL_HEIGHT + 1.0);
    const groundY = baseY + (cell?.hasObstacle ? OBSTACLE_HEIGHT : 0) + PLAYER_HEIGHT;

    if (this.pos.y <= groundY) {
      this.pos.y = groundY;
      this.verticalVelocity = 0;
      this.isOnGround = true;
    } else {
      this.isOnGround = false;
    }

    // Wall depenetration — push away from any wall faces that are too close
    this.enforceWallMargin();

    // Camera
    this.camera.position.copy(this.pos);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;

    // Stair / exit detection
    if (!cell) return { stairsUp: false, stairsDown: false, isExit: false };
    let stairsUp = false, isExit = false;
    if (cell.stairs === 'up' && this.stairCooldown <= 0) { stairsUp = true; this.stairCooldown = 1.5; }
    if (cell.isExit) isExit = true;

    return { stairsUp, stairsDown: false, isExit };
  }

  /**
   * Push player away from any wall face that is too close.
   * Each wall is a line segment: N/S walls span the cell's X extent,
   * W/E walls span the cell's Z extent. We only apply the push when the
   * player is within that extent — otherwise walls from neighbouring cells
   * would incorrectly block movement through valid corridors.
   */
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

        // N/S walls are horizontal — only relevant when player X is within cell X extent
        const inX = this.pos.x >= wx - half && this.pos.x <= wx + half;
        // W/E walls are vertical — only relevant when player Z is within cell Z extent
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

      // Check all probe points for walls and solid cells
      for (const [ox, oz] of [[0,0],[PLAYER_RADIUS/CELL_SIZE,0],[-PLAYER_RADIUS/CELL_SIZE,0],[0,PLAYER_RADIUS/CELL_SIZE],[0,-PLAYER_RADIUS/CELL_SIZE]]) {
        const cx = Math.round(fx + ox), cz = Math.round(fz + oz);
        if (cx < 0 || cx >= floor.width || cz < 0 || cz >= floor.height) return false;
        const cell = floor.cells[cz]?.[cx];
        if (!cell) return false;
        if (cell.walls.N && cell.walls.S && cell.walls.E && cell.walls.W) return false;
      }

      // Obstacle check only against the CENTER cell — prevents getting stuck on edges
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
    this.verticalVelocity = 0;
    this.yaw = this.findOpenYaw(entry.x, entry.z, this.floorIndex);
    this.pitch = 0;
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = 0;
  }
}
