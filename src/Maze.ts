import * as THREE from 'three';
import { Cell, MazeFloor, FloorTheme, FloorType } from './types';
import { makeBrickTexture, makeFloorTexture, makeWoodTexture, makeStoneTexture } from './TextureFactory';

/** Load an image texture with tiling */
function loadTex(path: string, repeatX = 1, repeatY = 1): THREE.Texture {
  const loader = new THREE.TextureLoader();
  const tex = loader.load(path);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export const CELL_SIZE      = 4;
export const WALL_HEIGHT    = 3.5;
export const OBSTACLE_HEIGHT = 0.85;

// ─── Themes ────────────────────────────────────────────────────────────────

const THEMES: FloorTheme[] = [
  {
    name: 'Basement',
    wallColor:    0x3d2b1f,
    floorColor:   0x1a1210,
    ceilColor:    0x0d0908,
    fogColor:     0x060200,
    fogDensity:   0.08,
    ambientColor: 0x100500,
    lightColor:   0xff5010,
    hasCeiling:   true,
    hasWindows:   false,
    windowColor:  0x000000,
    wallHeight:   WALL_HEIGHT,
  },
  {
    name: 'The House',
    wallColor:    0x8b7250,
    floorColor:   0x5a3e28,
    ceilColor:    0x3a2a1a,
    fogColor:     0x080c12,
    fogDensity:   0.07,
    ambientColor: 0x0a101a,
    lightColor:   0x6688cc,
    hasCeiling:   true,
    hasWindows:   true,
    windowColor:  0x2244aa,
    wallHeight:   WALL_HEIGHT,
  },
  {
    name: 'The Village',
    wallColor:    0x5a5040,
    floorColor:   0x38342a,
    ceilColor:    0x000000,
    fogColor:     0x04060a,
    fogDensity:   0.06,
    ambientColor: 0x050810,
    lightColor:   0x4466aa,
    hasCeiling:   false,
    hasWindows:   true,
    windowColor:  0x1a2244,
    wallHeight:   WALL_HEIGHT * 2,
  },
];

const FLOOR_TYPES: FloorType[] = ['catacombs', 'house', 'village'];

// ─── Generator ─────────────────────────────────────────────────────────────

export class MazeGenerator {
  floors: MazeFloor[] = [];

  generate() {
    this.floors = [];
    this.floors.push(this.generateCatacombs(0));
    this.floors.push(this.generateHouse(1));
    this.floors.push(this.generateVillage(2));

    // Stairs between floors
    this.placeStairs(0, 1);
    this.placeStairs(1, 2);

    // Exit on last floor
    this.placeExit(2);

    // Obstacles on all floors
    this.addObstacles(0);
    this.addObstacles(1);
    this.addObstacles(2);
  }

  // ── Catacumbs: recursive backtracker ─────────────────────────────────────

  private generateCatacombs(fi: number): MazeFloor {
    const W = 21, H = 21;
    const cells = this.solidCells(W, H, fi);

    // Thin-wall recursive backtracker — steps by 1 cell, uses wall flags only.
    // Produces smooth corridors without the diagonal/checkerboard pattern.
    const stack: [number, number][] = [];
    cells[1][1].visited = true;
    stack.push([1, 1]);

    while (stack.length) {
      const [cx, cz] = stack[stack.length - 1];
      // Find unvisited neighbours (1 step away, within inner area)
      const nbrs: [number, number, 'N'|'S'|'E'|'W'][] = [];
      if (cz > 1     && !cells[cz - 1][cx].visited) nbrs.push([cx, cz - 1, 'N']);
      if (cz < H - 2 && !cells[cz + 1][cx].visited) nbrs.push([cx, cz + 1, 'S']);
      if (cx < W - 2 && !cells[cz][cx + 1].visited) nbrs.push([cx + 1, cz, 'E']);
      if (cx > 1     && !cells[cz][cx - 1].visited) nbrs.push([cx - 1, cz, 'W']);

      if (!nbrs.length) { stack.pop(); continue; }

      const [nx, nz, dir] = nbrs[Math.floor(Math.random() * nbrs.length)];
      // Open the wall between current and neighbour
      const a = cells[cz][cx], b = cells[nz][nx];
      if (dir === 'N') { a.walls.N = false; b.walls.S = false; }
      if (dir === 'S') { a.walls.S = false; b.walls.N = false; }
      if (dir === 'E') { a.walls.E = false; b.walls.W = false; }
      if (dir === 'W') { a.walls.W = false; b.walls.E = false; }
      b.visited = true;
      stack.push([nx, nz]);
    }

    // Carve open areas for breathing space and escape routes
    for (let i = 0; i < 12; i++) {
      const rw = 2 + Math.floor(Math.random() * 3); // 2-4
      const rh = 2 + Math.floor(Math.random() * 3);
      const rx = 2 + Math.floor(Math.random() * (W - rw - 3));
      const rz = 2 + Math.floor(Math.random() * (H - rh - 3));
      this.carveRoom(cells, rx, rz, rx + rw - 1, rz + rh - 1);
    }

    // Heavy wall removal — eliminates dead ends, creates loops and escape routes
    for (let i = 0; i < 90; i++) {
      const x = 1 + Math.floor(Math.random() * (W - 2));
      const z = 1 + Math.floor(Math.random() * (H - 2));
      const dirs = ['N','S','E','W'] as const;
      const dir = dirs[Math.floor(Math.random() * 4)];
      const [dx, dz] = dir === 'N' ? [0,-1] : dir === 'S' ? [0,1] : dir === 'E' ? [1,0] : [-1,0];
      const nx = x + dx, nz = z + dz;
      if (nx >= 1 && nx < W - 1 && nz >= 1 && nz < H - 1) {
        const a = cells[z][x], b = cells[nz][nx];
        if (dir === 'N') { a.walls.N = false; b.walls.S = false; }
        if (dir === 'S') { a.walls.S = false; b.walls.N = false; }
        if (dir === 'E') { a.walls.E = false; b.walls.W = false; }
        if (dir === 'W') { a.walls.W = false; b.walls.E = false; }
      }
    }

    // Dead-end removal — open a random wall in cells that have 3 walls (dead ends)
    // This ensures the player always has escape routes
    for (let z = 2; z < H - 2; z++) {
      for (let x = 2; x < W - 2; x++) {
        const c = cells[z][x];
        const wallCount = (c.walls.N ? 1 : 0) + (c.walls.S ? 1 : 0) + (c.walls.E ? 1 : 0) + (c.walls.W ? 1 : 0);
        if (wallCount >= 3) {
          // Pick a random closed wall and open it
          const closed: ('N'|'S'|'E'|'W')[] = [];
          if (c.walls.N) closed.push('N');
          if (c.walls.S) closed.push('S');
          if (c.walls.E) closed.push('E');
          if (c.walls.W) closed.push('W');
          const pick = closed[Math.floor(Math.random() * closed.length)];
          const [dx, dz] = pick === 'N' ? [0,-1] : pick === 'S' ? [0,1] : pick === 'E' ? [1,0] : [-1,0];
          const nx = x + dx, nz = z + dz;
          if (nx >= 1 && nx < W - 1 && nz >= 1 && nz < H - 1) {
            const b = cells[nz][nx];
            if (pick === 'N') { c.walls.N = false; b.walls.S = false; }
            if (pick === 'S') { c.walls.S = false; b.walls.N = false; }
            if (pick === 'E') { c.walls.E = false; b.walls.W = false; }
            if (pick === 'W') { c.walls.W = false; b.walls.E = false; }
          }
        }
      }
    }

    return { cells, width: W, height: H, theme: THEMES[0], type: 'catacombs', entryCell: { x: 1, z: 1 } };
  }

  // ── House: BSP-style room placement ──────────────────────────────────────

  private generateHouse(fi: number): MazeFloor {
    const W = 50, H = 50;   // x2 bigger
    const cells = this.solidCells(W, H, fi);

    type Room = { x: number; z: number; w: number; h: number };
    const rooms: Room[] = [];

    // Force an entry room near (1,1)
    rooms.push({ x: 1, z: 1, w: 4, h: 4 });
    this.carveRoom(cells, 1, 1, 4, 4);

    // Place random rooms — many more for the larger map
    for (let attempts = 0; attempts < 200 && rooms.length < 30; attempts++) {
      const rw = 2 + Math.floor(Math.random() * 5); // 2-6
      const rh = 2 + Math.floor(Math.random() * 5);
      const rx = 1 + Math.floor(Math.random() * (W - rw - 2));
      const rz = 1 + Math.floor(Math.random() * (H - rh - 2));

      const overlap = rooms.some(r =>
        rx < r.x + r.w + 2 && rx + rw + 2 > r.x &&
        rz < r.z + r.h + 2 && rz + rh + 2 > r.z
      );
      if (!overlap) {
        rooms.push({ x: rx, z: rz, w: rw, h: rh });
        this.carveRoom(cells, rx, rz, rx + rw - 1, rz + rh - 1);
      }
    }

    // Connect rooms with greedy MST corridors
    const connected = new Set<number>([0]);
    while (connected.size < rooms.length) {
      let best = { dist: Infinity, from: -1, to: -1 };
      for (const ci of connected) {
        for (let j = 0; j < rooms.length; j++) {
          if (connected.has(j)) continue;
          const ra = rooms[ci], rb = rooms[j];
          const cax = ra.x + Math.floor(ra.w / 2), caz = ra.z + Math.floor(ra.h / 2);
          const cbx = rb.x + Math.floor(rb.w / 2), cbz = rb.z + Math.floor(rb.h / 2);
          const d = Math.abs(cax - cbx) + Math.abs(caz - cbz);
          if (d < best.dist) best = { dist: d, from: ci, to: j };
        }
      }
      if (best.from < 0) break;
      const ra = rooms[best.from], rb = rooms[best.to];
      const ax = ra.x + Math.floor(ra.w / 2), az = ra.z + Math.floor(ra.h / 2);
      const bx = rb.x + Math.floor(rb.w / 2), bz = rb.z + Math.floor(rb.h / 2);
      this.carveHallway(cells, ax, az, bx, bz, W, H);
      connected.add(best.to);
    }

    // A few extra connections for reachability
    for (let i = 0; i < 10; i++) {
      const ra = rooms[Math.floor(Math.random() * rooms.length)];
      const rb = rooms[Math.floor(Math.random() * rooms.length)];
      if (ra !== rb) {
        this.carveHallway(cells,
          ra.x + Math.floor(ra.w / 2), ra.z + Math.floor(ra.h / 2),
          rb.x + Math.floor(rb.w / 2), rb.z + Math.floor(rb.h / 2),
          W, H);
      }
    }

    // Fix any one-way wall inconsistencies from overlapping carve operations
    this.syncWalls(cells, W, H);

    return { cells, width: W, height: H, theme: THEMES[1], type: 'house', entryCell: { x: 1, z: 1 } };
  }

  // ── Village: grid streets + building blocks ───────────────────────────────

  private generateVillage(fi: number): MazeFloor {
    const W = 78, H = 78;    // ~2.5x bigger
    const cells = this.openCells(W, H, fi);

    const STREET = 2; // street width in cells
    const BLOCK  = 6; // building block size

    const step = BLOCK + STREET;

    for (let bz = 0; bz * step + BLOCK < H - 1; bz++) {
      for (let bx = 0; bx * step + BLOCK < W - 1; bx++) {
        const sx = bx * step + STREET;
        const sz = bz * step + STREET;
        const ex = sx + BLOCK - 1;
        const ez = sz + BLOCK - 1;

        // 25% chance: building has an interior alley/courtyard
        const hollow = Math.random() < 0.25;
        // 10% chance: no building (empty lot / plaza) — fewer gaps = harder
        if (Math.random() < 0.10) continue;

        for (let z = sz; z <= ez; z++) {
          for (let x = sx; x <= ex; x++) {
            if (hollow && x > sx && x < ex && z > sz && z < ez) continue;
            this.solidifyCell(cells, x, z, W, H);
          }
        }
      }
    }

    // ── Dead ends: seal off many street segments to create traps ──────────
    // Horizontal dead ends: block a street segment with a wall across it
    for (let i = 0; i < 50; i++) {
      const bx = Math.floor(Math.random() * (W - 4)) + 2;
      const bz = Math.floor(Math.random() * (H - 4)) + 2;
      // Pick a random direction for the dead-end wall (2-3 cells wide)
      const horizontal = Math.random() < 0.5;
      const len = 2 + Math.floor(Math.random() * 2); // 2-3 cells

      if (horizontal) {
        // Block a vertical street with a horizontal wall
        let canPlace = true;
        for (let dx = 0; dx < len; dx++) {
          const c = cells[bz]?.[bx + dx];
          if (!c || isSolid(c) || c.stairs || c.isExit) { canPlace = false; break; }
        }
        if (canPlace) {
          for (let dx = 0; dx < len; dx++) {
            this.solidifyCell(cells, bx + dx, bz, W, H);
          }
        }
      } else {
        // Block a horizontal street with a vertical wall
        let canPlace = true;
        for (let dz = 0; dz < len; dz++) {
          const c = cells[bz + dz]?.[bx];
          if (!c || isSolid(c) || c.stairs || c.isExit) { canPlace = false; break; }
        }
        if (canPlace) {
          for (let dz = 0; dz < len; dz++) {
            this.solidifyCell(cells, bx, bz + dz, W, H);
          }
        }
      }
    }

    // ── Winding alleys: narrow 1-cell passages that twist and dead-end ────
    for (let a = 0; a < 40; a++) {
      let ax = 2 + Math.floor(Math.random() * (W - 4));
      let az = 2 + Math.floor(Math.random() * (H - 4));
      if (isSolid(cells[az]?.[ax])) continue;
      const alleyLen = 6 + Math.floor(Math.random() * 10);
      let dx = Math.random() < 0.5 ? 1 : 0;
      let dz = dx === 0 ? 1 : 0;
      if (Math.random() < 0.5) { dx = -dx; dz = -dz; }

      for (let s = 0; s < alleyLen; s++) {
        const nx = ax + dx, nz = az + dz;
        if (nx < 2 || nx >= W - 2 || nz < 2 || nz >= H - 2) break;
        const c = cells[nz]?.[nx];
        if (!c || c.stairs || c.isExit) break;

        // Solidify cells on both sides to create a narrow passage
        const perpDx = dz, perpDz = -dx; // perpendicular
        if (cells[nz + perpDz]?.[nx + perpDx] && !cells[nz + perpDz][nx + perpDx].stairs) {
          this.solidifyCell(cells, nx + perpDx, nz + perpDz, W, H);
        }
        if (cells[nz - perpDz]?.[nx - perpDx] && !cells[nz - perpDz][nx - perpDx].stairs) {
          this.solidifyCell(cells, nx - perpDx, nz - perpDz, W, H);
        }

        ax = nx; az = nz;

        // 30% chance to turn
        if (Math.random() < 0.3) {
          const temp = dx;
          dx = Math.random() < 0.5 ? dz : -dz;
          dz = Math.random() < 0.5 ? temp : -temp;
          if (dx === 0 && dz === 0) { dx = 1; dz = 0; }
        }
      }
      // Seal the end to make it a dead end (50% of alleys)
      if (Math.random() < 0.5) {
        const endX = ax + dx, endZ = az + dz;
        if (endX >= 2 && endX < W - 2 && endZ >= 2 && endZ < H - 2) {
          const c = cells[endZ]?.[endX];
          if (c && !c.stairs && !c.isExit) {
            this.solidifyCell(cells, endX, endZ, W, H);
          }
        }
      }
    }

    // Guarantee a central plaza (clear the central block)
    const px = Math.floor(W / 2) - 3;
    const pz = Math.floor(H / 2) - 3;
    for (let z = pz; z <= pz + 6; z++) {
      for (let x = px; x <= px + 6; x++) {
        this.openCell(cells, x, z, W, H);
      }
    }

    // Guarantee entry area is open
    for (let z = 0; z <= 3; z++) {
      for (let x = 0; x <= 3; x++) {
        this.openCell(cells, x, z, W, H);
      }
    }

    return { cells, width: W, height: H, theme: THEMES[2], type: 'village', entryCell: { x: 1, z: 1 } };
  }

  // ── Stairs & exit ─────────────────────────────────────────────────────────

  private placeStairs(floorA: number, floorB: number) {
    const fa = this.floors[floorA];
    const fb = this.floors[floorB];
    const maxX = Math.min(fa.width, fb.width) - 2;
    const maxZ = Math.min(fa.height, fb.height) - 2;

    // Flood-fill from entry to find only REACHABLE open cells on floor A
    const reachable = this.floodFill(floorA, fa.entryCell.x, fa.entryCell.z);
    const reachableSet = new Set(reachable.map(c => `${c.x},${c.z}`));

    const candidates = this.getOpenCells(floorA).filter(c =>
      !c.stairs && !c.isExit &&
      c.x >= 3 && c.x <= maxX && c.z >= 3 && c.z <= maxZ &&
      reachableSet.has(`${c.x},${c.z}`)
    );

    // Pick randomly — player needs a key to use stairs anyway
    if (!candidates.length) return;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    pick.stairs = 'up';

    // Ensure a wall behind the stairs (opposite to the open/approach side)
    this.ensureWallBehindStairs(fa, pick);

    // Force a passable path to the stair on floor B (open the cell if it's solid)
    const bCell = fb.cells[pick.z]?.[pick.x];
    if (bCell) {
      bCell.stairs = 'down';
      // Also ensure wall behind stairs on floor B
      this.ensureWallBehindStairs(fb, bCell);
      // Ensure the cell is accessible on floor B
      if (bCell.walls.N && bCell.walls.S && bCell.walls.E && bCell.walls.W) {
        this.openCell(fb.cells, pick.x, pick.z, fb.width, fb.height);
      }
      // Always carve a corridor to entry on floor B for guaranteed reachability
      this.carveHallway(fb.cells, pick.x, pick.z, fb.entryCell.x, fb.entryCell.z, fb.width, fb.height);
    }
  }

  /** Ensure there's a wall on the back side of a stair cell.
   *  "Back" = the side opposite to the open approach direction. */
  private ensureWallBehindStairs(floor: MazeFloor, cell: Cell) {
    const x = cell.x, z = cell.z;
    const openN = !cell.walls.N;
    const openS = !cell.walls.S;
    const openE = !cell.walls.E;
    const openW = !cell.walls.W;

    // Close all walls except the approach side — stairs sit in a 3-walled alcove
    const closeWall = (dir: 'N' | 'S' | 'E' | 'W') => {
      cell.walls[dir] = true;
      let nb: Cell | undefined;
      if (dir === 'N' && z > 0) { nb = floor.cells[z - 1]?.[x]; if (nb) nb.walls.S = true; }
      if (dir === 'S' && z < floor.height - 1) { nb = floor.cells[z + 1]?.[x]; if (nb) nb.walls.N = true; }
      if (dir === 'E' && x < floor.width - 1) { nb = floor.cells[z]?.[x + 1]; if (nb) nb.walls.W = true; }
      if (dir === 'W' && x > 0) { nb = floor.cells[z]?.[x - 1]; if (nb) nb.walls.E = true; }
    };

    // Determine approach direction and close the other three sides
    // Keep the approach side open, close back + both sides for an alcove
    if (openS && !openN) {
      closeWall('N'); closeWall('E'); closeWall('W');  // approach from south
    } else if (openN && !openS) {
      closeWall('S'); closeWall('E'); closeWall('W');  // approach from north
    } else if (openE && !openW) {
      closeWall('W'); closeWall('N'); closeWall('S');  // approach from east
    } else if (openW && !openE) {
      closeWall('E'); closeWall('N'); closeWall('S');  // approach from west
    } else if (openS) {
      closeWall('N'); closeWall('E'); closeWall('W');  // multiple open — prefer south
    } else if (openN) {
      closeWall('S'); closeWall('E'); closeWall('W');
    } else if (openE) {
      closeWall('W'); closeWall('N'); closeWall('S');
    } else if (openW) {
      closeWall('E'); closeWall('N'); closeWall('S');
    }
  }

  /** Flood-fill from a start cell — returns all reachable open cells */
  floodFill(fi: number, sx: number, sz: number): Cell[] {
    const floor = this.floors[fi];
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

  private placeExit(floorIdx: number) {
    const floor = this.floors[floorIdx];
    const W = floor.width, H = floor.height;
    for (let z = H - 2; z >= 1; z--) {
      for (let x = W - 2; x >= 1; x--) {
        const c = floor.cells[z][x];
        if (!c.stairs && (!c.walls.N || !c.walls.S || !c.walls.E || !c.walls.W)) {
          c.isExit = true;
          return;
        }
      }
    }
  }

  private addObstacles(floorIdx: number) {
    const cells = this.floors[floorIdx].cells;
    const W = this.floors[floorIdx].width;
    const H = this.floors[floorIdx].height;
    const candidates: Cell[] = [];

    for (let z = 2; z < H - 2; z++) {
      for (let x = 2; x < W - 2; x++) {
        const c = cells[z][x];
        if (!c.stairs && !c.isExit &&
            (!c.walls.N || !c.walls.S || !c.walls.E || !c.walls.W) &&
            !(x <= 3 && z <= 3)) {
          candidates.push(c);
        }
      }
    }

    const count = Math.floor(candidates.length * 0.18);
    candidates.sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) candidates[i].hasObstacle = true;
  }

  // ── Cell helpers ──────────────────────────────────────────────────────────

  private solidCells(W: number, H: number, fi: number): Cell[][] {
    const cells: Cell[][] = [];
    for (let z = 0; z < H; z++) {
      cells[z] = [];
      for (let x = 0; x < W; x++) {
        cells[z][x] = { x, z, floor: fi, walls: { N: true, S: true, E: true, W: true }, visited: false };
      }
    }
    return cells;
  }

  private openCells(W: number, H: number, fi: number): Cell[][] {
    const cells: Cell[][] = [];
    for (let z = 0; z < H; z++) {
      cells[z] = [];
      for (let x = 0; x < W; x++) {
        cells[z][x] = {
          x, z, floor: fi,
          walls: {
            N: z === 0,
            S: z === H - 1,
            E: x === W - 1,
            W: x === 0,
          },
          visited: true,
        };
      }
    }
    return cells;
  }

  private carveRoom(cells: Cell[][], x1: number, z1: number, x2: number, z2: number) {
    for (let z = z1; z <= z2; z++) {
      for (let x = x1; x <= x2; x++) {
        const c = cells[z][x];
        if (x > x1) { c.walls.W = false; cells[z][x - 1].walls.E = false; }
        if (x < x2) { c.walls.E = false; cells[z][x + 1].walls.W = false; }
        if (z > z1) { c.walls.N = false; cells[z - 1][x].walls.S = false; }
        if (z < z2) { c.walls.S = false; cells[z + 1][x].walls.N = false; }
      }
    }
  }

  private carveHallway(cells: Cell[][], ax: number, az: number, bx: number, bz: number, W: number, H: number) {
    // L-shaped corridor: horizontal then vertical
    // Only open walls in the direction of travel to avoid breaking adjacent solid cells
    const minX = Math.max(0, Math.min(ax, bx));
    const maxX = Math.min(W - 1, Math.max(ax, bx));
    for (let x = minX; x <= maxX; x++) {
      if (x < 0 || x >= W || az < 0 || az >= H) continue;
      // Open E/W walls along horizontal leg
      if (x > minX) {
        cells[az][x].walls.W = false;
        cells[az][x - 1].walls.E = false;
      }
      if (x < maxX) {
        cells[az][x].walls.E = false;
        cells[az][x + 1].walls.W = false;
      }
    }
    const minZ = Math.max(0, Math.min(az, bz));
    const maxZ = Math.min(H - 1, Math.max(az, bz));
    for (let z = minZ; z <= maxZ; z++) {
      if (bx < 0 || bx >= W || z < 0 || z >= H) continue;
      // Open N/S walls along vertical leg
      if (z > minZ) {
        cells[z][bx].walls.N = false;
        cells[z - 1][bx].walls.S = false;
      }
      if (z < maxZ) {
        cells[z][bx].walls.S = false;
        cells[z + 1][bx].walls.N = false;
      }
    }
    // Open the corner cell where the two legs meet
    if (bx >= 0 && bx < W && az >= 0 && az < H) {
      const corner = cells[az][bx];
      // Connect to both legs
      if (bx > minX) { corner.walls.W = false; if (cells[az][bx - 1]) cells[az][bx - 1].walls.E = false; }
      if (bx < maxX) { corner.walls.E = false; if (cells[az][bx + 1]) cells[az][bx + 1].walls.W = false; }
      if (az > minZ) { corner.walls.N = false; if (cells[az - 1]?.[bx]) cells[az - 1][bx].walls.S = false; }
      if (az < maxZ) { corner.walls.S = false; if (cells[az + 1]?.[bx]) cells[az + 1][bx].walls.N = false; }
    }
  }

  private openCell(cells: Cell[][], x: number, z: number, W: number, H: number) {
    if (x < 0 || x >= W || z < 0 || z >= H) return;
    const c = cells[z][x];
    if (z > 0)     { c.walls.N = false; cells[z - 1][x].walls.S = false; }
    if (z < H - 1) { c.walls.S = false; cells[z + 1][x].walls.N = false; }
    if (x > 0)     { c.walls.W = false; cells[z][x - 1].walls.E = false; }
    if (x < W - 1) { c.walls.E = false; cells[z][x + 1].walls.W = false; }
  }

  private solidifyCell(cells: Cell[][], x: number, z: number, W: number, H: number) {
    if (x < 1 || x >= W - 1 || z < 1 || z >= H - 1) return;
    const c = cells[z][x];
    c.walls = { N: true, S: true, E: true, W: true };
    if (z > 0)     cells[z - 1][x].walls.S = true;
    if (z < H - 1) cells[z + 1][x].walls.N = true;
    if (x > 0)     cells[z][x - 1].walls.E = true;
    if (x < W - 1) cells[z][x + 1].walls.W = true;
  }

  private unvisitedNeighbours(cells: Cell[][], cx: number, cz: number, W: number, H: number): [number, number, string][] {
    const result: [number, number, string][] = [];
    for (const [nx, nz, dir] of [[cx, cz-2,'N'], [cx, cz+2,'S'], [cx+2, cz,'E'], [cx-2, cz,'W']] as [number,number,string][]) {
      if (nx >= 0 && nx < W && nz >= 0 && nz < H && !cells[nz][nx].visited)
        result.push([nx, nz, dir]);
    }
    return result;
  }

  private removeWall(cells: Cell[][], ax: number, az: number, bx: number, bz: number, dir: string) {
    const a = cells[az][ax], b = cells[bz][bx];
    if (dir === 'N') { a.walls.N = false; b.walls.S = false; }
    if (dir === 'S') { a.walls.S = false; b.walls.N = false; }
    if (dir === 'E') { a.walls.E = false; b.walls.W = false; }
    if (dir === 'W') { a.walls.W = false; b.walls.E = false; }
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const mid = cells[mz]?.[mx];
    if (mid) {
      mid.walls.N = false; mid.walls.S = false; mid.walls.E = false; mid.walls.W = false;
      // Sync neighbours so wall data is consistent on both sides
      if (cells[mz - 1]?.[mx]) cells[mz - 1][mx].walls.S = false;
      if (cells[mz + 1]?.[mx]) cells[mz + 1][mx].walls.N = false;
      if (cells[mz]?.[mx - 1]) cells[mz][mx - 1].walls.E = false;
      if (cells[mz]?.[mx + 1]) cells[mz][mx + 1].walls.W = false;
    }
  }

  /**
   * Ensure wall data is bidirectionally consistent:
   * if cell A's east wall is open, cell B (east of A) must also have west wall open, and vice versa.
   * Fixes any one-way wall inconsistencies left by room/corridor carving.
   */
  private syncWalls(cells: Cell[][], W: number, H: number) {
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        const c = cells[z][x];
        // East ↔ West
        if (x < W - 1) {
          const r = cells[z][x + 1];
          if (!c.walls.E || !r.walls.W) { c.walls.E = false; r.walls.W = false; }
        }
        // South ↔ North
        if (z < H - 1) {
          const d = cells[z + 1][x];
          if (!c.walls.S || !d.walls.N) { c.walls.S = false; d.walls.N = false; }
        }
      }
    }
  }

  // ── Public utils ──────────────────────────────────────────────────────────

  getOpenCells(floorIdx: number): Cell[] {
    const f = this.floors[floorIdx];
    const open: Cell[] = [];
    for (let z = 0; z < f.height; z++)
      for (let x = 0; x < f.width; x++) {
        const c = f.cells[z][x];
        if (!c.walls.N || !c.walls.S || !c.walls.E || !c.walls.W) open.push(c);
      }
    return open;
  }

  cellToWorld(x: number, z: number, fi: number): THREE.Vector3 {
    return new THREE.Vector3(x * CELL_SIZE, fi * (WALL_HEIGHT + 1.0), z * CELL_SIZE);
  }

  worldToCell(wx: number, wz: number, _fi: number): { x: number; z: number } {
    return { x: Math.round(wx / CELL_SIZE), z: Math.round(wz / CELL_SIZE) };
  }

  /** Get N well-spaced reachable cells for item placement on a floor (avoids stairs, exit, entry) */
  getItemCells(floorIdx: number, count: number): Cell[] {
    const floor = this.floors[floorIdx];
    const reachable = this.floodFill(floorIdx, floor.entryCell.x, floor.entryCell.z);
    const ex = floor.entryCell.x, ez = floor.entryCell.z;
    // Scale placement distances by map size (base reference: 21×21)
    const mapDim = Math.min(floor.width, floor.height);
    const scale = mapDim / 21;
    const MIN_SPAWN_DIST = Math.max(4, Math.floor(4 * scale));
    const MIN_ITEM_DIST  = Math.max(4, Math.floor(6 * scale));
    const MIN_POI_DIST   = Math.max(4, Math.floor(5 * scale));

    // Collect positions of stairs and exit to keep items away from them
    const poiPositions: { x: number; z: number }[] = [];
    for (let z = 0; z < floor.height; z++) {
      for (let x = 0; x < floor.width; x++) {
        const c = floor.cells[z]?.[x];
        if (c && (c.stairs || c.isExit)) poiPositions.push({ x, z });
      }
    }

    const candidates = reachable.filter(c =>
      !c.stairs && !c.isExit && !c.hasObstacle &&
      Math.abs(c.x - ex) + Math.abs(c.z - ez) >= MIN_SPAWN_DIST
    );

    // Shuffle candidates for random spread — distance constraints handle separation
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    // Greedy pick: each item must be far from picked items AND stairs/exit
    const result: Cell[] = [];
    for (const c of candidates) {
      if (result.length >= count) break;

      // Must be far from stairs/exit
      let tooClose = false;
      for (const poi of poiPositions) {
        if (Math.sqrt((c.x - poi.x) ** 2 + (c.z - poi.z) ** 2) < MIN_POI_DIST) {
          tooClose = true; break;
        }
      }
      if (tooClose) continue;

      // Must be far from already-picked items
      for (const p of result) {
        if (Math.sqrt((c.x - p.x) ** 2 + (c.z - p.z) ** 2) < MIN_ITEM_DIST) {
          tooClose = true; break;
        }
      }
      if (tooClose) continue;

      result.push(c);
    }

    // Fallback: if strict distances couldn't fill all slots, relax and pick remaining
    if (result.length < count) {
      for (const c of candidates) {
        if (result.length >= count) break;
        if (result.includes(c)) continue;
        result.push(c);
      }
    }

    return result;
  }
}

