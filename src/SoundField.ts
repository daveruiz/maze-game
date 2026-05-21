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

// Direction gradient sampling radius (cells). Arrival direction is computed
// from every cell within this radius that has clear line-of-sight from the
// player's cell — cells fully hidden behind a wall are excluded.
const DIRECTION_SAMPLE_RADIUS = 6;

/**
 * Flood-fill sound energy from a source cell (enemy) through the maze grid
 * using Dijkstra (Dial's algorithm) along open corridors only — walls are opaque.
 * Returns the direction from which sound arrives at the player's cell and a
 * directionality confidence.
 *
 * Direction is computed as the cost-gradient at the player's cell: neighbors
 * with lower cost are "upstream" toward the source. Weighting by cost-drop
 * naturally blends multiple arriving corridors, giving accurate positions when
 * sound wraps around corners and wider/diffuse feel when it arrives from many paths.
 *
 * Confidence = magnitude / sum_of_cost_drops. High when one corridor dominates,
 * low when energy arrives equally from several directions — use it to drive the
 * dry/wet (directional vs reverb) balance.
 */
/** Dijkstra flood-fill from (srcX, srcZ) — open corridors only, walls opaque.
 *  Returns Float32Array[W*H] of step-costs; unreachable cells have cost > MAX_COST. */
function buildCostMap(floor: MazeFloor, srcX: number, srcZ: number): Float32Array {
  const W = floor.width, H = floor.height;
  const cost = new Float32Array(W * H).fill(MAX_COST + 1);
  const idx  = (x: number, z: number) => z * W + x;
  cost[idx(srcX, srcZ)] = 0;

  type Entry = [number, number];
  const buckets: Entry[][] = Array.from({ length: MAX_COST + 1 }, () => []);
  buckets[0].push([srcX, srcZ]);

  for (let c = 0; c <= MAX_COST; c++) {
    const bucket = buckets[c];
    for (let bi = 0; bi < bucket.length; bi++) {
      const [x, z] = bucket[bi];
      if (c > cost[idx(x, z)]) continue;
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
        if (nc < cost[ni]) { cost[ni] = nc; buckets[nc].push([nx, nz]); }
      }
    }
  }
  return cost;
}

/** Grid line-of-sight between two cell centres: true if the straight segment
 *  crosses no wall. Steps finely and checks wall bits on each cell transition. */
function cellHasLOS(
  floor: MazeFloor,
  ax: number, az: number,
  bx: number, bz: number,
): boolean {
  const dx = bx - ax, dz = bz - az;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 0.5) return true;
  const steps = Math.ceil(dist * 4); // ~0.25-cell stepping
  let cx = ax, cz = az;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const nx = Math.round(ax + dx * t);
    const nz = Math.round(az + dz * t);
    if (nx === cx && nz === cz) continue;
    const cur = floor.cells[cz]?.[cx];
    const nxt = floor.cells[nz]?.[nx];
    if (!cur || !nxt) return false;
    if (nx > cx && (cur.walls.E || nxt.walls.W)) return false;
    if (nx < cx && (cur.walls.W || nxt.walls.E)) return false;
    if (nz > cz && (cur.walls.S || nxt.walls.N)) return false;
    if (nz < cz && (cur.walls.N || nxt.walls.S)) return false;
    cx = nx; cz = nz;
  }
  return true;
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
  const cost = buildCostMap(floor, srcX, srcZ);
  const out  = new Float32Array(W * H);
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

  const cost = buildCostMap(floor, srcX, srcZ);
  const idx  = (x: number, z: number) => z * W + x;

  // Attenuation at the player's cell (walls = 0 crossings by definition now)
  const pi     = idx(playerX, playerZ);
  const pc     = cost[pi];
  const energy = pc > MAX_COST ? 0 : Math.exp(-pc * ENERGY_DECAY);

  // Cost-gradient arrival direction — sampled over directly-visible cells.
  // Every cell within DIRECTION_SAMPLE_RADIUS that has clear line-of-sight
  // from the player's cell contributes unit_offset * cost_drop. Cells fully
  // hidden behind a wall are excluded: sound from them bends around corners,
  // so their straight-line grid offset doesn't represent the true arrival
  // direction. The cost_drop (player_cost - cell_cost) is positive only for
  // upstream cells; the vector-sum magnitude relative to the total drop is
  // the directionality confidence.
  let sumX = 0, sumZ = 0, totalDrop = 0;
  const R = DIRECTION_SAMPLE_RADIUS;
  for (let oz = -R; oz <= R; oz++) {
    for (let ox = -R; ox <= R; ox++) {
      if (ox === 0 && oz === 0) continue;
      if (ox * ox + oz * oz > R * R) continue; // circular radius
      const nx = playerX + ox, nz = playerZ + oz;
      if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
      const drop = Math.max(0, pc - cost[idx(nx, nz)]);
      if (drop <= 0) continue; // not upstream toward the source
      if (!cellHasLOS(floor, playerX, playerZ, nx, nz)) continue; // hidden by a wall
      const olen = Math.sqrt(ox * ox + oz * oz);
      sumX      += (ox / olen) * drop;
      sumZ      += (oz / olen) * drop;
      totalDrop += drop;
    }
  }

  const len = Math.sqrt(sumX * sumX + sumZ * sumZ);
  return {
    dirX:          len > 0.001 ? sumX / len : 0,
    dirZ:          len > 0.001 ? sumZ / len : 0,
    confidence:    totalDrop > 0.001 ? len / totalDrop : 0,
    energy,
    wallCrossings: 0,
  };
}
