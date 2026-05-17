export type FloorType = 'catacombs' | 'house' | 'village';

export interface Cell {
  x: number;
  z: number;
  floor: number;
  walls: { N: boolean; S: boolean; E: boolean; W: boolean };
  visited: boolean;
  stairs?: 'up' | 'down';
  isExit?: boolean;
  hasObstacle?: boolean;
}

export interface MazeFloor {
  cells: Cell[][];
  width: number;
  height: number;
  theme: FloorTheme;
  type: FloorType;
  entryCell: { x: number; z: number }; // where player spawns when entering this floor
}

export interface FloorTheme {
  name: string;
  wallColor: number;
  floorColor: number;
  ceilColor: number;
  fogColor: number;
  fogDensity: number;
  ambientColor: number;
  lightColor: number;
  hasCeiling: boolean;     // false for outdoor village
  hasWindows: boolean;     // adds moonlight panels in house
  windowColor: number;
  wallHeight: number;
}

export enum EnemyState {
  SEARCHING = 'SEARCHING',
  SPOTTED   = 'SPOTTED',
  CHASING   = 'CHASING',
}

export interface Vec2 { x: number; z: number; }
