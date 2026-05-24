import { MazeFloor } from './types';

export interface SoundFieldResult {
  dirX: number;          // normalized world-space direction of arrival (X component)
  dirZ: number;          // normalized world-space direction of arrival (Z component)
  confidence: number;    // 0 = fully diffuse (sound from all sides), 1 = perfectly directional
  energy: number;        // 0–1 attenuation at player's cell
  wallCrossings: number; // wall count on cheapest path (for muffle filter)
}

// Walls fully block sound propagation — no leakage through them.
// Open passage = 1 cost/step.
const MAX_COST     = 80;   // hard propagation cap; cells beyond this are silent
const ENERGY_DECAY = 0.10; // energy(cost) = exp(-cost * DECAY)

// Flow-field blend factor. Each cell's arrival direction is
//   normalize(α · step_toward_upstream  +  (1-α) · upstream_cell_direction)
// α high → reacts quickly to the local corridor (sharper, more local)
// α low  → inherits the long-range direction (smoother round corners)
const FLOW_ALPHA = 0.6;

export interface SoundMap {
  cost: Float32Array; // step-cost per cell; unreachable cells have cost > MAX_COST
  dirX: Float32Array; // normalized arrival direction (toward source) per cell
  dirZ: Float32Array;
  coh:  Float32Array; // 0–1 directional coherence per cell (confidence)
}

/**
 * Dijkstra (Dial's algorithm) flood-fill from (srcX, srcZ) — open corridors
 * only, walls opaque. Builds the cost map and, in the same pass, a propagated
 * flow field giving the direction sound arrives from at every cell.
 *
 * Each cell's direction points back toward the source and is
 *   normalize(α · step_to_upstream + (1-α) · upstream.dir)
 * — the local corridor step blended with the direction that reached the
 * upstream (lower-cost) cell, so the field bends smoothly around corners.
 * Where several equal-cost corridors feed one cell, their unit contributions
 * are summed; the summed length over the contribution count is the
 * directional coherence (1 = one clear corridor, →0 = sound from many sides).
 *
 * Because the field is resolved during propagation, querying any cell is
 * O(1) — no per-query gradient sampling or line-of-sight tracing needed.
 */
export function buildSoundMap(floor: MazeFloor, srcX: number, srcZ: number): SoundMap {
  const W = floor.width, H = floor.height;
  const N = W * H;
  const cost = new Float32Array(N).fill(MAX_COST + 1);
  const dirX = new Float32Array(N);
  const dirZ = new Float32Array(N);
  const coh  = new Float32Array(N);
  // Unit-contribution accumulators — summed per cell, normalized on finalize.
  const accX   = new Float32Array(N);
  const accZ   = new Float32Array(N);
  const accCnt = new Uint8Array(N);
  const idx = (x: number, z: number) => z * W + x;

  cost[idx(srcX, srcZ)] = 0;

  type Entry = [number, number];
  const buckets: Entry[][] = Array.from({ length: MAX_COST + 1 }, () => []);
  buckets[0].push([srcX, srcZ]);

  for (let c = 0; c <= MAX_COST; c++) {
    const bucket = buckets[c];
    for (let bi = 0; bi < bucket.length; bi++) {
      const [x, z] = bucket[bi];
      const ci = idx(x, z);
      if (c > cost[ci]) continue;

      // Finalize this cell's direction from its (now complete) accumulator.
      // The source cell keeps (0,0); coherence stays 0 there.
      const al = Math.sqrt(accX[ci] * accX[ci] + accZ[ci] * accZ[ci]);
      if (al > 1e-6) {
        dirX[ci] = accX[ci] / al;
        dirZ[ci] = accZ[ci] / al;
        coh[ci]  = al / accCnt[ci];
      }

      const cell = floor.cells[z]?.[x];
      if (!cell) continue;

      const moves: [number, number, boolean][] = [
        [x,   z-1, cell.walls.N || !!(floor.cells[z-1]?.[x]?.walls.S)],
        [x,   z+1, cell.walls.S || !!(floor.cells[z+1]?.[x]?.walls.N)],
        [x+1, z,   cell.walls.E || !!(floor.cells[z]?.[x+1]?.walls.W)],
        [x-1, z,   cell.walls.W || !!(floor.cells[z]?.[x-1]?.walls.E)],
      ];

      for (const [nx, nz, hasWall] of moves) {
        if (nx < 0 || nx >= W || nz < 0 || nz >= H || hasWall) continue;
        const nc = c + 1;
        if (nc > MAX_COST) continue;
        const ni = idx(nx, nz);
        if (nc > cost[ni]) continue; // already reached on a cheaper path

        // Contribution: blend the local step toward this upstream cell with
        // the direction that arrived at it, then normalize so every corridor
        // counts equally regardless of how much the blend cancels.
        let bx = FLOW_ALPHA * (x - nx) + (1 - FLOW_ALPHA) * dirX[ci];
        let bz = FLOW_ALPHA * (z - nz) + (1 - FLOW_ALPHA) * dirZ[ci];
        const bl = Math.sqrt(bx * bx + bz * bz) || 1;
        bx /= bl;
        bz /= bl;

        if (nc < cost[ni]) {
          cost[ni]   = nc;
          accX[ni]   = bx;
          accZ[ni]   = bz;
          accCnt[ni] = 1;
          buckets[nc].push([nx, nz]);
        } else { // nc === cost[ni]: an equal-cost corridor also feeds this cell
          accX[ni]   += bx;
          accZ[ni]   += bz;
          accCnt[ni] += 1;
        }
      }
    }
  }
  return { cost, dirX, dirZ, coh };
}

/**
 * Returns a Float32Array[W*H] with energy values 0–1 for every cell.
 * energy[z*W+x] = exp(-cost * ENERGY_DECAY), 0 when unreachable.
 * Useful for minimap heat-map visualization of the sound propagation field.
 */
export function computeSoundEnergies(
  floor: MazeFloor,
  srcX: number, srcZ: number,
): Float32Array {
  const W = floor.width, H = floor.height;
  if (srcX < 0 || srcX >= W || srcZ < 0 || srcZ >= H)
    return new Float32Array(W * H);
  const { cost } = buildSoundMap(floor, srcX, srcZ);
  const out = new Float32Array(W * H);
  for (let i = 0; i < cost.length; i++)
    out[i] = cost[i] > MAX_COST ? 0 : Math.exp(-cost[i] * ENERGY_DECAY);
  return out;
}

export function computeSoundField(
  floor: MazeFloor,
  srcX: number, srcZ: number,
  playerX: number, playerZ: number,
): SoundFieldResult {
  const W = floor.width, H = floor.height;

  if (srcX < 0 || srcX >= W || srcZ < 0 || srcZ >= H ||
      playerX < 0 || playerX >= W || playerZ < 0 || playerZ >= H) {
    return { dirX: 0, dirZ: 0, confidence: 0, energy: 0, wallCrossings: 0 };
  }

  const { cost, dirX, dirZ, coh } = buildSoundMap(floor, srcX, srcZ);
  const pi = playerZ * W + playerX;
  const pc = cost[pi];
  const energy = pc > MAX_COST ? 0 : Math.exp(-pc * ENERGY_DECAY);

  return {
    dirX:          dirX[pi],
    dirZ:          dirZ[pi],
    // Source cell has coh=0 (no directional arrow) but confidence should be 1
    // when the enemy is in the same cell — they're clearly audible right next to you.
    confidence:    pc === 0 ? 1.0 : coh[pi],
    energy,
    wallCrossings: 0,
  };
}