// ─── Renderer ──────────────────────────────────────────────────────────────

function isSolid(c: Cell | undefined) {
  return !c || (c.walls.N && c.walls.S && c.walls.E && c.walls.W);
}

export class MazeRenderer {
  private groups: THREE.Group[] = [];
  private exitMesh: THREE.Mesh | null = null;
  private stairMeshes: THREE.Mesh[] = [];
  /** Lights belonging to each floor (for culling) */
  floorLights: THREE.Light[][] = [];
  /** Lantern world positions per floor (x, y, z) — no PointLights, just positions */
  lanternPositions: { x: number; y: number; z: number }[][] = [];

  build(maze: MazeGenerator, scene: THREE.Scene): void {
    maze.floors.forEach((floor, fi) => {
      const group = new THREE.Group();
      const theme  = floor.theme;
      const W = floor.width, H = floor.height;
      const wH = theme.wallHeight; // per-floor wall height (village = 2x)
      const yBase = fi * (WALL_HEIGHT + 1.0);

      // ── Materials (real image textures) ─────────────────────────────────
      let wallMat: THREE.MeshLambertMaterial;
      let floorMat: THREE.MeshLambertMaterial;
      let ceilMat: THREE.MeshLambertMaterial;

      // Floor plane tiles across the whole maze — repeat proportional to grid size
      const floorRepeat = Math.max(W, H) / 2;

      if (floor.type === 'house') {
        wallMat  = new THREE.MeshLambertMaterial({ map: loadTex('home-wall.png') });
        floorMat = new THREE.MeshLambertMaterial({ map: loadTex('home-floor.png', floorRepeat, floorRepeat) });
        ceilMat  = new THREE.MeshLambertMaterial({ map: loadTex('home-ceiling.png', floorRepeat, floorRepeat) });
      } else if (floor.type === 'village') {
        wallMat  = new THREE.MeshLambertMaterial({ map: loadTex('village-wall.png') });
        floorMat = new THREE.MeshLambertMaterial({ map: loadTex('vilage-floor.png', floorRepeat, floorRepeat) });
        ceilMat  = new THREE.MeshLambertMaterial({ color: 0x000000 }); // open sky
      } else {
        // Catacombs / basement
        wallMat  = new THREE.MeshLambertMaterial({ map: loadTex('basement-wall.png') });
        floorMat = new THREE.MeshLambertMaterial({ map: loadTex('basement-floor.png', floorRepeat, floorRepeat) });
        ceilMat  = new THREE.MeshLambertMaterial({ map: loadTex('basement-ceiling.png', floorRepeat, floorRepeat) });
      }

      const obsMat = new THREE.MeshLambertMaterial({ map: loadTex('basement-wall.png') });

      // ── Ground plane ───────────────────────────────────────────────────
      const planeGeo = new THREE.PlaneGeometry(W * CELL_SIZE, H * CELL_SIZE);
      const floorMesh = new THREE.Mesh(planeGeo, floorMat);
      floorMesh.rotation.x = -Math.PI / 2;
      floorMesh.position.set((W - 1) * CELL_SIZE / 2, yBase, (H - 1) * CELL_SIZE / 2);
      floorMesh.receiveShadow = true;
      group.add(floorMesh);

      // ── Ceiling (skipped for village) ──────────────────────────────────
      if (theme.hasCeiling) {
        const ceil = new THREE.Mesh(planeGeo.clone(), ceilMat);
        ceil.rotation.x = Math.PI / 2;
        ceil.position.set(floorMesh.position.x, yBase + wH, floorMesh.position.z);
        group.add(ceil);
      }

      // ── Walls ──────────────────────────────────────────────────────────
      const windowMat = theme.hasWindows
        ? new THREE.MeshBasicMaterial({ color: theme.windowColor, transparent: true, opacity: 0.9 })
        : null;

      for (let z = 0; z < H; z++) {
        for (let x = 0; x < W; x++) {
          const cell  = floor.cells[z][x];
          const wx    = x * CELL_SIZE;
          const wz    = z * CELL_SIZE;
          const north = floor.cells[z - 1]?.[x];
          const south = floor.cells[z + 1]?.[x];
          const west  = floor.cells[z]?.[x - 1];
          const east  = floor.cells[z]?.[x + 1];

          // Draw N wall — check BOTH sides; skip only when both solid (hidden)
          const hasNWall = cell.walls.N || (north != null && north.walls.S);
          if (hasNWall && !(isSolid(cell) && isSolid(north))) {
            const wallY = yBase + wH / 2;
            const wallZ = wz - CELL_SIZE / 2;
            const w = this.makeWall(wallMat, CELL_SIZE + 0.01, wH, 0.22, wx, wallY, wallZ);
            w.position.set(wx, wallY, wallZ);
            group.add(w);
            // Window panel on house/village outer walls
            if (windowMat && z <= 2) {
              const wg = new THREE.PlaneGeometry(CELL_SIZE * 0.5, wH * 0.4);
              const wp = new THREE.Mesh(wg, windowMat);
              wp.position.set(wx, yBase + wH * 0.6, wz - CELL_SIZE / 2 + 0.12);
              group.add(wp);
            }
          }

          // Draw W wall — check BOTH sides; skip only when both solid (hidden)
          const hasWWall = cell.walls.W || (west != null && west.walls.E);
          if (hasWWall && !(isSolid(cell) && isSolid(west))) {
            const wallX = wx - CELL_SIZE / 2;
            const wallY2 = yBase + wH / 2;
            const w = this.makeWall(wallMat, 0.22, wH, CELL_SIZE + 0.01, wallX, wallY2, wz);
            w.position.set(wallX, wallY2, wz);
            group.add(w);
            if (windowMat && x <= 2) {
              const wg = new THREE.PlaneGeometry(CELL_SIZE * 0.5, wH * 0.4);
              const wp = new THREE.Mesh(wg, windowMat);
              wp.rotation.y = Math.PI / 2;
              wp.position.set(wx - CELL_SIZE / 2 + 0.12, yBase + wH * 0.6, wz);
              group.add(wp);
            }
          }

          // S wall — only at south boundary OR if south neighbor disagrees
          const hasSWall = cell.walls.S || (south != null && south.walls.N);
          if (z === H - 1 || (hasSWall && !(isSolid(cell) && isSolid(south)))) {
            // Avoid duplicate: the N-wall pass of cell (x,z+1) may have drawn this already.
            // Draw here only for boundary or when the N pass wouldn't have caught it.
            if (z === H - 1 || (cell.walls.S && !south?.walls.N) || (!cell.walls.S && south?.walls.N)) {
              const sWallY = yBase + wH / 2;
              const sWallZ = wz + CELL_SIZE / 2;
              const w = this.makeWall(wallMat, CELL_SIZE + 0.01, wH, 0.22, wx, sWallY, sWallZ);
              w.position.set(wx, sWallY, sWallZ);
              group.add(w);
            }
          }
          // E wall — only at east boundary OR if east neighbor disagrees
          const hasEWall = cell.walls.E || (east != null && east.walls.W);
          if (x === W - 1 || (hasEWall && !(isSolid(cell) && isSolid(east)))) {
            if (x === W - 1 || (cell.walls.E && !east?.walls.W) || (!cell.walls.E && east?.walls.W)) {
              const eWallX = wx + CELL_SIZE / 2;
              const eWallY = yBase + wH / 2;
              const w = this.makeWall(wallMat, 0.22, wH, CELL_SIZE + 0.01, eWallX, eWallY, wz);
              w.position.set(eWallX, eWallY, wz);
              group.add(w);
            }
          }

          // Obstacle
          if (cell.hasObstacle) {
            const obsY = yBase + OBSTACLE_HEIGHT / 2;
            const om = this.makeWall(obsMat, CELL_SIZE * 0.88, OBSTACLE_HEIGHT, CELL_SIZE * 0.88, wx, obsY, wz);
            om.position.set(wx, obsY, wz);
            group.add(om);
          }

          // Stairs visual — face toward an open neighbor
          if (cell.stairs === 'up') {
            const stairRot = this.getStairRotation(floor, x, z);
            this.makeStaircase(group, wallMat, wx, wz, yBase, stairRot);
          }

          // Exit portal
          if (cell.isExit) {
            const eg = new THREE.BoxGeometry(CELL_SIZE * 0.8, 0.22, CELL_SIZE * 0.8);
            const em = new THREE.MeshLambertMaterial({ color: 0x00ff88, emissive: 0x00aa44 });
            this.exitMesh = new THREE.Mesh(eg, em);
            this.exitMesh.position.set(wx, yBase + 0.12, wz);
            group.add(this.exitMesh);
          }
        }
      }

      // Village: add street lanterns at intersections
      if (floor.type === 'village') {
        this.addStreetLanterns(group, floor, fi, yBase, wH);
      }

      this.groups[fi] = group;
      scene.add(group);
    });
  }

