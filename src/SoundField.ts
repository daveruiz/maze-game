import { MazeFloor } from './types';

export interface SoundFieldResult {
  dirX: number;          // normalized world-space direction of arrival (X component)
  dirZ: number;          // normalized world-space direction of arrival (Z component)
  confidence: number;    // 0 = fully diffuse (sound from all sides), 1 = perfectly directional
  energy: number;        // 0–1 attenuation at player's cell
  wallCrossings: number; // wall count on cheapest path (for muffle filter)
}

// Extra cost per wall crossing — sound leaks through walls but is expensive.
// Open passage = 1 cost/step, wall crossing = 1 + WALL_COST.
const WALL_COST    = 6;
const MAX_COST     = 80;   // hard propagation cap; cells beyond this are silent
const ENERGY_DECAY = 0.10; // energy(cost) = exp(-cost * DECAY)

/**
 * Flood-fill sound energy from a source cell (enemy) through the maze grid
 * using wall-leaking Dijkstra (Dial's algorithm). Returns the direction from
 * which sound arrives at the player's cell and a directionality confidence.
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

  const sz   = W * H;
  const cost = new Float32Array(sz).fill(MAX_COST + 1);
  const wc   = new Uint8Array(sz); // wall crossings on cheapest path
  const idx  = (x: number, z: number) => z * W + x;

  cost[idx(srcX, srcZ)] = 0;

  // Dial's algorithm: bucket queue indexed by integer cost.
  // Edge costs are 1 (open) or 1+WALL_COST (wall), so all integer.
  // O(MAX_COST + V) — much faster than heap-based Dijkstra for this graph.
  type Entry = [number, number, number]; // x, z, accumulated wall crossings
  const buckets: Entry[][] = Array.from({ length: MAX_COST + 1 }, () => []);
  buckets[0].push([srcX, srcZ, 0]);

  for (let c = 0; c <= MAX_COST; c++) {
    const bucket = buckets[c];
    for (let bi = 0; bi < bucket.length; bi++) {
      const [x, z, wcAcc] = bucket[bi];
      if (c > cost[idx(x, z)]) continue; // stale entry

      const cell = floor.cells[z]?.[x];
      if (!cell) continue;

      const moves: [number, number, boolean][] = [
        [x,   z-1, cell.walls.N || !!(floor.cells[z-1]?.[x]?.walls.S)],
        [x,   z+1, cell.walls.S || !!(floor.cells[z+1]?.[x]?.walls.N)],
        [x+1, z,   cell.walls.E || !!(floor.cells[z]?.[x+1]?.walls.W)],
        [x-1, z,   cell.walls.W || !!(floor.cells[z]?.[x-1]?.walls.E)],
      ];

      for (const [nx, nz, hasWall] of moves) {
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        const nc = c + 1 + (hasWall ? WALL_COST : 0);
        if (nc > MAX_COST) continue;
        const ni = idx(nx, nz);
        if (nc < cost[ni]) {
          cost[ni] = nc;
          wc[ni]   = wcAcc + (hasWall ? 1 : 0);
          buckets[nc].push([nx, nz, wc[ni]]);
        }
      }
    }
  }

  // Attenuation and wall count at the player's cell
  const pi         = idx(playerX, playerZ);
  const pc         = cost[pi];
  const energy     = pc > MAX_COST ? 0 : Math.exp(-pc * ENERGY_DECAY);
  const bestWalls  = wc[pi];

  // Cost-gradient arrival direction.
  // For each of the 4 neighbors, the "cost drop" (player_cost - neighbor_cost)
  // is positive only when the neighbor is closer to the source (i.e. upstream).
  // Summing offset * cost_drop gives the gradient direction; its magnitude
  // relative to the total positive drop is the directionality confidence.
  let sumX = 0, sumZ = 0, totalDrop = 0;
  const dirs: [number, number][] = [[0,-1],[0,1],[1,0],[-1,0]];
  for (const [dx, dz] of dirs) {
    const nx = playerX + dx, nz = playerZ + dz;
    if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
    const drop = Math.max(0, pc - cost[idx(nx, nz)]);
    sumX      += dx * drop;
    sumZ      += dz * drop;
    totalDrop += drop;
  }

  const len = Math.sqrt(sumX * sumX + sumZ * sumZ);
  return {
    dirX:         len > 0.001 ? sumX / len : 0,
    dirZ:         len > 0.001 ? sumZ / len : 0,
    confidence:   totalDrop > 0.001 ? len / totalDrop : 0,
    energy,
    wallCrossings: bestWalls,
  };
}
