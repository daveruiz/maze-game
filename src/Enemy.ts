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

// Separation — enemies prefer patrol targets far from siblings
const SEPARATION_RADIUS  = 12;  // world units — penalise targets near siblings

// Stuck detection
const STUCK_CHECK_INTERVAL = 2.0; // seconds
const STUCK_DISTANCE       = 1.0; // if moved less than this in the interval, considered stuck

// Investigation after losing sight
const INVESTIGATE_DURATION = 4.0; // seconds to investigate area after losing player
const INVESTIGATE_RADIUS   = 8;   // pick cells within this radius of last known pos

// Alert system
const ALERT_RANGE = 30; // world units — other enemies within this get alerted

export class Enemy {
  mesh!: THREE.Mesh;
  private scene: THREE.Scene;
  private maze: MazeGenerator;
  private audio: AudioManager;
  private channelId: number = -1;

  state: EnemyState = EnemyState.SEARCHING;
  floorIndex: number = 0;
  homeFloor: number = 0;

  private pos: THREE.Vector3 = new THREE.Vector3();
  private path: THREE.Vector3[] = [];
  private pathTimer = 0;
  private searchTarget: THREE.Vector3 | null = null;
  private searchTimer = 0;
  private spotCooldown = 0;

  // For loss-of-sight tracking
  private lastKnownPlayerPos: THREE.Vector3 | null = null;
  private lostTimer = 0;

  // Investigation state
  private investigateTimer = 0;
  private investigateTarget: THREE.Vector3 | null = null;

  // Stuck detection
  private stuckCheckTimer = 0;
  private stuckCheckPos: THREE.Vector3 = new THREE.Vector3();

  // Patrol zone — each enemy is assigned a zone index for spatial distribution
  private patrolZone = 0;
  // Reachable cells from spawn point — only patrol within these
  private reachableCells: Cell[] = [];

  // Reference to siblings for separation + alerts
  private siblings: Enemy[] = [];

  // Key-collected "smell" system — enemies are attracted toward player area
  private keyCollected = false;
  private playerHint: THREE.Vector3 = new THREE.Vector3();
  // Track last patrol target to ensure diversity (go far from where we just were)
  private lastPatrolCell: { x: number; z: number } | null = null;

  // Directional sprites
  private texFront!: THREE.Texture;
  private texBack!:  THREE.Texture;
  private texSide!:  THREE.Texture;
  private mat!: THREE.MeshLambertMaterial;
  private moveDir: THREE.Vector3 = new THREE.Vector3(0, 0, -1);

  constructor(scene: THREE.Scene, maze: MazeGenerator, audio: AudioManager) {
    this.scene = scene;
    this.maze = maze;
    this.audio = audio;
    this.channelId = audio.createChannel();
    this.loadSprites();
  }

  /** Set sibling enemies (all enemies on the same floor) for separation & alerts */
  setSiblings(siblings: Enemy[]) {
    this.siblings = siblings;
  }

  /** Set the patrol zone index (0, 1, 2, ...) for spatial distribution */
  setPatrolZone(zone: number) {
    this.patrolZone = zone;
  }

  /** Notify this enemy that the key was collected on its floor — start "smelling" the player */
  setKeyCollected(collected: boolean) {
    if (collected && !this.keyCollected) {
      console.log(`[Enemy z${this.patrolZone} f${this.floorIndex}] KEY COLLECTED — switching to HUNT mode`);
    }
    this.keyCollected = collected;
  }

  /** Update the player position hint (used for attraction when key is collected) */
  setPlayerHint(pos: THREE.Vector3) {
    this.playerHint.copy(pos);
  }