  /**
   * Determine which direction a stair cell should face.
   * Returns rotation in radians (Y-axis): 0 = +Z (south), PI/2 = +X (east), etc.
   * Prefers the direction with an open (non-solid) neighbor.
   */
  private getStairRotation(floor: MazeFloor, x: number, z: number): number {
    const cell = floor.cells[z][x];
    // Check which walls are open (passage exists)
    const openN = !cell.walls.N && z > 0 && !isSolid(floor.cells[z - 1]?.[x]);
    const openS = !cell.walls.S && z < floor.height - 1 && !isSolid(floor.cells[z + 1]?.[x]);
    const openE = !cell.walls.E && x < floor.width - 1 && !isSolid(floor.cells[z]?.[x + 1]);
    const openW = !cell.walls.W && x > 0 && !isSolid(floor.cells[z]?.[x - 1]);

    // Stairs ascend from +Z to -Z in local space (step 0 at +Z, top at -Z).
    // Rotate so the bottom step faces the open/approach direction.
    if (openS && !openN) return 0;                // approach from south → no rotation
    if (openN && !openS) return Math.PI;          // approach from north → flip 180°
    if (openE && !openW) return -Math.PI / 2;     // approach from east → rotate -90°
    if (openW && !openE) return Math.PI / 2;      // approach from west → rotate 90°

    // Multiple open sides — prefer S, then N, E, W
    if (openS) return 0;
    if (openN) return Math.PI;
    if (openE) return -Math.PI / 2;
    if (openW) return Math.PI / 2;

    return 0; // fallback: face south
  }

