import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { EnemyState, Cell } from './types';
import { MazeGenerator, CELL_SIZE, WALL_HEIGHT, OBSTACLE_HEIGHT } from './Maze';
import { AudioManager } from './AudioManager';
import { computeSoundField } from './SoundField';

// ── GLTF asset cache ────────────────────────────────────────────────────────
// Loads the GLB once; every Enemy instance clones the skeleton from the cache.
interface GltfCache { scene: THREE.Group; animations: THREE.AnimationClip[] }
let _gltfCache: Promise<GltfCache> | null = null;

function loadEnemyGltf(): Promise<GltfCache> {
  if (!_gltfCache) {
    const loader = new GLTFLoader();
    _gltfCache = loader.loadAsync('./enemynew.glb').then(g => ({
      scene: g.scene as THREE.Group,
      animations: g.animations,
    }));
  }
  return _gltfCache;
}

// Desired model height in world units.  Tweak if the model looks too big/small.
const ENEMY_MODEL_HEIGHT = 2.31;

// Material brightness multiplier applied to the GLB's base colors.
// 1.0 = original texture colours, 0.0 = pitch black.  Try 0.3–0.6 for horror.
const ENEMY_BRIGHTNESS = 0.9;

const BASE_SEARCH_SPEED = 1.4;
const BASE_CHASE_SPEED  = 3.75;
const SPEED_SCALE_PER_FLOOR = 0.10; // +10% per floor
const SIGHT_RANGE       = 14;   // world units (flashlight on)
const LOSE_RANGE        = 20;   // enemy loses sight beyond this (flashlight on)
const LOSE_RANGE_DARK   = 10;   // loses sight sooner in the dark
const CATCH_DISTANCE    = 1.2;
const PATH_UPDATE_INTERVAL = 0.5; // seconds


// Separation — enemies prefer patrol targets far from siblings
const SEPARATION_RADIUS  = 12;  // world units — penalise targets near siblings

// Investigation after losing sight
const INVESTIGATE_DURATION = 4.0; // seconds to investigate area after losing player
const INVESTIGATE_RADIUS   = 8;   // pick cells within this radius of last known pos

// Alert system
const ALERT_RANGE = 30; // world units — other enemies within this get alerted

// Instant chase: if visible AND within this range, no suspicion buildup needed
const INSTANT_CHASE_RANGE = 6.0; // ~1.5 cells

// Suspicion system
const SUSPICION_DECAY        = 0.04;  // per second — idle cooldown rate
const SUSPICION_BUILD_DIRECT = 2.00;  // per second when enemy directly sees player (scales with visibility)
const SUSPICION_BUILD_GLOW   = 0.60;  // per second from peripheral awareness beyond direct sight (scales with visibility)
const SUSPICION_BUILD_NOISE  = 1.50;  // per second at playerNoise=1.0, squared falloff (independent of visibility)
const SUSPICION_ON_LOST      = 0.75;  // suspicion reset value when enemy loses player from chase
const SUSPICION_ON_ALERT     = 0.50;  // suspicion boost when alerted by a sibling

// Sound occlusion — recomputed every ~1s, not every frame
const SOUND_OCCLUSION_INTERVAL = 0.8; // seconds between BFS recalculations

export class Enemy {
  mesh!: THREE.Group;                // root group (positioned at floor level)
  private scene: THREE.Scene;
  private maze: MazeGenerator;
  private audio: AudioManager;
  private channelId: number = -1;

  state: EnemyState = EnemyState.SEARCHING;
  floorIndex: number = 0;
  homeFloor: number = 0;
  suspicion = 0;  // 0–1: scales walk speed and chains rate
  detectionEnabled = true; // set false via debug menu to make enemy ignore the player

  private pos: THREE.Vector3 = new THREE.Vector3();
  private path: THREE.Vector3[] = [];
  private pathTimer = 0;
  private searchTarget: THREE.Vector3 | null = null;
  private searchTimer = 0;
  private chaseLockTimer = 0; // grace period preventing immediate lose after entering chase

  private lastKnownPlayerPos: THREE.Vector3 | null = null;

  // Investigation state
  private investigateTimer = 0;
  private investigateTarget: THREE.Vector3 | null = null;
  private investigateWaiting = false; // true while standing still waiting for suspicion to decay

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

  // Sound propagation — cached field result for audio direction, occlusion, confidence
  private soundOcclusionTimer = 0;
  private soundWallCount = 0;
  private soundConfidence = 1.0;
  private soundHasLOS = true;
  private soundVirtualPos: THREE.Vector3 = new THREE.Vector3();
  private smoothSoundPos: THREE.Vector3 = new THREE.Vector3();

  private noticeCooldown = 0;

  // Movement direction (used for model facing)
  private moveDir: THREE.Vector3 = new THREE.Vector3(0, 0, 1);

  // ── 3D model / animation ─────────────────────────────────────────────────
  private mixer:          THREE.AnimationMixer | null = null;
  private actions:        Map<string, THREE.AnimationAction> = new Map();
  private currentAnimName = '';
  private modelReady      = false;
  private caughtPlayer    = false;
  // Alert blending: the Alert clip plays simultaneously with the movement clip,
  // its weight driven by suspicion (0 = pure movement, 1 = pure alert).
  private alertAction:    THREE.AnimationAction | null = null;
  private alertWeight     = 0;
  // Head bone reference for camera targeting
  private headBone:       THREE.Bone | null = null;
  // Smoothed speed for animation — avoids jitter from frame-to-frame displacement noise
  private smoothAnimSpeed = 0;

  // Locomotion speed zones (tuned in anim-test) — hard boundaries, one animation at a time with crossfade
  // Zone 0 (Alert/stopped) is handled separately via AlertFull clip
  private static readonly LOCO_ZONES = [
    { anim: 'Walking',              maxSpeed: 2.0,  refSpeed: 1.9,  minScale: 0.13 },
    { anim: 'run_fast_10_inplace',  maxSpeed: 4.5,  refSpeed: 3.0,  minScale: 0.20 },
    { anim: 'Running',              maxSpeed: 8.0,  refSpeed: 5.45, minScale: 0.30 },
  ];
  private static readonly CROSSFADE_DURATION = 0.3; // seconds for locomotion transitions
  private static readonly ALERT_THRESHOLD = 0.1; // m/s — below this, play AlertFull