  private loadSprites() {
    const loader = new THREE.TextureLoader();
    this.texFront = loader.load('enemy-front.png');
    this.texBack  = loader.load('enemy-back.png');
    this.texSide  = loader.load('enemy-side.png');

    [this.texFront, this.texBack, this.texSide].forEach(t => {
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
    });

    const geo = new THREE.PlaneGeometry(2.4, 2.55);
    this.mat = new THREE.MeshLambertMaterial({
      map: this.texFront,
      color: 0x666666,
      emissive: 0xffffff,
      emissiveIntensity: 0.03,
      transparent: true,
      alphaTest: 0.05,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
  }

  /**
   * Spawn near an assigned interest point (key, stairs, exit) but far from
   * the player entry and from already-spawned siblings. Each enemy is assigned
   * a different interest point via its patrol zone index.
   */
  spawn(floorIndex: number, existingPositions: THREE.Vector3[] = [], interestPoints: THREE.Vector3[] = []) {
    this.floorIndex = floorIndex;
    this.homeFloor = floorIndex;

    const floor = this.maze.floors[floorIndex];
    const entry = floor.entryCell;
    const W = floor.width, H = floor.height;
    // Use enemy BFS (excludes obstacle cells — enemies can't jump them)
    const reachable = this.bfsReachableFrom(entry.x, entry.z, floorIndex);
    this.reachableCells = reachable;

    // Assign each enemy a different map quadrant for spatial distribution
    // This ensures enemies start spread across the map, not clustered
    const numEnemies = Math.max(1, existingPositions.length + 1);
    const quadAngle = (this.patrolZone / numEnemies) * Math.PI * 2;
    const quadCenterX = W / 2 + (W / 4) * Math.cos(quadAngle);
    const quadCenterZ = H / 2 + (H / 4) * Math.sin(quadAngle);

    let bestScore = -Infinity;
    let bestCell = reachable[0];
    const MIN_DIST_FROM_PLAYER = 10; // cells — hard minimum distance from entry
    for (const c of reachable) {
      const dx = c.x - entry.x, dz = c.z - entry.z;
      const distFromEntry = Math.sqrt(dx * dx + dz * dz);
      // Must be far from entry (where player spawns)
      let score = Math.min(distFromEntry, 25);
      // Heavy penalty if too close to player spawn
      if (distFromEntry < MIN_DIST_FROM_PLAYER) {
        score -= (MIN_DIST_FROM_PLAYER - distFromEntry) * 10;
      }

      // Prefer cells near assigned quadrant center (strong spatial spread)
      const qdx = c.x - quadCenterX;
      const qdz = c.z - quadCenterZ;
      const quadDist = Math.sqrt(qdx * qdx + qdz * qdz);
      score -= quadDist * 0.8;

      // Mild attraction to interest points (but NOT dominant)
      if (interestPoints.length > 0) {
        let nearestIP = Infinity;
        for (const ip of interestPoints) {
          const ipc = this.maze.worldToCell(ip.x, ip.z, floorIndex);
          const ipDist = Math.sqrt((c.x - ipc.x) ** 2 + (c.z - ipc.z) ** 2);
          nearestIP = Math.min(nearestIP, ipDist);
        }
        // Small bonus for being somewhat near any interest point (5-20 cells)
        if (nearestIP < 5) score -= (5 - nearestIP) * 2;
        else if (nearestIP < 20) score += (20 - nearestIP) * 0.3;
      }

      // Far from already-placed enemies (very strong separation)
      for (const ep of existingPositions) {
        const ec = this.maze.worldToCell(ep.x, ep.z, floorIndex);
        const eDist = Math.sqrt((c.x - ec.x) ** 2 + (c.z - ec.z) ** 2);
        score += Math.min(eDist, 40) * 2.0;
      }

      score += Math.random() * 4;

      if (score > bestScore) {
        bestScore = score;
        bestCell = c;
      }
    }

    const wp = this.maze.cellToWorld(bestCell.x, bestCell.z, floorIndex);
    this.pos.copy(wp);
    this.pos.y += 1.28;
    this.mesh.position.copy(this.pos);
    this.stuckCheckPos.copy(this.pos);
    this.state = EnemyState.SEARCHING;
  }

  /** Alert this enemy to investigate a position (called by siblings) */
  alertTo(targetPos: THREE.Vector3) {
    if (this.state === EnemyState.CHASING) return; // already chasing, ignore
    this.state = EnemyState.SEARCHING;
    this.lastKnownPlayerPos = targetPos.clone();
    // Pick an investigation point offset from the alert position
    // so multiple alerted enemies converge from different angles
    this.investigateTimer = INVESTIGATE_DURATION;
    this.investigateTarget = this.pickInvestigatePoint(targetPos);
    this.path = this.smoothPath(this.bfsPath(this.pos, this.investigateTarget));
    this.searchTimer = INVESTIGATE_DURATION + 1; // don't override with random search
  }

  update(dt: number, playerPos: THREE.Vector3, playerFloor: number, camera: THREE.Camera, flashlightOn = true): boolean {
    // Only active when player is on the same floor
    if (this.homeFloor !== playerFloor) {
      this.mesh.visible = false;
      this.audio.stopChannel(this.channelId);
      return false;
    }
    this.mesh.visible = true;

    const speedMult = 1 + this.floorIndex * SPEED_SCALE_PER_FLOOR;

    this.pathTimer += dt;
    this.spotCooldown -= dt;

    // Stuck detection — covers searching + investigating (not chasing)
    this.stuckCheckTimer += dt;
    if (this.stuckCheckTimer >= STUCK_CHECK_INTERVAL) {
      const movedDist = this.pos.distanceTo(this.stuckCheckPos);
      if (movedDist < STUCK_DISTANCE && this.state !== EnemyState.CHASING) {
        // Snap to nearest valid reachable cell first (may be stuck in a wall)
        this.snapToNearestReachable();
        // Then force a new path to a far-away reachable cell
        const cells = this.reachableCells.filter(c => !c.hasObstacle);
        if (cells.length > 0) {
          const myCell = this.maze.worldToCell(this.pos.x, this.pos.z, this.floorIndex);
          // Pick a cell far from current position
          let bestDist = -1;
          let bestPick = cells[0];
          for (let i = 0; i < Math.min(cells.length, 40); i++) {
            const c = cells[Math.floor(Math.random() * cells.length)];
            const d = Math.abs(c.x - myCell.x) + Math.abs(c.z - myCell.z);
            if (d > bestDist) { bestDist = d; bestPick = c; }
          }
          const wp = this.maze.cellToWorld(bestPick.x, bestPick.z, this.floorIndex);
          wp.y = this.pos.y;
          this.searchTarget = wp;
          this.path = this.smoothPath(this.bfsPath(this.pos, wp));
          this.searchTimer = 12;
          this.investigateTimer = 0; // cancel investigation if stuck
        }
      }
      this.stuckCheckPos.copy(this.pos);
      this.stuckCheckTimer = 0;
    }

    // Separation is handled at target-selection level (pickPatrolTarget scores
    // cells far from siblings). No runtime movement force — avoids pushing into walls.

    const distToPlayer = this.pos.distanceTo(playerPos);
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
          this.alertSiblings(playerPos);
          console.log(`[Enemy z${this.patrolZone} f${this.floorIndex}] SPOTTED player at dist ${distToPlayer.toFixed(1)}`);
        } else if (this.investigateTimer > 0) {
          // Investigating an alert or last-known position
          this.investigateTimer -= dt;
          this.doInvestigate(dt, speedMult);
        } else {
          this.doSearch(dt, speedMult);
        }
        break;

      case EnemyState.SPOTTED:
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
          console.log(`[Enemy z${this.patrolZone} f${this.floorIndex}] LOST player at dist ${distToPlayer.toFixed(1)}`);
          // Lost the player — validate position (chase beeline may have pushed into walls)
          this.snapToNearestReachable();
          // Start investigating the area
          this.state = EnemyState.SEARCHING;
          this.investigateTimer = INVESTIGATE_DURATION;
          this.investigateTarget = this.pickInvestigatePoint(
            this.lastKnownPlayerPos ?? playerPos
          );
          this.path = this.smoothPath(this.bfsPath(this.pos, this.investigateTarget));
          break;
        }

        this.doChase(dt, playerPos, speedMult);
        break;
    }