  private makeStaircase(group: THREE.Group, mat: THREE.Material, wx: number, wz: number, yBase: number, rotation: number = 0) {
    const steps = 7;
    const stepH = (WALL_HEIGHT + 1.0) / steps;
    const stepD = CELL_SIZE / steps;
    const stepW = CELL_SIZE * 0.7;

    // Build stairs in a group, then rotate the whole group
    const stairGroup = new THREE.Group();
    stairGroup.position.set(wx, 0, wz);

    for (let i = 0; i < steps; i++) {
      const g = new THREE.BoxGeometry(stepW, stepH * 0.9, stepD);
      const m = new THREE.Mesh(g, mat);
      // Position relative to center (0,0,0) — stairs go from +Z to -Z, ascending
      m.position.set(0, yBase + stepH * i + stepH * 0.45, CELL_SIZE / 2 - stepD * i - stepD / 2);
      stairGroup.add(m);
      this.stairMeshes.push(m);
    }

    stairGroup.rotation.y = rotation;
    group.add(stairGroup);
  }

  private addStreetLanterns(group: THREE.Group, floor: MazeFloor, fi: number, yBase: number, _wH: number) {
    const W = floor.width, H = floor.height;
    const LANTERN_STEP = Math.max(7, Math.floor(Math.max(W, H) / 20));
    const positions: { x: number; y: number; z: number }[] = [];

    for (let z = 0; z < H; z += LANTERN_STEP) {
      for (let x = 0; x < W; x += LANTERN_STEP) {
        const c = floor.cells[z]?.[x];
        if (!c || isSolid(c)) continue;

        const lx = x * CELL_SIZE - CELL_SIZE * 0.4;
        const lz = z * CELL_SIZE - CELL_SIZE * 0.4;

        // Lantern post
        const postGeo = new THREE.CylinderGeometry(0.06, 0.08, WALL_HEIGHT * 0.8, 6);
        const postMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(lx, yBase + WALL_HEIGHT * 0.4, lz);
        group.add(post);

        // Lantern head (emissive so it glows visually)
        const headGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
        const headMat = new THREE.MeshLambertMaterial({
          color: 0xc4b898,
          emissive: 0xbca27f,
          emissiveIntensity: 0.8,
        });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.set(lx, yBase + WALL_HEIGHT * 0.82, lz);
        group.add(head);

        // Store position for the light pool (no PointLight created here)
        positions.push({ x: lx, y: yBase + WALL_HEIGHT * 0.78, z: lz });
      }
    }
    this.lanternPositions[fi] = positions;
  }

