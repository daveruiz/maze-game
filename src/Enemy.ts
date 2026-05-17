import * as THREE from 'three';
import { EnemyState, Cell } from './types';
import { MazeGenerator, CELL_SIZE, WALL_HEIGHT } from './Maze';
import { AudioManager } from './AudioManager';

const BASE_SEARCH_SPEED = 2.5;
const BASE_CHASE_SPEED  = 5.0;
const SPEED_SCALE_PER_FLOOR = 0.10; // +10% per floor
const SIGHT_RANGE       = 14;   // world units (flashlight on)
const SIGHT_RANGE_DARK  = 4;    // world units (flashlight off — very short)
const LOSE_RANGE        = 20;   // enemy loses sight beyond this
const CATCH_DISTANCE    = 1.2;
const PATH_UPDATE_INTERVAL = 0.5; // seconds

export class Enemy {
  mesh!: THREE.Mesh;
  private scene: THREE.Scene;
  private maze: MazeGenerator;
  private audio: AudioManager;
  private channelId: number = -1;

  state: EnemyState = EnemyState.SEARCHING;
  floorIndex: number = 0;
  homeFloor: number = 0;  // enemies stay on their assigned floor

  private pos: THREE.Vector3 = new THREE.Vector3();
  private path: THREE.Vector3[] = [];
  private pathTimer = 0;
  private searchTarget: THREE.Vector3 | null = null;
  private searchTimer = 0;
  private spotCooldown = 0;

  // For loss-of-sight tracking
  private lastKnownPlayerPos: THREE.Vector3 | null = null;
  private lostTimer = 0;

  // Directional sprites
  private texFront!: THREE.Texture;
  private texBack!:  THREE.Texture;
  private texSide!:  THREE.Texture;
  private mat!: THREE.MeshLambertMaterial;
  private moveDir: THREE.Vector3 = new THREE.Vector3(0, 0, -1); // current movement direction

  constructor(scene: THREE.Scene, maze: MazeGenerator, audio: AudioManager) {
    this.scene = scene;
    this.maze = maze;
    this.audio = audio;
    this.channelId = audio.createChannel();
    this.loadSprites();
  }