    // ── Billboard + directional sprite ──────────────────────────────────
    this.mesh.position.copy(this.pos);

    const toCamera = camera.position.clone().sub(this.pos);
    toCamera.y = 0;
    const cameraAngle = Math.atan2(toCamera.x, toCamera.z);
    this.mesh.rotation.y = cameraAngle;

    this.updateSpriteDirection(toCamera);

    // Update audio position
    this.audio.setChannelPosition(this.channelId, this.pos.x, this.pos.y, this.pos.z);

    // Caught?
    return distToPlayer < CATCH_DISTANCE;
  }

  /** Alert nearby siblings that the player was spotted */
  private alertSiblings(playerPos: THREE.Vector3) {
    for (const sib of this.siblings) {
      if (sib === this) continue;
      if (sib.homeFloor !== this.homeFloor) continue;
      const dist = sib.pos.distanceTo(this.pos);
      if (dist < ALERT_RANGE) {
        sib.alertTo(playerPos);
      }
    }
  }

  /** Pick an investigation point near a target, offset by patrol zone for spread */
  private pickInvestigatePoint(center: THREE.Vector3): THREE.Vector3 {
    const floor = this.maze.floors[this.floorIndex];
    if (!floor) return center.clone();

    const centerCell = this.maze.worldToCell(center.x, center.z, this.floorIndex);
    // Always exclude obstacle cells — enemies cannot traverse them
    const cells = this.reachableCells.filter(c => !c.hasObstacle);

    // Find cells within investigation radius of the center
    const nearby = cells.filter(c => {
      const dx = c.x - centerCell.x;
      const dz = c.z - centerCell.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      return dist > 2 && dist < INVESTIGATE_RADIUS / CELL_SIZE + 5;
    });

    if (nearby.length === 0) return center.clone();

    // Use patrol zone to pick from different angular sectors
    // so alerted enemies approach from different directions
    const zoneAngle = (this.patrolZone / Math.max(1, this.siblings.length)) * Math.PI * 2;
    const scored = nearby.map(c => {
      const dx = c.x - centerCell.x;
      const dz = c.z - centerCell.z;
      const angle = Math.atan2(dz, dx);
      // Score: prefer cells in our zone's angular sector
      const angleDiff = Math.abs(((angle - zoneAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      return { cell: c, score: -angleDiff }; // higher is better
    });
    scored.sort((a, b) => b.score - a.score);

    const pick = scored[Math.floor(Math.random() * Math.min(5, scored.length))].cell;
    const wp = this.maze.cellToWorld(pick.x, pick.z, this.floorIndex);
    wp.y = this.pos.y;
    return wp;
  }

  /** Investigation movement: go to investigation target, then wander nearby */
  private doInvestigate(dt: number, speedMult: number) {
    if (!this.investigateTarget) {
      this.investigateTimer = 0;
      return;
    }

    // If we've reached the investigate target, pick a new nearby one
    if (this.path.length === 0 || this.pos.distanceTo(this.investigateTarget) < 1.0) {
      if (this.lastKnownPlayerPos) {
        this.investigateTarget = this.pickInvestigatePoint(this.lastKnownPlayerPos);
        this.path = this.smoothPath(this.bfsPath(this.pos, this.investigateTarget));
      } else {
        this.investigateTimer = 0;
        return;
      }
    }

    if (this.path.length > 0) {
      const next = this.path[0];
      const d = this.moveToward(next, BASE_CHASE_SPEED * 0.7 * speedMult * dt);
      if (d < 0.4) this.path.shift();
    }
  }

  /**
   * Choose front/back/side sprite based on the angle between
   * the enemy's movement direction and the direction from enemy to camera.
   */
  private updateSpriteDirection(toCamera: THREE.Vector3) {
    const moveDirFlat = this.moveDir.clone();
    moveDirFlat.y = 0;
    if (moveDirFlat.lengthSq() < 0.0001) {
      this.mat.map = this.texFront;
      this.mesh.scale.x = Math.abs(this.mesh.scale.x);
      return;
    }
    moveDirFlat.normalize();

    const camDir = toCamera.clone().normalize();
    const dot = moveDirFlat.dot(camDir);
    const crossY = moveDirFlat.x * camDir.z - moveDirFlat.z * camDir.x;

    if (dot < -0.5) {
      this.mat.map = this.texFront;
      this.mesh.scale.x = Math.abs(this.mesh.scale.x);
    } else if (dot > 0.5) {
      this.mat.map = this.texBack;
      this.mesh.scale.x = Math.abs(this.mesh.scale.x);
    } else {
      this.mat.map = this.texSide;
      this.mesh.scale.x = crossY < 0
        ? -Math.abs(this.mesh.scale.x)
        :  Math.abs(this.mesh.scale.x);
    }
  }

  private doSearch(dt: number, speedMult: number) {
    this.searchTimer -= dt;
    const reason =
      !this.searchTarget ? 'no target' :
      this.searchTimer <= 0 ? 'timer expired' :
      this.pos.distanceTo(this.searchTarget) < 1.5 ? 'reached target' :
      this.path.length === 0 ? 'empty path' : null;

    if (reason) {
      this.searchTarget = this.pickPatrolTarget();
      this.path = this.bfsPath(this.pos, this.searchTarget);
      this.path = this.smoothPath(this.path);
      // Timer based on actual walk distance (smoothed waypoints can be far apart)
      // When key is collected, re-pick faster so enemies track the player's movement
      const speed = BASE_SEARCH_SPEED * (1 + this.floorIndex * SPEED_SCALE_PER_FLOOR);
      const walkTime = this.pathWalkDistance(this.path) / speed;
      this.searchTimer = this.keyCollected
        ? Math.max(3, Math.min(walkTime, 6) + 1 + Math.random() * 2)  // cap at ~9s, re-pick aggressively
        : Math.max(8, walkTime + 4 + Math.random() * 3);

      const myCell = this.maze.worldToCell(this.pos.x, this.pos.z, this.floorIndex);
      const tgtCell = this.maze.worldToCell(this.searchTarget.x, this.searchTarget.z, this.floorIndex);
      console.log(
        `[Enemy z${this.patrolZone} f${this.floorIndex}] new target ` +
        `(${myCell.x},${myCell.z})→(${tgtCell.x},${tgtCell.z}) | ` +
        `reason: ${reason} | key: ${this.keyCollected} | ` +
        `pathSteps: ${this.path.length} | walkDist: ${this.pathWalkDistance(this.path).toFixed(0)} | ` +
        `timer: ${this.searchTimer.toFixed(1)}s`
      );
    }

    if (this.path.length > 0) {
      const next = this.path[0];
      const d = this.moveToward(next, BASE_SEARCH_SPEED * speedMult * dt);
      if (d < 0.4) this.path.shift();
    }
  }

  /** Pick a patrol target — uses BFS distance map so enemies travel through
   *  the actual maze topology, not just grid Euclidean distance. This prevents
   *  enemies from staying in one corridor on room-based levels like La Casa. */
  private pickPatrolTarget(): THREE.Vector3 {
    const cells = this.reachableCells.filter(c => !c.hasObstacle);
    const floor = this.maze.floors[this.floorIndex];
    if (!floor || cells.length === 0) return this.pos.clone();

    const myCell = this.maze.worldToCell(this.pos.x, this.pos.z, this.floorIndex);

    // Build BFS distance map from current position — gives REAL travel distance
    // to every reachable cell (accounts for corridors, rooms, dead ends)
    const distMap = this.bfsDistanceMap(myCell.x, myCell.z);

    // Also build distance map from last patrol target for diversity
    let lastDistMap: Map<string, number> | null = null;
    if (this.lastPatrolCell) {
      lastDistMap = this.bfsDistanceMap(this.lastPatrolCell.x, this.lastPatrolCell.z);
    }

    // Player cell (used when key is collected — "smell" attraction)
    const playerCell = this.keyCollected
      ? this.maze.worldToCell(this.playerHint.x, this.playerHint.z, this.floorIndex)
      : null;
    let playerDistMap: Map<string, number> | null = null;
    if (playerCell) {
      // Smell propagates through obstacles (they're low blocks, not walls)
      playerDistMap = this.bfsDistanceMap(playerCell.x, playerCell.z, true);
    }

    // Score each candidate cell
    let bestScore = -Infinity;
    let bestCell = cells[0];
    const sampleSize = Math.min(cells.length, 150);
    const step = Math.max(1, Math.floor(cells.length / sampleSize));

    for (let i = 0; i < cells.length; i += step) {
      const c = cells[i];
      const key = `${c.x},${c.z}`;
      const bfsDist = distMap.get(key) ?? 0;

      let score = 0;

      if (this.keyCollected && playerDistMap) {
        // ── KEY COLLECTED: relentlessly hunt the player ──
        const bfsToPlayer = playerDistMap.get(key) ?? 999;
        // Massive score inversely proportional to distance from player
        // Max score at 3-5 steps, hard penalty beyond that
        score += Math.max(0, 100 - bfsToPlayer * 4);
        // Mild travel bonus so they don't just stand still
        score += Math.min(bfsDist, 8) * 0.2;

      } else {
        // ── IDLE ROAMING: travel FAR through the actual maze ──
        // Primary: maximize real travel distance from current position
        score += Math.min(bfsDist, 60) * 1.5;

        // Secondary: also far from last target (ensures diversity across picks)
        if (lastDistMap) {
          const lastDist = lastDistMap.get(key) ?? 0;
          score += Math.min(lastDist, 40) * 0.8;
        }
      }

      // Penalize cells near other enemies (separation — both modes)
      for (const sib of this.siblings) {
        if (sib === this || sib.homeFloor !== this.homeFloor) continue;
        const sibCell = this.maze.worldToCell(sib.pos.x, sib.pos.z, this.floorIndex);
        const sdx = c.x - sibCell.x;
        const sdz = c.z - sibCell.z;
        const sibDist = Math.sqrt(sdx * sdx + sdz * sdz);
        if (sibDist < SEPARATION_RADIUS / CELL_SIZE) {
          score -= (SEPARATION_RADIUS / CELL_SIZE - sibDist) * 2;
        }
      }

      score += Math.random() * (this.keyCollected ? 4 : 8);

      if (score > bestScore) {
        bestScore = score;
        bestCell = c;
      }
    }

    this.lastPatrolCell = { x: bestCell.x, z: bestCell.z };

    // Debug: log score breakdown for the winning cell
    const winKey = `${bestCell.x},${bestCell.z}`;
    const winBfsDist = distMap.get(winKey) ?? 0;
    const winPlayerDist = playerDistMap?.get(winKey) ?? -1;
    const winLastDist = lastDistMap?.get(winKey) ?? -1;
    console.log(
      `[Enemy z${this.patrolZone} f${this.floorIndex}] pickTarget → (${bestCell.x},${bestCell.z}) ` +
      `score: ${bestScore.toFixed(1)} | mode: ${this.keyCollected ? 'HUNT' : 'roam'} | ` +
      `bfsDist: ${winBfsDist} | playerBfs: ${winPlayerDist} | lastBfs: ${winLastDist} | ` +
      `smellScore: ${this.keyCollected ? Math.max(0, 100 - winPlayerDist * 4).toFixed(0) : 'n/a'}`
    );

    const wp = this.maze.cellToWorld(bestCell.x, bestCell.z, this.floorIndex);
    wp.y = this.pos.y;
    return wp;
  }

  private doChase(dt: number, playerPos: THREE.Vector3, speedMult: number) {
    const canSeePlayer = this.hasLineOfSight(playerPos);

    if (canSeePlayer) {
      // Direct diagonal beeline toward the player — no grid restriction
      const target = playerPos.clone();
      target.y = this.pos.y;
      this.moveToward(target, BASE_CHASE_SPEED * speedMult * dt);
      this.path = [];
    } else {
      // No line of sight — fall back to BFS grid pathfinding
      if (this.pathTimer >= PATH_UPDATE_INTERVAL || this.path.length === 0) {
        this.pathTimer = 0;
        this.path = this.smoothPath(this.bfsPath(this.pos, this.lastKnownPlayerPos ?? playerPos));
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
      this.moveDir.lerp(dir, 0.15);
      this.moveDir.normalize();
      diff.normalize().multiplyScalar(Math.min(maxDist, dist));
      this.pos.add(diff);
      // Push out of walls after every move step
      this.enforceWalls();
    }
    return dist;
  }

  /** Push enemy position out of walls — mirrors Player.enforceWallMargin() */
  private enforceWalls() {
    const floor = this.maze.floors[this.floorIndex];
    if (!floor) return;

    const MARGIN = 0.4;  // tighter than player — enemies navigate narrow corridors better
    const cx = Math.round(this.pos.x / CELL_SIZE);
    const cz = Math.round(this.pos.z / CELL_SIZE);

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= floor.width || nz < 0 || nz >= floor.height) continue;
        const c = floor.cells[nz]?.[nx];
        if (!c) continue;

        const wx = nx * CELL_SIZE;
        const wz = nz * CELL_SIZE;
        const half = CELL_SIZE / 2;

        const inX = this.pos.x >= wx - half && this.pos.x <= wx + half;
        const inZ = this.pos.z >= wz - half && this.pos.z <= wz + half;

        if (c.walls.N && inX) {
          const face = wz - half;
          const d = this.pos.z - face;
          if (d > -MARGIN && d < MARGIN) this.pos.z = face + (d >= 0 ? MARGIN : -MARGIN);
        }
        if (c.walls.S && inX) {
          const face = wz + half;
          const d = this.pos.z - face;
          if (d > -MARGIN && d < MARGIN) this.pos.z = face + (d >= 0 ? MARGIN : -MARGIN);
        }
        if (c.walls.W && inZ) {
          const face = wx - half;
          const d = this.pos.x - face;
          if (d > -MARGIN && d < MARGIN) this.pos.x = face + (d >= 0 ? MARGIN : -MARGIN);
        }
        if (c.walls.E && inZ) {
          const face = wx + half;
          const d = this.pos.x - face;
          if (d > -MARGIN && d < MARGIN) this.pos.x = face + (d >= 0 ? MARGIN : -MARGIN);
        }
      }
    }
  }

  /** Snap enemy to the nearest reachable non-obstacle cell center.
   *  Used for recovery when the enemy ends up in an invalid position. */
  private snapToNearestReachable() {
    const myCell = this.maze.worldToCell(this.pos.x, this.pos.z, this.floorIndex);
    // Check if current cell is already reachable and not an obstacle
    const ok = this.reachableCells.some(c => c.x === myCell.x && c.z === myCell.z && !c.hasObstacle);
    if (ok) return; // position is fine

    // Find nearest reachable cell by Manhattan distance
    let bestDist = Infinity;
    let bestCell = this.reachableCells[0];
    for (const c of this.reachableCells) {
      if (c.hasObstacle) continue;
      const d = Math.abs(c.x - myCell.x) + Math.abs(c.z - myCell.z);
      if (d < bestDist) { bestDist = d; bestCell = c; }
    }
    if (bestCell) {
      const wp = this.maze.cellToWorld(bestCell.x, bestCell.z, this.floorIndex);
      this.pos.x = wp.x;
      this.pos.z = wp.z;
    }
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
      // Check both sides of each wall for robustness against any asymmetry
      if (inBounds(cur.x, cur.z - 1) && (!cell.walls.N || !floor.cells[cur.z - 1]?.[cur.x]?.walls.S)) neighbors.push({ x: cur.x, z: cur.z - 1 });
      if (inBounds(cur.x, cur.z + 1) && (!cell.walls.S || !floor.cells[cur.z + 1]?.[cur.x]?.walls.N)) neighbors.push({ x: cur.x, z: cur.z + 1 });
      if (inBounds(cur.x + 1, cur.z) && (!cell.walls.E || !floor.cells[cur.z]?.[cur.x + 1]?.walls.W)) neighbors.push({ x: cur.x + 1, z: cur.z });
      if (inBounds(cur.x - 1, cur.z) && (!cell.walls.W || !floor.cells[cur.z]?.[cur.x - 1]?.walls.E)) neighbors.push({ x: cur.x - 1, z: cur.z });

      for (const n of neighbors) {
        const key = `${n.x},${n.z}`;
        if (!visited.has(key)) {
          const nc = floor.cells[n.z]?.[n.x];
          if (nc?.hasObstacle) continue;
          visited.add(key);
          queue.push({ ...n, parent: cur });
        }
      }
    }

    if (!found) return [];

    const path: THREE.Vector3[] = [];
    let node: Node | null = found;
    while (node) {
      const wp = this.maze.cellToWorld(node.x, node.z, fi);
      wp.y = this.pos.y;
      path.unshift(wp);
      node = node.parent;
    }
    if (path.length > 0) path.shift();
    return path;
  }

  /** BFS distance map from a start cell — returns Map<"x,z", stepCount>.
   *  @param ignoreObstacles  true for smell/vision (obstacles are low, don't block);
   *                          false for movement distance (enemies can't jump obstacles). */
  private bfsDistanceMap(sx: number, sz: number, ignoreObstacles = false): Map<string, number> {
    const floor = this.maze.floors[this.floorIndex];
    const dist = new Map<string, number>();
    if (!floor) return dist;
    const W = floor.width, H = floor.height;
    const queue: { x: number; z: number; d: number }[] = [{ x: sx, z: sz, d: 0 }];
    dist.set(`${sx},${sz}`, 0);

    while (queue.length > 0) {
      const { x, z, d } = queue.shift()!;
      const cell = floor.cells[z]?.[x];
      if (!cell) continue;

      const tryMove = (nx: number, nz: number) => {
        const key = `${nx},${nz}`;
        if (nx >= 0 && nx < W && nz >= 0 && nz < H && !dist.has(key)) {
          const nc = floor.cells[nz]?.[nx];
          if (!ignoreObstacles && nc?.hasObstacle) return;
          if (nc && nc.walls.N && nc.walls.S && nc.walls.E && nc.walls.W) return;
          dist.set(key, d + 1);
          queue.push({ x: nx, z: nz, d: d + 1 });
        }
      };

      if (!cell.walls.N || !floor.cells[z - 1]?.[x]?.walls.S) tryMove(x, z - 1);
      if (!cell.walls.S || !floor.cells[z + 1]?.[x]?.walls.N) tryMove(x, z + 1);
      if (!cell.walls.E || !floor.cells[z]?.[x + 1]?.walls.W) tryMove(x + 1, z);
      if (!cell.walls.W || !floor.cells[z]?.[x - 1]?.walls.E) tryMove(x - 1, z);
    }
    return dist;
  }

  /** Compute actual walking distance along a path (sum of segment lengths) */
  private pathWalkDistance(path: THREE.Vector3[]): number {
    let d = 0;
    for (let i = 1; i < path.length; i++) {
      d += path[i].distanceTo(path[i - 1]);
    }
    return d;
  }

  /**
   * String-pulling path smoother: skip intermediate waypoints when there's
   * a clear line-of-sight to a further waypoint. Produces much shorter,
   * more natural paths through rooms and wide corridors.
   */
  private smoothPath(raw: THREE.Vector3[]): THREE.Vector3[] {
    if (raw.length <= 2) return raw;
    const result: THREE.Vector3[] = [raw[0]];
    let anchor = 0;
    while (anchor < raw.length - 1) {
      // Try to skip as far ahead as possible
      let farthest = anchor + 1;
      for (let i = anchor + 2; i < raw.length; i++) {
        if (this.hasLineOfSightXZ(raw[anchor], raw[i])) {
          farthest = i;
        }
      }
      result.push(raw[farthest]);
      anchor = farthest;
    }
    return result;
  }

  /** Grid-level line-of-sight check between two world positions (XZ plane).
   *  Checks wall crossings between cells — works with thin-wall mazes. */
  private hasLineOfSightXZ(a: THREE.Vector3, b: THREE.Vector3): boolean {
    return this.checkWallLOS(a.x, a.z, b.x, b.z);
  }

  /** Shared wall-crossing LOS check. Steps along a ray and detects when crossing
   *  from one cell to the next would pass through a wall (N/S/E/W flags). */
  private checkWallLOS(ax: number, az: number, bx: number, bz: number): boolean {
    const floor = this.maze.floors[this.floorIndex];
    if (!floor) return false;
    const W = floor.width, H = floor.height;

    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.1) return true;

    // Step in small increments; check cell transitions for wall crossings
    const stepSize = CELL_SIZE * 0.4;
    const steps = Math.ceil(dist / stepSize);
    let prevCX = Math.round(ax / CELL_SIZE);
    let prevCZ = Math.round(az / CELL_SIZE);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = ax + dx * t;
      const pz = az + dz * t;
      const cx = Math.round(px / CELL_SIZE);
      const cz = Math.round(pz / CELL_SIZE);

      // Out of bounds = blocked
      if (cx < 0 || cx >= W || cz < 0 || cz >= H) return false;

      // Obstacles are low jumpable blocks — they don't block line of sight
      const cell = floor.cells[cz]?.[cx];
      if (!cell) return false;

      // Did we cross into a different cell? Check walls on both sides
      if (cx !== prevCX || cz !== prevCZ) {
        const prevCell = floor.cells[prevCZ]?.[prevCX];
        if (!prevCell) return false;

        // Crossed east (cx > prevCX)
        if (cx > prevCX && (prevCell.walls.E || cell.walls.W)) return false;
        // Crossed west
        if (cx < prevCX && (prevCell.walls.W || cell.walls.E)) return false;
        // Crossed south (cz > prevCZ)
        if (cz > prevCZ && (prevCell.walls.S || cell.walls.N)) return false;
        // Crossed north
        if (cz < prevCZ && (prevCell.walls.N || cell.walls.S)) return false;

        prevCX = cx;
        prevCZ = cz;
      }
    }
    return true;
  }

  /**
   * BFS reachable cells from a given cell — same as maze.floodFill but
   * also treats hasObstacle cells as impassable (enemies can't jump them).
   * The result excludes obstacle cells entirely.
   */
  private bfsReachableFrom(sx: number, sz: number, fi: number): Cell[] {
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
      if (cell.walls.N && cell.walls.S && cell.walls.E && cell.walls.W) continue;
      // Skip obstacle cells — enemies can't traverse them (no jumping)
      if (cell.hasObstacle) continue;
      result.push(cell);

      const tryMove = (nx: number, nz: number) => {
        const key = `${nx},${nz}`;
        if (nx >= 0 && nx < W && nz >= 0 && nz < H && !visited.has(key)) {
          const nc = floor.cells[nz]?.[nx];
          if (nc?.hasObstacle) return; // can't enter obstacle cells
          visited.add(key);
          queue.push({ x: nx, z: nz });
        }
      };

      // Check both sides of each wall for robustness
      if (!cell.walls.N || !floor.cells[z - 1]?.[x]?.walls.S) tryMove(x, z - 1);
      if (!cell.walls.S || !floor.cells[z + 1]?.[x]?.walls.N) tryMove(x, z + 1);
      if (!cell.walls.E || !floor.cells[z]?.[x + 1]?.walls.W) tryMove(x + 1, z);
      if (!cell.walls.W || !floor.cells[z]?.[x - 1]?.walls.E) tryMove(x - 1, z);
    }
    return result;
  }

  /** Wall-crossing line of sight: steps along the ray and checks if crossing
   *  from one cell to the next is blocked by a wall on either side. */
  private hasLineOfSight(playerPos: THREE.Vector3): boolean {
    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > SIGHT_RANGE * 1.5) return false;
    return this.checkWallLOS(this.pos.x, this.pos.z, playerPos.x, playerPos.z);
  }

  getPosition(): THREE.Vector3 { return this.pos; }

  dispose() {
    this.scene.remove(this.mesh);
  }
}