  private makeWall(mat: THREE.Material, w: number, h: number, d: number, wx = 0, wy = 0, wz = 0): THREE.Mesh {
    const geo = new THREE.BoxGeometry(w, h, d);
    // Remap UVs to world-space so textures tile seamlessly across walls
    const pos = geo.attributes.position;
    const uv  = geo.attributes.uv;
    const scale = 1 / CELL_SIZE; // 1 texture repeat per cell
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i) + wx;
      const py = pos.getY(i) + wy;
      const pz = pos.getZ(i) + wz;
      const nx = geo.attributes.normal.getX(i);
      const ny = geo.attributes.normal.getY(i);
      const nz = geo.attributes.normal.getZ(i);
      // Project onto the plane perpendicular to the face normal
      if (Math.abs(nx) > 0.5) {
        // E/W face → use Z, Y
        uv.setXY(i, pz * scale, py * scale);
      } else if (Math.abs(ny) > 0.5) {
        // top/bottom face → use X, Z
        uv.setXY(i, px * scale, pz * scale);
      } else {
        // N/S face → use X, Y
        uv.setXY(i, px * scale, py * scale);
      }
    }
    uv.needsUpdate = true;

    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false;   // only enemies cast shadows
    m.receiveShadow = true;
    return m;
  }

  /** Show only the given floor, hide all others */
  setFloorVisible(activeFloor: number) {
    this.groups.forEach((g, i) => { g.visible = (i === activeFloor); });
    this.floorLights.forEach((lights, i) => {
      const vis = (i === activeFloor);
      lights.forEach(l => { l.visible = vis; });
    });
  }

  update(t: number) {
    if (this.exitMesh) {
      (this.exitMesh.material as THREE.MeshLambertMaterial).emissiveIntensity =
        0.4 + Math.sin(t * 3) * 0.4;
    }
  }

  dispose(scene: THREE.Scene) {
    this.groups.forEach(g => scene.remove(g));
    this.stairMeshes = [];
    this.exitMesh = null;
  }
}