  private loadSprites() {
    const loader = new THREE.TextureLoader();

    // enemy-front.png = the face (front of creature)
    // enemy-back.png  = the back/spines
    // enemy-side.png  = side profile
    this.texFront = loader.load('/enemy-front.png');
    this.texBack  = loader.load('/enemy-back.png');
    this.texSide  = loader.load('/enemy-side.png');

    // Configure all textures
    [this.texFront, this.texBack, this.texSide].forEach(t => {
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
    });

    const geo = new THREE.PlaneGeometry(2.4, 2.55);
    this.mat = new THREE.MeshLambertMaterial({
      map: this.texFront,
      color: 0x666666,       // dark tint — barely visible without direct light
      transparent: true,
      alphaTest: 0.05,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
  }

  spawn(floorIndex: number) {
    this.floorIndex = floorIndex;
    this.homeFloor = floorIndex;

    // Build reachable set from the floor's entry cell via flood-fill
    const floor = this.maze.floors[floorIndex];
    const entry = floor.entryCell;
    const reachable = this.floodFill(floorIndex, entry.x, entry.z);

    // Pick a random reachable cell, prefer far from start
    const far = reachable.filter(c => c.x > 10 || c.z > 10);
    const candidates = far.length > 0 ? far : reachable;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];

    const wp = this.maze.cellToWorld(pick.x, pick.z, floorIndex);
    this.pos.copy(wp);
    this.pos.y += 1.28;  // half of sprite height (2.55/2)
    this.mesh.position.copy(this.pos);
    this.state = EnemyState.SEARCHING;
  }

  /** Flood-fill from a start cell — returns all reachable open cells */
  private floodFill(fi: number, sx: number, sz: number): Cell[] {
    const floor = this.maze.floors[fi];
    if (!floor) return [];
    const W = floor.width, H = floor.height;
    const visited = new Set<string>();
    const result: Cell[] = [];
    const queue: { x: number; z: number }[] = [{ x: sx, z: sz }];
    visited.add(`${sx},${sz}`);

    while (queue.length > 0) {
      const { x, z } = queue.shift()!;
      const cell = floor.cells[z]?.[x];
      if (!cell) continue;
      if (cell.hasObstacle) continue;
      result.push(cell);

      const tryMove = (nx: number, nz: number) => {
        const key = `${nx},${nz}`;
        if (nx >= 0 && nx < W && nz >= 0 && nz < H && !visited.has(key)) {
          visited.add(key);
          queue.push({ x: nx, z: nz });
        }
      };

      if (!cell.walls.N) tryMove(x, z - 1);
      if (!cell.walls.S) tryMove(x, z + 1);
      if (!cell.walls.E) tryMove(x + 1, z);
      if (!cell.walls.W) tryMove(x - 1, z);
    }
    return result;
  }

  update(dt: number, playerPos: THREE.Vector3, playerFloor: number, camera: THREE.Camera, flashlightOn = true): boolean {
    // Only active when player is on the same floor
    if (this.homeFloor !== playerFloor) {
      this.mesh.visible = false;
      this.audio.stopChannel(this.channelId);
      return false;
    }
    this.mesh.visible = true;

    // Per-floor speed scaling (+10% per floor)
    const speedMult = 1 + this.floorIndex * SPEED_SCALE_PER_FLOOR;

    this.pathTimer += dt;
    this.spotCooldown -= dt;

    const distToPlayer = this.pos.distanceTo(playerPos);
    // Flashlight affects sight: off = much shorter detection range
    const effectiveSight = flashlightOn ? SIGHT_RANGE : SIGHT_RANGE_DARK;
    const canSee = this.hasLineOfSight(playerPos) && distToPlayer < effectiveSight;

    // ── FSM ──────────────────────────────────────────────────────────────
    switch (this.state) {
      case EnemyState.SEARCHING:
        this.audio.playChannelState(this.channelId, 'searching');
        if (canSee) {
          this.state = EnemyState.SPOTTED;
          this.lastKnownPlayerPos = playerPos.clone();
          this.audio.playChannelState(this.channelId, 'spotted');
        } else {
          this.doSearch(dt, speedMult);
        }
        break;

      case EnemyState.SPOTTED:
        // Brief pause, then start chasing
        this.spotCooldown = 0.6;
        this.state = EnemyState.CHASING;
        this.lastKnownPlayerPos = playerPos.clone();
        break;

      case EnemyState.CHASING:
        this.audio.playChannelState(this.channelId, 'chasing');
        if (canSee) {
          this.lastKnownPlayerPos = playerPos.clone();
        }

        if (!canSee && distToPlayer > LOSE_RANGE) {
          // Lost the player
          this.state = EnemyState.SEARCHING;
          this.searchTarget = null;
          break;
        }

        this.doChase(dt, playerPos, speedMult);
        break;
    }

    // ── Billboard + directional sprite ──────────────────────────────────
    this.mesh.position.copy(this.pos);

    // Make the sprite plane face the camera (Y-axis billboard)
    const toCamera = camera.position.clone().sub(this.pos);
    toCamera.y = 0;
    const cameraAngle = Math.atan2(toCamera.x, toCamera.z);
    this.mesh.rotation.y = cameraAngle;

    // Determine which sprite to show based on angle between
    // enemy movement direction and camera-to-enemy direction
    this.updateSpriteDirection(toCamera);

    // Update audio position
    this.audio.setChannelPosition(this.channelId, this.pos.x, this.pos.y, this.pos.z);

    // Caught?
    return distToPlayer < CATCH_DISTANCE;
  }

  /**
   * Choose front/back/side sprite based on the angle between
   * the enemy's movement direction and the direction from enemy to camera.
   *
   * - Enemy moving TOWARD camera → show front (face)
   * - Enemy moving AWAY from camera → show back (spines)
   * - Enemy moving SIDEWAYS → show side (flip X for left vs right)
   */
  private updateSpriteDirection(toCamera: THREE.Vector3) {
    const moveDirFlat = this.moveDir.clone();
    moveDirFlat.y = 0;
    if (moveDirFlat.lengthSq() < 0.0001) {
      // Not moving — default to front (face the player)
      this.mat.map = this.texFront;
      this.mesh.scale.x = Math.abs(this.mesh.scale.x);
      return;
    }
    moveDirFlat.normalize();

    const camDir = toCamera.clone().normalize();

    // dot = cos(angle between movement dir and camera direction)
    // dot > 0 means enemy is moving TOWARD the camera (show front/face)
    // dot < 0 means enemy is moving AWAY from camera (show back/spines)
    const dot = moveDirFlat.dot(camDir);

    // cross Y component tells us left vs right
    const crossY = moveDirFlat.x * camDir.z - moveDirFlat.z * camDir.x;

    if (dot < -0.5) {
      // Moving toward camera → front (face)
      this.mat.map = this.texFront;
      this.mesh.scale.x = Math.abs(this.mesh.scale.x);
    } else if (dot > 0.5) {
      // Moving away from camera → back (spines)
      this.mat.map = this.texBack;
      this.mesh.scale.x = Math.abs(this.mesh.scale.x);
    } else {
      // Moving sideways → side sprite
      this.mat.map = this.texSide;
      // Flip for left vs right: negative crossY means moving to the right
      this.mesh.scale.x = crossY < 0
        ? -Math.abs(this.mesh.scale.x)
        :  Math.abs(this.mesh.scale.x);
    }
  }

  private doSearch(dt: number, speedMult: number) {
    this.searchTimer -= dt;
    if (!this.searchTarget || this.searchTimer <= 0 ||
        this.pos.distanceTo(this.searchTarget) < 0.5 || this.path.length === 0) {
      // Pick a new random nearby open cell
      const cells = this.maze.getOpenCells(this.floorIndex);
      const pick = cells[Math.floor(Math.random() * cells.length)];
      const wp = this.maze.cellToWorld(pick.x, pick.z, this.floorIndex);
      wp.y = this.pos.y;
      this.searchTarget = wp;
      this.searchTimer = 4 + Math.random() * 3;
      // Use BFS pathfinding so the enemy doesn't walk through walls
      this.path = this.bfsPath(this.pos, wp);
    }

    if (this.path.length > 0) {
      const next = this.path[0];
      const d = this.moveToward(next, BASE_SEARCH_SPEED * speedMult * dt);
      if (d < 0.4) this.path.shift();
    }
  }

  private doChase(dt: number, playerPos: THREE.Vector3, speedMult: number) {
    const canSeePlayer = this.hasLineOfSight(playerPos);

    if (canSeePlayer) {
      // Direct diagonal beeline toward the player — no grid restriction
      const target = playerPos.clone();
      target.y = this.pos.y;
      this.moveToward(target, BASE_CHASE_SPEED * speedMult * dt);
      this.path = []; // clear BFS path since we're going direct
    } else {
      // No line of sight — fall back to BFS grid pathfinding
      if (this.pathTimer >= PATH_UPDATE_INTERVAL || this.path.length === 0) {
        this.pathTimer = 0;
        this.path = this.bfsPath(this.pos, this.lastKnownPlayerPos ?? playerPos);
      }

      if (this.path.length > 0) {
        const next = this.path[0];
        const d = this.moveToward(next, BASE_CHASE_SPEED * speedMult * dt);
        if (d < 0.4) this.path.shift();
      }
    }
  }

  private moveToward(target: THREE.Vector3, maxDist: number): number {
    const diff = target.clone().sub(this.pos);
    diff.y = 0;
    const dist = diff.length();
    if (dist > 0.01) {
      const dir = diff.clone().normalize();
      // Smoothly update movement direction for sprite selection
      this.moveDir.lerp(dir, 0.15);
      this.moveDir.normalize();
      diff.normalize().multiplyScalar(Math.min(maxDist, dist));
      this.pos.add(diff);
    }
    return dist;
  }

  /** Simple BFS pathfinding on the maze grid */
  private bfsPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    const fi = this.floorIndex;
    const floor = this.maze.floors[fi];
    if (!floor) return [];

    const startCell = this.maze.worldToCell(from.x, from.z, fi);
    const endCell   = this.maze.worldToCell(to.x, to.z, fi);

    const W = floor.width;
    const H = floor.height;
    const inBounds = (x: number, z: number) => x >= 0 && x < W && z >= 0 && z < H;

    type Node = { x: number; z: number; parent: Node | null };
    const visited = new Set<string>();
    const queue: Node[] = [{ ...startCell, parent: null }];
    visited.add(`${startCell.x},${startCell.z}`);

    let found: Node | null = null;

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.x === endCell.x && cur.z === endCell.z) {
        found = cur;
        break;
      }
      const cell = floor.cells[cur.z]?.[cur.x];
      if (!cell) continue;

