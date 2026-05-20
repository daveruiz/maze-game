import { CELL_SIZE } from './Maze';

/**
 * Distribute N points evenly across a map grid using quadrant-based spreading.
 * Returns world-space positions (x, z) spread across the map.
 * Used by enemy spawning and spatial ambience sources.
 */
export function distributePositions(
  count: number,
  mapWidth: number,
  mapHeight: number,
  yBase: number,
): { x: number; y: number; z: number }[] {
  const positions: { x: number; y: number; z: number }[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const cx = mapWidth / 2 + (mapWidth / 4) * Math.cos(angle);
    const cz = mapHeight / 2 + (mapHeight / 4) * Math.sin(angle);

    // Clamp to map bounds (1 cell margin)
    const clampedX = Math.max(1, Math.min(mapWidth - 2, Math.round(cx)));
    const clampedZ = Math.max(1, Math.min(mapHeight - 2, Math.round(cz)));

    positions.push({
      x: clampedX * CELL_SIZE,
      y: yBase,
      z: clampedZ * CELL_SIZE,
    });
  }

  return positions;
}
