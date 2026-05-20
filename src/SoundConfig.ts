/**
 * Sound configuration — keeps all sound file references out of game logic.
 * Add new entries here when adding sounds; no code changes needed elsewhere.
 */

export interface FloorAmbience {
  /** Path to the ambient loop file (relative to public/) */
  file: string;
  /** Playback volume per source (0–1) */
  volume: number;
  /** Number of spatialized sources spread across the map */
  sources: number;
}

export interface SoundConfig {
  /** Jumpscare stingers played randomly on player death (in addition to synth stinger) */
  jumpscares: string[];

  /** Constant looping sound attached to every enemy (spatialized via their panner) */
  enemyLoop: { file: string; volume: number } | undefined;

  /** Per-floor ambient loops. Index = floor index. undefined = no ambient for that floor. */
  floorAmbience: (FloorAmbience | undefined)[];
}

const soundConfig: SoundConfig = {
  jumpscares: [
    'jumpscare-01.mp3',
    'jumpscare-02.mp3',
  ],

  enemyLoop: { file: 'enemy-chains.mp3', volume: 0.3 },

  floorAmbience: [
    { file: 'ambient-basement.mp3', volume: 0.25, sources: 8 },  // Floor 0 — Basement
    { file: 'ambient-house.mp3', volume: 0.25, sources: 8 },     // Floor 1 — House
    { file: 'ambient-village.mp3', volume: 0.25, sources: 8 },   // Floor 2 — Village
  ],
};

export default soundConfig;