      const neighbors: { x: number; z: number }[] = [];
      if (!cell.walls.N && inBounds(cur.x, cur.z - 1)) neighbors.push({ x: cur.x, z: cur.z - 1 });
      if (!cell.walls.S && inBounds(cur.x, cur.z + 1)) neighbors.push({ x: cur.x, z: cur.z + 1 });
      if (!cell.walls.E && inBounds(cur.x + 1, cur.z)) neighbors.push({ x: cur.x + 1, z: cur.z });
      if (!cell.walls.W && inBounds(cur.x - 1, cur.z)) neighbors.push({ x: cur.x - 1, z: cur.z });

      for (const n of neighbors) {
        const key = `${n.x},${n.z}`;
        if (!visited.has(key)) {
          const nc = floor.cells[n.z]?.[n.x];
          if (nc?.hasObstacle) continue; // enemy can't jump, goes around
          visited.add(key);
          queue.push({ ...n, parent: cur });
        }
      }
    }

    if (!found) return [];

    // Reconstruct path
    const path: THREE.Vector3[] = [];
    let node: Node | null = found;
    while (node) {
      const wp = this.maze.cellToWorld(node.x, node.z, fi);
      wp.y = this.pos.y;
      path.unshift(wp);
      node = node.parent;
    }
    // Skip first (current position)
    if (path.length > 0) path.shift();
    return path;
  }

  /** Raycast-based line of sight against maze walls */
  private hasLineOfSight(playerPos: THREE.Vector3): boolean {
    const dir = playerPos.clone().sub(this.pos);
    const dist = dir.length();
    if (dist > SIGHT_RANGE * 1.5) return false;
    dir.normalize();

    const floor = this.maze.floors[this.floorIndex];
    if (!floor) return false;

    // Step along the ray and check if we pass through a wall
    const steps = Math.ceil(dist * 4);
    for (let i = 1; i < steps; i++) {
      const t = (i / steps) * dist;
      const px = this.pos.x + dir.x * t;
      const pz = this.pos.z + dir.z * t;
      const cx = Math.round(px / CELL_SIZE);
      const cz = Math.round(pz / CELL_SIZE);
      if (cx < 0 || cx >= floor.width || cz < 0 || cz >= floor.height) return false;
      // If this point is inside a solid cell (all walls), blocked
      const c = floor.cells[cz]?.[cx];
      if (c && c.walls.N && c.walls.S && c.walls.E && c.walls.W) return false;
    }
    return true;
  }

  getPosition(): THREE.Vector3 { return this.pos; }

  dispose() {
    this.scene.remove(this.mesh);
  }
}