  constructor(scene: THREE.Scene, maze: MazeGenerator, audio: AudioManager) {
    this.scene = scene;
    this.maze = maze;
    this.audio = audio;
    this.channelId = audio.createChannel();

    // Root group sits at floor level; the GLTF model is added inside it once loaded.
    this.mesh = new THREE.Group();
    this.scene.add(this.mesh);
    this.loadModel();
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
      console.debug(`[Enemy z${this.patrolZone} f${this.floorIndex}] KEY COLLECTED — switching to HUNT mode`);
    }
    this.keyCollected = collected;
  }

  /** Update the player position hint (used for attraction when key is collected) */
  setPlayerHint(pos: THREE.Vector3) {
    this.playerHint.copy(pos);
  }

  private async loadModel() {
    try {
      const gltf = await loadEnemyGltf();

      // Clone the shared scene so each enemy has its own skeleton/animation state.
      const model = skeletonClone(gltf.scene) as THREE.Group;

      // Auto-scale: measure bounding box and scale to ENEMY_MODEL_HEIGHT.
      // updateMatrixWorld(true) is required so child worldMatrices are correct
      // even before the model is added to the scene.
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const modelHeight = box.max.y - box.min.y;
      if (modelHeight > 0) {
        const s = ENEMY_MODEL_HEIGHT / modelHeight;
        model.scale.setScalar(s);
        console.debug(`[Enemy] GLB height=${modelHeight.toFixed(3)} → scale=${s.toFixed(5)}`);
      }

      // Propagate the new scale before measuring feet offset.
      model.updateMatrixWorld(true);
      const box2 = new THREE.Box3().setFromObject(model);
      model.position.y = -box2.min.y;

      // Tweak materials: darken for horror atmosphere + cast shadows.
      model.traverse(child => {
        if (child instanceof THREE.Mesh || child instanceof THREE.SkinnedMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          // Clone the material so each enemy instance is independent.
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          const cloned = mats.map(m => {
            const mat = (m as THREE.MeshStandardMaterial).clone();
            mat.color.multiplyScalar(ENEMY_BRIGHTNESS);
            mat.metalness = 0.0;          // kill chrome/metallic look from GLB
            mat.roughness = 0.85;         // matte flesh/cloth surface
            mat.emissiveIntensity = 0;    // kill any self-glow from the original asset
            mat.depthWrite = true;        // fix limbs rendering behind torso
            mat.depthTest  = true;
            // If the material is only "transparent" for alpha-test edges (opacity=1),
            // switch to alphaTest mode instead — avoids broken back-to-front sorting.
            if (mat.transparent && mat.opacity >= 0.99) {
              mat.transparent = false;
              mat.alphaTest   = 0.1;
            }
            return mat;
          });
          child.material = cloned.length === 1 ? cloned[0] : cloned;
          // Disable frustum culling on skinned meshes — their bounding sphere
          // doesn't account for bone deformations and can cause pop-in.
          if (child instanceof THREE.SkinnedMesh) {
            child.frustumCulled = false;
          }
        }
      });

      // Build animation mixer + actions from the shared clips.
      this.mixer = new THREE.AnimationMixer(model);

      // Leg bone names — Alert should NOT affect these (legs stay driven by locomotion)
      const LEG_BONES = [
        'LeftToeBase', 'LeftFoot', 'LeftLeg', 'LeftUpLeg',
        'RightToeBase', 'RightFoot', 'RightLeg', 'RightUpLeg',
      ];

      for (const clip of gltf.animations) {
        if (clip.name === 'Alert') {
          // Create TWO versions of Alert:
          // 1. Upper-body-only → blend layer (suspicion while moving)
          const upperTracks = clip.tracks.filter(t => {
            const boneName = t.name.split('.')[0];
            return !LEG_BONES.some(lb => boneName.includes(lb));
          });
          const upperClip = new THREE.AnimationClip('Alert', clip.duration, upperTracks);
          const upperAction = this.mixer.clipAction(upperClip);
          upperAction.clampWhenFinished = true;
          this.actions.set('Alert', upperAction);

          // 2. Full-body → played as locomotion when stopped
          const fullClip = new THREE.AnimationClip('AlertFull', clip.duration, clip.tracks.slice());
          const fullAction = this.mixer.clipAction(fullClip);
          fullAction.clampWhenFinished = true;
          this.actions.set('AlertFull', fullAction);
          continue;
        }
        const action = this.mixer.clipAction(clip);
        action.clampWhenFinished = true;
        this.actions.set(clip.name, action);
      }

      // Set up Alert (upper-body) as a persistent blend layer (weight controlled by suspicion).
      const alertAct = this.actions.get('Alert');
      if (alertAct) {
        alertAct.loop = THREE.LoopRepeat;
        alertAct.enabled = true;
        alertAct.setEffectiveWeight(0);
        alertAct.play();
        this.alertAction = alertAct;
      }

      // Find the Head bone for camera targeting during death
      model.traverse(child => {
        if ((child as THREE.Bone).isBone && child.name === 'Head') {
          this.headBone = child as THREE.Bone;
        }
      });

      this.mesh.add(model);
      this.modelReady = true;
    } catch (err) {
      console.error('[Enemy] Failed to load enemynew.glb — using box placeholder', err);
      // Fallback placeholder so the game doesn't crash.
      const geo = new THREE.BoxGeometry(0.6, ENEMY_MODEL_HEIGHT, 0.4);
      const mat = new THREE.MeshLambertMaterial({ color: 0x880000 });
      const box = new THREE.Mesh(geo, mat);
      box.position.y = ENEMY_MODEL_HEIGHT / 2;
      this.mesh.add(box);
      this.modelReady = true;
    }
  }

  // ── Animation helpers ───────────────────────────────────────────────────

  /**
   * Cross-fade to a named movement animation clip.
   * Alert is excluded — it runs as a separate blend layer managed by updateAlertBlend().
   * @param name          Clip name (must match one in the GLB).
   * @param fadeDuration  Crossfade length in seconds (0 = instant).
   * @param loop          true = LoopRepeat (default), false = LoopOnce.
   */
  private playAnimation(name: string, fadeDuration = 0.25, loop = true) {
    if (!this.modelReady || name === this.currentAnimName) return;
    if (name === 'Alert') return; // Alert is managed separately — never cross-fade to it
    const next = this.actions.get(name);
    if (!next) return;

    next.loop = loop ? THREE.LoopRepeat : THREE.LoopOnce;
    if (!loop) next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();

    const prev = this.actions.get(this.currentAnimName);
    if (prev && prev !== this.alertAction && fadeDuration > 0) {
      prev.crossFadeTo(next, fadeDuration, true);
    } else if (prev && prev !== this.alertAction) {
      prev.stop();
    }

    this.currentAnimName = name;
  }

  /**
   * Smoothly blend the Alert animation layer based on suspicion.
   * Alert weight ramps 0→1 as suspicion goes 0→1. During chase, Alert is off.
   */
  private updateAlertBlend(dt: number, actualSpeed = 0) {
    if (!this.alertAction) return;

    // Target weight: suspicion drives alert posture, but NOT during chase or caught.
    // When standing still (speed ≈ 0), force full alert so the idle pose takes over.
    let targetWeight = 0;
    if (!this.caughtPlayer && this.state !== EnemyState.CHASING) {
      targetWeight = actualSpeed <= Enemy.ALERT_THRESHOLD ? 1.0 : this.suspicion;
    }

    // Smooth toward target
    this.alertWeight += (targetWeight - this.alertWeight) * Math.min(1, 5 * dt);
    this.alertAction.setEffectiveWeight(this.alertWeight);
  }

  private static readonly ZONE_HYSTERESIS = 0.3; // speed must exceed boundary by this much to switch zones
  private currentLocoZoneIdx = 0; // track which zone we're in for hysteresis

  /**
   * Pick the locomotion zone for a given speed with hysteresis.
   * Once in a zone, speed must exceed the boundary by ZONE_HYSTERESIS to switch,
   * preventing flicker when speed sits right on a boundary.
   */
  private locoZoneFor(speed: number) {
    const zones = Enemy.LOCO_ZONES;
    const hyst = Enemy.ZONE_HYSTERESIS;
    let idx = this.currentLocoZoneIdx;

    // Clamp to valid range
    if (idx < 0 || idx >= zones.length) idx = 0;

    // Check if we should move up to a higher zone
    while (idx < zones.length - 1 && speed > zones[idx].maxSpeed + hyst) {
      idx++;
    }
    // Check if we should move down to a lower zone
    while (idx > 0 && speed < zones[idx - 1].maxSpeed - hyst) {
      idx--;
    }

    this.currentLocoZoneIdx = idx;
    return zones[idx];
  }

  /**
   * Decide which animation should play each frame, then tick the mixer.
   * @param actualSpeed  Real XZ movement speed this frame (world units / second).
   *
   * Animation map (enemynew.glb):
   *   Walking / run_fast_10_inplace / Running → blended locomotion tree
   *   Triple_Combo_Attack                     → caught player celebration
   *   Alert                                   → layered on top by suspicion
   */
  private updateAnimationState(dt: number, actualSpeed = 0) {
    if (!this.modelReady || !this.mixer) return;

    if (this.caughtPlayer) {
      this.playAnimation('Triple_Combo_Attack', 0.15, false);
      this.mixer.timeScale = 1.0;
      this.updateAlertBlend(dt, 0);
      this.mixer.update(dt);
      return;
    }

    // Hard zone: pick ONE target animation based on speed, cross-fade to it
    if (actualSpeed <= Enemy.ALERT_THRESHOLD) {
      // Stopped: play full-body Alert as the locomotion clip
      this.playAnimation('AlertFull', Enemy.CROSSFADE_DURATION);
      this.mixer.timeScale = 1.0;
    } else {
      const zone = this.locoZoneFor(actualSpeed);
      this.playAnimation(zone.anim, Enemy.CROSSFADE_DURATION);
      this.mixer.timeScale = Math.max(zone.minScale, actualSpeed / zone.refSpeed);
    }

    // Blend alert posture on top of current movement
    this.updateAlertBlend(dt, actualSpeed);
    this.mixer.update(dt);
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
    const MIN_DIST_FROM_PLAYER = 15; // cells — constant safe distance from entry
    for (const c of reachable) {
      const dx = c.x - entry.x, dz = c.z - entry.z;
      const distFromEntry = Math.sqrt(dx * dx + dz * dz);
      // Must be far from entry (where player spawns)
      let score = Math.min(distFromEntry, 25);
      // Hard penalty if too close to player spawn — effectively disqualifies nearby cells
      if (distFromEntry < MIN_DIST_FROM_PLAYER) {
        score -= (MIN_DIST_FROM_PLAYER - distFromEntry) * 20;
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
    this.mesh.position.set(this.pos.x, this.pos.y - 1.28, this.pos.z);
    this.soundVirtualPos.copy(this.pos);
    this.smoothSoundPos.copy(this.pos);
    this.soundHasLOS = true;
    this.soundWallCount = 0;
    this.soundOcclusionTimer = 0;
    this.state = EnemyState.SEARCHING;
    this.caughtPlayer = false;
    // Return to patrol animation on respawn.
    if (this.modelReady) {
      this.currentAnimName = '';
      this.alertWeight = 0;
      this.actions.forEach(a => a.stop());
      // Restart the Alert blend layer
      if (this.alertAction) {
        this.alertAction.reset();
        this.alertAction.enabled = true;
        this.alertAction.setEffectiveWeight(0);
        this.alertAction.play();
      }
      // Start with full-body Alert (enemy spawns stopped)
      this.playAnimation('AlertFull', 0);
    }
  }

  /** Alert this enemy to investigate a position (called by siblings) */
  alertTo(targetPos: THREE.Vector3) {
    if (this.state === EnemyState.CHASING) return; // already chasing, ignore
    this.suspicion = Math.max(this.suspicion, SUSPICION_ON_ALERT);
    this.state = EnemyState.SEARCHING;
    this.lastKnownPlayerPos = targetPos.clone();
    // Go to alert position first, then investigate nearby
    this.reachedLastKnown = false;
    this.investigateWaiting = false;
    this.investigateTarget = targetPos.clone();
    this.searchTarget = this.investigateTarget;
    this.path = this.smoothPath(this.bfsPath(this.pos, this.investigateTarget, true));
    const walkDist = this.pathWalkDistance(this.path);
    const speedMult = 1 + this.floorIndex * SPEED_SCALE_PER_FLOOR;
    const travelTime = walkDist / (BASE_CHASE_SPEED * 0.7 * speedMult);
    this.investigateTimer = travelTime + INVESTIGATE_DURATION;
    this.searchTimer = this.investigateTimer + 1; // don't override with random search
  }

  // playerVisibility: 0=completely dark/hidden, 1=fully lit (flashlight on or right next to lantern)
  update(dt: number, playerPos: THREE.Vector3, playerFloor: number, camera: THREE.Camera, playerVisibility = 1.0, playerNoise = 0): boolean {
    // Only active when player is on the same floor
    if (this.homeFloor !== playerFloor) {
      this.mesh.visible = false;
      this.audio.stopChannel(this.channelId);
      return false;
    }
    this.mesh.visible = true;
    this.audio.startChannelChains(this.channelId);

    const speedMult = 1 + this.floorIndex * SPEED_SCALE_PER_FLOOR;

    this.pathTimer += dt;

    // Separation is handled at target-selection level (pickPatrolTarget scores
    // cells far from siblings). No runtime movement force — avoids pushing into walls.

    const distToPlayer = this.pos.distanceTo(playerPos);

    // Noise-based hearing range (independent of light — enemies always listen)
    // Crouching/still: 0.3 units | Walking: ~6 | Sprinting: ~14 | Landing: ~19
    const DARK_MIN_RANGE = 0.3;
    const DARK_MAX_RANGE = 19;
    const darkRange = DARK_MIN_RANGE + playerNoise * (DARK_MAX_RANGE - DARK_MIN_RANGE);

    // Unified visibility-based sight:
    //   visibility=1.0 (flashlight on / right next to lantern) → full SIGHT_RANGE
    //   visibility=0   (pitch dark)                            → 10% of SIGHT_RANGE (nearly blind)
    const effectiveSight = SIGHT_RANGE * Math.max(0.1, playerVisibility);
    // Peripheral glow range: slightly beyond direct sight (builds suspicion slower)
    const glowRange = effectiveSight * 1.35;

    const hasLoS = this.hasLineOfSight(playerPos);
    this.soundHasLOS = hasLoS;
    const canSee     = hasLoS && distToPlayer < effectiveSight;
    const inGlowOnly = !canSee && hasLoS && distToPlayer < glowRange; // peripheral awareness
    const canHear    = playerNoise > 0.1 && distToPlayer < darkRange;

    // ── Detection bypass (debug) ─────────────────────────────────────────
    if (!this.detectionEnabled) {
      this.suspicion = Math.max(0, this.suspicion - SUSPICION_DECAY * 4 * dt);
      if (this.state === EnemyState.CHASING) this.state = EnemyState.SEARCHING;
    }

    // ── Directional awareness factor ─────────────────────────────────────
    // Front ±90° → factor 1.0. Fades linearly to 0 at ±85° from behind (170° total).
    // The last ~10° directly behind is a blind spot. Applies to visual detection only.
    // When the player is brightly lit (flashlight/lantern), light is visible from all
    // directions so the factor is overridden by playerVisibility.
    const FADE_DOT = Math.cos(170 * Math.PI / 180); // ≈ -0.985
    const enemyFwd = new THREE.Vector3(Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y));
    const toPlayerXZ = new THREE.Vector3(playerPos.x - this.pos.x, 0, playerPos.z - this.pos.z);
    const toPlayerLen = toPlayerXZ.length();
    const dot = toPlayerLen > 0.01 ? enemyFwd.dot(toPlayerXZ) / toPlayerLen : 1;
    // dot=1 → front, dot=0 → 90° side (full zone), dot≈-1 → behind (blind)
    const dirFactor = Math.max(0, Math.min(1, (dot - FADE_DOT) / (0 - FADE_DOT)));
    // Flashlight or bright lantern: emitted light reveals player from all angles
    const effectiveDirFactor = Math.max(dirFactor, playerVisibility);

    // ── Suspicion update (only while searching — chasing uses its own FSM) ───
    if (this.detectionEnabled && this.state === EnemyState.SEARCHING) {
      // Instant chase: direct sight at close range — scaled by direction factor
      // (sneaking behind a distracted enemy avoids the instant trigger)
      if (canSee && distToPlayer < INSTANT_CHASE_RANGE * effectiveDirFactor) {
        this.suspicion = 1;
        this.state = EnemyState.CHASING;
        this.chaseLockTimer = 1.5;
        this.lastKnownPlayerPos = playerPos.clone();
        this.investigateWaiting = false;
        this.audio.playChannelState(this.channelId, 'spotted');
        this.alertSiblings(playerPos);
        console.debug(`[Enemy z${this.patrolZone} f${this.floorIndex}] CLOSE SIGHT → instant chase`);
      } else {
        let gain = 0;
        if (canSee) {
          // Direct visual contact — scaled by facing direction and visibility
          const distF = 0.3 + 0.7 * Math.max(0, 1 - distToPlayer / effectiveSight);
          gain += SUSPICION_BUILD_DIRECT * playerVisibility * distF * effectiveDirFactor;
        } else if (inGlowOnly) {
          // Peripheral awareness: slower build, also direction-dependent
          const distF = Math.max(0, 1 - distToPlayer / glowRange);
          gain += SUSPICION_BUILD_GLOW * playerVisibility * distF * effectiveDirFactor;
        }
        if (canHear) {
          // Sound: direction-independent — enemy hears regardless of which way it faces
          const f = Math.max(0, 1 - distToPlayer / darkRange);
          gain += SUSPICION_BUILD_NOISE * playerNoise * f * f;
        }
        if (gain > 0) {
          const prevSuspicion = this.suspicion;
          this.suspicion = Math.min(1, this.suspicion + gain * dt);
          if (this.noticeCooldown <= 0 && prevSuspicion < 0.20 && this.suspicion >= 0.20) {
            this.audio.playChannelNotice(this.channelId);
            this.noticeCooldown = 12;
          }
        } else {
          this.suspicion = Math.max(0, this.suspicion - SUSPICION_DECAY * dt);
        }
        this.noticeCooldown -= dt;
        if (this.suspicion >= 0.99) {
          this.suspicion = 1;
          this.state = EnemyState.CHASING;
          this.chaseLockTimer = 1.5;
          this.lastKnownPlayerPos = playerPos.clone();
          this.audio.playChannelState(this.channelId, 'spotted');
          this.alertSiblings(playerPos);
          console.debug(`[Enemy z${this.patrolZone} f${this.floorIndex}] MAX SUSPICION → CHASING`);
        }
      }
    }

    // ── FSM ──────────────────────────────────────────────────────────────
    const preMovX = this.pos.x, preMovZ = this.pos.z;
    switch (this.state) {
      case EnemyState.SEARCHING:
        this.audio.playChannelState(this.channelId, 'searching');
        // Any detection → investigate toward player (suspicion handles chase trigger)
        if (canSee || canHear || inGlowOnly) {
          this.lastKnownPlayerPos = playerPos.clone();
          if (this.pathTimer >= PATH_UPDATE_INTERVAL || this.path.length === 0) {
            this.pathTimer = 0;
            this.investigateTarget = playerPos.clone();
            this.searchTarget = this.investigateTarget;
            this.path = this.smoothPath(this.bfsPath(this.pos, this.investigateTarget, true));
          }
          const glowTimer = inGlowOnly ? 4 + playerVisibility * 4 : 0;
          this.investigateTimer = Math.max(this.investigateTimer, canSee ? 8 : canHear ? 6 + playerNoise * 4 : glowTimer);
          this.reachedLastKnown = false;
          this.investigateWaiting = false; // new stimulus cancels any current wait
        }
        // Move: investigate or patrol
        if (this.investigateTimer > 0) {
          this.investigateTimer -= dt;
          // End wait early once suspicion has fully decayed
          if (this.investigateWaiting && this.suspicion < 0.05) {
            this.investigateWaiting = false;
            this.investigateTimer = 0;
          }
          this.doInvestigate(dt, speedMult);
        } else {
          this.investigateWaiting = false;
          this.doSearch(dt, speedMult);
        }
        break;

      case EnemyState.CHASING:
        this.audio.playChannelState(this.channelId, 'chasing');
        // Always keep last known position fresh when close — at this range the
        // enemy can sense the player regardless of light/noise.
        if (this.detectionEnabled && (canSee || canHear || inGlowOnly || distToPlayer < INSTANT_CHASE_RANGE)) {
          this.lastKnownPlayerPos = playerPos.clone();
        }

        this.chaseLockTimer -= dt;
        // Lose range scales with visibility: fully lit player is harder to lose
        const effectiveLoseRange = LOSE_RANGE_DARK + (LOSE_RANGE - LOSE_RANGE_DARK) * playerVisibility;
        if (this.chaseLockTimer <= 0 && !canSee && !canHear && !inGlowOnly && distToPlayer > effectiveLoseRange) {
          console.debug(`[Enemy z${this.patrolZone} f${this.floorIndex}] LOST player at dist ${distToPlayer.toFixed(1)}`);
          // Lost the player — go to last known position, then investigate the area
          this.state = EnemyState.SEARCHING;
          this.suspicion = SUSPICION_ON_LOST; // remain highly alert after losing chase
          this.reachedLastKnown = false;
          this.investigateWaiting = false;
          this.investigateTarget = (this.lastKnownPlayerPos ?? playerPos).clone();
          this.searchTarget = this.investigateTarget;
          this.path = this.smoothPath(this.bfsPath(this.pos, this.investigateTarget, true));
          // Timer = travel time + investigation time, so it never expires mid-walk
          const walkDist = this.pathWalkDistance(this.path);
          const travelTime = walkDist / (BASE_CHASE_SPEED * 0.7 * speedMult);
          this.investigateTimer = travelTime + INVESTIGATE_DURATION;
          break;
        }

        this.doChase(dt, playerPos, speedMult);
        break;
    }

    // ── Chains volume + animation speed scale with actual movement ───────
    const movedXZ = Math.sqrt((this.pos.x - preMovX) ** 2 + (this.pos.z - preMovZ) ** 2);
    const actualSpeed = dt > 0 ? movedXZ / dt : 0;
    const chainSpeedFrac = Math.min(1, movedXZ / Math.max(0.0001, dt * BASE_CHASE_SPEED * speedMult));
    this.audio.updateChannelSpeed(this.channelId, chainSpeedFrac);

    // ── Smooth Y over obstacles ──────────────────────────────────────────
    const baseY = this.floorIndex * (WALL_HEIGHT + 1.0);
    const curCell = this.maze.floors[this.floorIndex]
      ?.cells[Math.round(this.pos.z / CELL_SIZE)]?.[Math.round(this.pos.x / CELL_SIZE)];
    const targetY = baseY + (curCell?.hasObstacle ? OBSTACLE_HEIGHT : 0) + 1.28;
    this.pos.y += (targetY - this.pos.y) * Math.min(1, 8 * dt);

    // ── 3D model: position at floor level, face movement direction ───────
    this.mesh.position.x = this.pos.x;
    this.mesh.position.z = this.pos.z;
    this.mesh.position.y = this.pos.y - 1.28;   // feet on floor

    if (this.moveDir.lengthSq() > 0.01) {
      // atan2(x, z) gives the Y-rotation for a model whose forward is +Z.
      const targetYaw = Math.atan2(this.moveDir.x, this.moveDir.z);
      let diff = targetYaw - this.mesh.rotation.y;
      while (diff >  Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      this.mesh.rotation.y += diff * Math.min(1, 10 * dt);
    }

    // ── Animation update ─────────────────────────────────────────────────
    // Smooth the speed to avoid animation jitter from frame-to-frame noise
    const smoothRate = 8.0; // higher = faster response, lower = smoother
    this.smoothAnimSpeed += (actualSpeed - this.smoothAnimSpeed) * Math.min(1, smoothRate * dt);
    this.updateAnimationState(dt, this.smoothAnimSpeed);

    // ── Audio occlusion: BFS-based sound direction + wall count ────────
    this.soundOcclusionTimer += dt;
    if (this.soundOcclusionTimer >= SOUND_OCCLUSION_INTERVAL) {
      this.soundOcclusionTimer = 0;
      this.updateSoundOcclusion(playerPos);
    }

    // When visible, audio comes directly from the real position.
    // Behind walls, lerp toward the flow-field virtual position for smooth direction.
    if (this.soundHasLOS) {
      this.smoothSoundPos.copy(this.pos);
    } else {
      const soundGap = this.smoothSoundPos.distanceTo(this.soundVirtualPos);
      if (soundGap > 30) {
        this.smoothSoundPos.copy(this.soundVirtualPos);
      } else {
        this.smoothSoundPos.lerp(this.soundVirtualPos, 1 - Math.exp(-dt * 5));
      }
    }
    this.audio.setChannelPosition(
      this.channelId,
      this.smoothSoundPos.x, this.smoothSoundPos.y, this.smoothSoundPos.z
    );
    this.audio.updateChannelOcclusion(this.channelId, distToPlayer, this.soundWallCount, this.soundConfidence, this.soundHasLOS);

    // Rear-source attenuation: dot product of player forward vs direction to sound source
    // rearFactor: 0 = sound in front, 1 = sound directly behind
    const camFwd = new THREE.Vector3();
    camera.getWorldDirection(camFwd);
    camFwd.y = 0;
    camFwd.normalize();
    const toSound = this.soundVirtualPos.clone().sub(playerPos);
    toSound.y = 0;
    const toSoundLen = toSound.length();
    if (toSoundLen > 0.1) {
      toSound.divideScalar(toSoundLen);
      const dot = camFwd.dot(toSound); // 1=front, -1=behind
      const rearFactor = Math.max(0, -dot); // 0 when in front/side, ramps to 1 behind
      this.audio.updateChannelRear(this.channelId, rearFactor);
    }

    // Caught?
    const caught = distToPlayer < CATCH_DISTANCE;
    if (caught && !this.caughtPlayer) this.caughtPlayer = true;
    return caught;
  }

  /** Compute sound propagation from this enemy to the player using a wall-leaking
   *  Dijkstra flood-fill. Direction is derived from the cost gradient at the player's
   *  cell — neighbors with lower cost are upstream toward the source. Multiple arriving
   *  corridors are automatically blended, and the gradient magnitude gives directionality
   *  confidence (low = diffuse, used to push toward reverb in AudioManager). */
  private updateSoundOcclusion(playerPos: THREE.Vector3) {
    const fi    = this.floorIndex;
    const floor = this.maze.floors[fi];
    if (!floor) {
      this.soundVirtualPos.copy(this.pos);
      this.soundWallCount  = 0;
      this.soundConfidence = 1;
      return;
    }

    const playerCell = this.maze.worldToCell(playerPos.x, playerPos.z, fi);
    const enemyCell  = this.maze.worldToCell(this.pos.x,  this.pos.z,  fi);

    // Same cell: BFS direction is undefined — use real position directly
    if (playerCell.x === enemyCell.x && playerCell.z === enemyCell.z) {
      this.soundVirtualPos.copy(this.pos);
      this.soundWallCount  = 0;
      this.soundConfidence = 1.0;
      return;
    }

    const result = computeSoundField(
      floor,
      enemyCell.x,  enemyCell.z,
      playerCell.x, playerCell.z,
    );

    this.soundWallCount  = result.wallCrossings;
    this.soundConfidence = result.confidence;

    const realDist = this.pos.distanceTo(playerPos);
    if (result.dirX !== 0 || result.dirZ !== 0) {
      this.soundVirtualPos.set(
        playerPos.x + result.dirX * realDist,
        this.pos.y,
        playerPos.z + result.dirZ * realDist,
      );
    } else {
      // Source and player in same cell, or unreachable — use real position
      this.soundVirtualPos.copy(this.pos);
    }
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
  private reachedLastKnown = false;

  private doInvestigate(dt: number, speedMult: number) {
    if (!this.investigateTarget) {
      this.investigateTimer = 0;
      return;
    }

    // Waiting at the investigation point — don't move until suspicion decays
    if (this.investigateWaiting) return;

    // Reached current target or path exhausted — pick next step
    if (this.path.length === 0 || this.pos.distanceTo(this.investigateTarget) < 1.5) {
      if (!this.reachedLastKnown && this.lastKnownPlayerPos) {
        // Arrived at the last known position — stop and listen until suspicion decays
        this.reachedLastKnown = true;
        this.investigateWaiting = true;
        this.path = [];
        return;
      } else if (this.lastKnownPlayerPos) {
        // Done waiting — wander the area briefly before returning to patrol
        this.investigateTarget = this.pickInvestigatePoint(this.lastKnownPlayerPos);
        this.searchTarget = this.investigateTarget;
        this.path = this.smoothPath(this.bfsPath(this.pos, this.investigateTarget, true));
      } else {
        this.investigateTimer = 0;
        return;
      }
    }

    if (this.path.length > 0) {
      const next = this.path[0];
      const invSpeed = BASE_SEARCH_SPEED + (BASE_CHASE_SPEED - BASE_SEARCH_SPEED) * this.suspicion;
      const d = this.moveToward(next, invSpeed * speedMult * dt);
      if (d < 0.4) this.path.shift();
    }
  }

  private doSearch(dt: number, speedMult: number) {
    // ── KEY COLLECTED: track directly toward the player's live position ──
    if (this.keyCollected) {
      this.doHuntTrack(dt, speedMult);
      return;
    }

    // ── Normal roaming patrol ──
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
      const speed = BASE_SEARCH_SPEED * (1 + this.floorIndex * SPEED_SCALE_PER_FLOOR);
      const walkTime = this.pathWalkDistance(this.path) / speed;
      this.searchTimer = Math.max(8, walkTime + 4 + Math.random() * 3);

      const myCell = this.maze.worldToCell(this.pos.x, this.pos.z, this.floorIndex);
      const tgtCell = this.maze.worldToCell(this.searchTarget.x, this.searchTarget.z, this.floorIndex);
      console.debug(
        `[Enemy z${this.patrolZone} f${this.floorIndex}] new target ` +
        `(${myCell.x},${myCell.z})→(${tgtCell.x},${tgtCell.z}) | ` +
        `reason: ${reason} | mode: roam | ` +
        `pathSteps: ${this.path.length} | walkDist: ${this.pathWalkDistance(this.path).toFixed(0)} | ` +
        `timer: ${this.searchTimer.toFixed(1)}s`
      );
    }

    if (this.path.length > 0) {
      const next = this.path[0];
      const speed = BASE_SEARCH_SPEED + (BASE_CHASE_SPEED - BASE_SEARCH_SPEED) * this.suspicion;
      const d = this.moveToward(next, speed * speedMult * dt);
      if (d < 0.4) this.path.shift();
    }
  }

  /** Hunt mode: enemies actively move toward the player's area once the key is collected.
   *  Picks a cell close to the player, walks there, then re-evaluates.
   *  Speed is doubled (HUNT_SPEED_MULT) to create urgency. */
  private static readonly HUNT_SPEED_MULT = 2.0; // base speed multiplier when key collected
  private huntTrackTimer = 0;
  private huntFailCount = 0;
  private doHuntTrack(dt: number, speedMult: number) {
    this.huntTrackTimer -= dt;

    const needsRepath =
      this.huntTrackTimer <= 0 ||
      this.path.length === 0 ||
      (this.searchTarget && this.pos.distanceTo(this.searchTarget) < 1.5);

    if (needsRepath) {
      const target = this.pickHuntTarget();
      this.searchTarget = target;
      this.path = this.smoothPath(this.bfsPath(this.pos, target));
      // Re-target frequently — keep converging on the player
      this.huntTrackTimer = 3 + Math.random() * 3; // 3–6s between re-targets

      if (this.path.length === 0) {
        this.huntFailCount++;
        if (this.huntFailCount >= 2) {
          this.snapToNearestReachable();
          this.path = this.smoothPath(this.bfsPath(this.pos, target));
          if (this.path.length === 0) {
            this.searchTarget = this.pickPatrolTarget();
            this.path = this.smoothPath(this.bfsPath(this.pos, this.searchTarget));
            this.huntTrackTimer = 4 + Math.random() * 2;
          }
          this.huntFailCount = 0;
        }
      } else {
        this.huntFailCount = 0;
      }
    }

    if (this.path.length > 0) {
      const next = this.path[0];
      const huntSpeed = BASE_SEARCH_SPEED * Enemy.HUNT_SPEED_MULT;
      const speed = huntSpeed + (BASE_CHASE_SPEED - huntSpeed) * this.suspicion;
      const d = this.moveToward(next, speed * speedMult * dt);
      if (d < 0.4) this.path.shift();
    }
  }

  /** Pick a hunt target: a reachable cell NEAR the player.
   *  Enemies converge toward the player from different directions (spread by patrol zone). */
  private pickHuntTarget(): THREE.Vector3 {
    const playerCell = this.maze.worldToCell(this.playerHint.x, this.playerHint.z, this.floorIndex);
    const playerDistMap = this.bfsDistanceMap(playerCell.x, playerCell.z, true);
    const cells = this.reachableCells.filter(c => !c.hasObstacle);
    if (cells.length === 0) return this.playerHint.clone();

    // Target cells 3–8 BFS steps from the player
    const HUNT_MIN = 3;
    const HUNT_MAX = 8;
    const MAX_ATTEMPTS = 5;

    // Build a pool of good candidates in the 3–8 range, then pick randomly
    type Candidate = { cell: typeof cells[0]; score: number };
    const candidates: Candidate[] = [];
    const sampleSize = Math.min(cells.length, 200);
    const step = Math.max(1, Math.floor(cells.length / sampleSize));

    for (let i = 0; i < cells.length; i += step) {
      const c = cells[i];
      const key = `${c.x},${c.z}`;
      const bfsToPlayer = playerDistMap.get(key) ?? 999;
      if (bfsToPlayer >= 999) continue;

      // Prefer cells in the 3–8 range
      let score = 0;
      if (bfsToPlayer >= HUNT_MIN && bfsToPlayer <= HUNT_MAX) {
        score += 50 - bfsToPlayer * 4; // closer within range = higher score
      } else if (bfsToPlayer < HUNT_MIN) {
        score -= (HUNT_MIN - bfsToPlayer) * 20; // too close penalized hard
      } else {
        score -= (bfsToPlayer - HUNT_MAX) * 6; // too far penalized
      }

      // Spread enemies: approach from different angles using patrol zone
      const zoneAngle = (this.patrolZone / Math.max(1, this.siblings.length)) * Math.PI * 2;
      const dcx = c.x - playerCell.x;
      const dcz = c.z - playerCell.z;
      if (dcx !== 0 || dcz !== 0) {
        const cellAngle = Math.atan2(dcz, dcx);
        const angleDiff = Math.abs(((cellAngle - zoneAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        score -= angleDiff * 5;
      }

      // Light separation from siblings
      for (const sib of this.siblings) {
        if (sib === this || sib.homeFloor !== this.homeFloor) continue;
        const sibCell = this.maze.worldToCell(sib.pos.x, sib.pos.z, this.floorIndex);
        const sdist = Math.sqrt((c.x - sibCell.x) ** 2 + (c.z - sibCell.z) ** 2);
        if (sdist < 4) score -= (4 - sdist) * 3;
      }

      if (score > -20) candidates.push({ cell: c, score });
    }

    // Sort by score descending, take top N, then pick randomly from those
    candidates.sort((a, b) => b.score - a.score);
    const poolSize = Math.min(candidates.length, 8);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (poolSize === 0) break;
      const pick = candidates[Math.floor(Math.random() * poolSize)];
      const wp = this.maze.cellToWorld(pick.cell.x, pick.cell.z, this.floorIndex);
      wp.y = this.pos.y;
      const testPath = this.bfsPath(this.pos, wp);
      if (testPath.length > 0) return wp;
      // Unreachable — try another random pick from the pool
    }

    // All attempts failed — fall back to player position directly
    return this.playerHint.clone();
  }

  /** Pick a patrol target for idle roaming — uses BFS distance map so enemies
   *  travel through the actual maze topology, not just grid Euclidean distance. */
  private pickPatrolTarget(): THREE.Vector3 {
    const cells = this.reachableCells.filter(c => !c.hasObstacle);
    const floor = this.maze.floors[this.floorIndex];
    if (!floor || cells.length === 0) return this.pos.clone();
    const mapDim = Math.min(floor.width, floor.height);

    const myCell = this.maze.worldToCell(this.pos.x, this.pos.z, this.floorIndex);

    // Build BFS distance map from current position — gives REAL travel distance
    const distMap = this.bfsDistanceMap(myCell.x, myCell.z);

    // Also build distance map from last patrol target for diversity
    let lastDistMap: Map<string, number> | null = null;
    if (this.lastPatrolCell) {
      lastDistMap = this.bfsDistanceMap(this.lastPatrolCell.x, this.lastPatrolCell.z);
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

      // Moderate travel distance from current position — not too close, not maximum
      // Capping prevents always boomeranging to the farthest point (e.g. entry on first pick)
      const maxDesired = Math.max(15, Math.round(mapDim * 0.6));
      let score = Math.min(bfsDist, maxDesired) * 1.0 - Math.max(0, bfsDist - maxDesired) * 0.5;

      // Also far from last target (ensures diversity across picks)
      if (lastDistMap) {
        const lastDist = lastDistMap.get(key) ?? 0;
        score += Math.min(lastDist, 40) * 0.8;
      }

      // Penalize cells near the entry point — avoid converging on player spawn
      const entryDist = Math.abs(c.x - floor.entryCell.x) + Math.abs(c.z - floor.entryCell.z);
      if (entryDist < 6) {
        score -= (6 - entryDist) * 5;
      }

      // Penalize cells near other enemies AND their active targets
      for (const sib of this.siblings) {
        if (sib === this || sib.homeFloor !== this.homeFloor) continue;
        // Penalize near sibling position
        const sibCell = this.maze.worldToCell(sib.pos.x, sib.pos.z, this.floorIndex);
        const sdx = c.x - sibCell.x;
        const sdz = c.z - sibCell.z;
        const sibDist = Math.sqrt(sdx * sdx + sdz * sdz);
        if (sibDist < SEPARATION_RADIUS / CELL_SIZE) {
          score -= (SEPARATION_RADIUS / CELL_SIZE - sibDist) * 2;
        }
        // Penalize near sibling's target — avoid converging on the same area
        const sibTarget = sib.getSearchTarget();
        if (sibTarget) {
          const stc = this.maze.worldToCell(sibTarget.x, sibTarget.z, this.floorIndex);
          const tdist = Math.sqrt((c.x - stc.x) ** 2 + (c.z - stc.z) ** 2);
          if (tdist < SEPARATION_RADIUS / CELL_SIZE) {
            score -= (SEPARATION_RADIUS / CELL_SIZE - tdist) * 3;
          }
        }
      }

      score += Math.random() * 8;

      if (score > bestScore) {
        bestScore = score;
        bestCell = c;
      }
    }

    this.lastPatrolCell = { x: bestCell.x, z: bestCell.z };

    const wp = this.maze.cellToWorld(bestCell.x, bestCell.z, this.floorIndex);
    wp.y = this.pos.y;
    return wp;
  }

  private doChase(dt: number, playerPos: THREE.Vector3, speedMult: number) {
    const distToPlayer = this.pos.distanceTo(playerPos);
    const step = BASE_CHASE_SPEED * speedMult * dt;

    // Direct line of sight → charge straight at the player (no L-shaped BFS paths)
    if (this.hasLineOfSight(playerPos)) {
      this.moveToward(playerPos, step);
      // Clear stale path so BFS kicks in immediately once LOS breaks
      this.path = [];
      this.pathTimer = 0;
      return;
    }

    // No LOS: pathfind toward last known position
    const target = this.lastKnownPlayerPos ?? playerPos;
    if (this.pathTimer >= PATH_UPDATE_INTERVAL * 0.5 || this.path.length === 0) {
      this.pathTimer = 0;
      this.path = this.smoothPath(this.bfsPath(this.pos, target, true));
    }

    if (this.path.length > 0) {
      const next = this.path[0];
      const d = this.moveToward(next, step);
      if (d < 0.4) this.path.shift();
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
      // Multiple passes for wall convergence
      this.enforceWalls();
      this.enforceWalls();
      this.enforceWalls();
    }
    return dist;
  }

  /** Push enemy position out of walls — mirrors Player.enforceWallMargin() */
  private enforceWalls() {
    const floor = this.maze.floors[this.floorIndex];
    if (!floor) return;

    const MARGIN = 0.5;  // wall margin for enemy collision
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

  /** BFS pathfinding on the maze grid.
   *  @param ignoreObstacles  true when targeting the player — obstacles are low
   *    blocks the enemy can physically walk over (enforceWalls only checks walls).
   *    false for patrol targets — keeps enemies on clean walkable cells. */
  /** BFS pathfind. Obstacles ignored by default — enemies walk through them. */
  private bfsPath(from: THREE.Vector3, to: THREE.Vector3, ignoreObstacles = true): THREE.Vector3[] {
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

      // A passage exists only when NEITHER side has a wall (mirrors renderer logic)
      const neighbors: { x: number; z: number }[] = [];
      if (inBounds(cur.x, cur.z - 1) && !cell.walls.N && !floor.cells[cur.z - 1]?.[cur.x]?.walls.S) neighbors.push({ x: cur.x, z: cur.z - 1 });
      if (inBounds(cur.x, cur.z + 1) && !cell.walls.S && !floor.cells[cur.z + 1]?.[cur.x]?.walls.N) neighbors.push({ x: cur.x, z: cur.z + 1 });
      if (inBounds(cur.x + 1, cur.z) && !cell.walls.E && !floor.cells[cur.z]?.[cur.x + 1]?.walls.W) neighbors.push({ x: cur.x + 1, z: cur.z });
      if (inBounds(cur.x - 1, cur.z) && !cell.walls.W && !floor.cells[cur.z]?.[cur.x - 1]?.walls.E) neighbors.push({ x: cur.x - 1, z: cur.z });

      for (const n of neighbors) {
        const key = `${n.x},${n.z}`;
        if (!visited.has(key)) {
          if (!ignoreObstacles) {
            const nc = floor.cells[n.z]?.[n.x];
            if (nc?.hasObstacle) continue;
          }
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
  /** BFS distance map. Obstacles ignored by default — enemies walk through them. */
  private bfsDistanceMap(sx: number, sz: number, ignoreObstacles = true): Map<string, number> {
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

      if (!cell.walls.N && !floor.cells[z - 1]?.[x]?.walls.S) tryMove(x, z - 1);
      if (!cell.walls.S && !floor.cells[z + 1]?.[x]?.walls.N) tryMove(x, z + 1);
      if (!cell.walls.E && !floor.cells[z]?.[x + 1]?.walls.W) tryMove(x + 1, z);
      if (!cell.walls.W && !floor.cells[z]?.[x - 1]?.walls.E) tryMove(x - 1, z);
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
      // Enemies CAN walk through obstacles (only players jump them)
      result.push(cell);

      const tryMove = (nx: number, nz: number) => {
        const key = `${nx},${nz}`;
        if (nx >= 0 && nx < W && nz >= 0 && nz < H && !visited.has(key)) {
          // Enemies ignore obstacles — they can walk through them
          visited.add(key);
          queue.push({ x: nx, z: nz });
        }
      };

      // Passage only when neither side has a wall
      if (!cell.walls.N && !floor.cells[z - 1]?.[x]?.walls.S) tryMove(x, z - 1);
      if (!cell.walls.S && !floor.cells[z + 1]?.[x]?.walls.N) tryMove(x, z + 1);
      if (!cell.walls.E && !floor.cells[z]?.[x + 1]?.walls.W) tryMove(x + 1, z);
      if (!cell.walls.W && !floor.cells[z]?.[x - 1]?.walls.E) tryMove(x - 1, z);
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
  getSearchTarget(): THREE.Vector3 | null { return this.searchTarget; }

  /** Get the world-space position of the Head bone (falls back to estimated position). */
  getHeadPosition(): THREE.Vector3 {
    if (this.headBone) {
      const wp = new THREE.Vector3();
      this.headBone.getWorldPosition(wp);
      return wp;
    }
    // Fallback: estimate head at ~85% of model height above feet
    return new THREE.Vector3(this.pos.x, this.mesh.position.y + ENEMY_MODEL_HEIGHT * 0.85, this.pos.z);
  }

  /** Tick the animation mixer and face a target (used during death sequence when full update() is skipped). */
  tickMixer(dt: number, faceTarget?: THREE.Vector3) {
    if (faceTarget) {
      const dx = faceTarget.x - this.pos.x;
      const dz = faceTarget.z - this.pos.z;
      if (dx * dx + dz * dz > 0.01) {
        const targetYaw = Math.atan2(dx, dz);
        let diff = targetYaw - this.mesh.rotation.y;
        while (diff >  Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        this.mesh.rotation.y += diff * Math.min(1, 10 * dt);
      }
    }
    if (this.mixer) this.mixer.update(dt);
  }

  /** Force the caught-player animation and posture (called once from Game on catch). */
  playCaughtAnimation() {
    this.caughtPlayer = true;
    if (!this.modelReady || !this.mixer) return;
    this.playAnimation('Triple_Combo_Attack', 0.15, false);
    this.mixer.timeScale = 1.0;
    // Kill alert blend so the attack plays clean
    if (this.alertAction) this.alertAction.setEffectiveWeight(0);
    this.alertWeight = 0;
  }

  dispose() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
      this.mixer = null;
    }
    this.actions.clear();
    this.scene.remove(this.mesh);
  }
}
