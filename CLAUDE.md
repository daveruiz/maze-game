# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow

Push directly to `master`. Do **not** push automatically — always commit locally and let the user test before pushing.

## Project Overview

"Dad's Nightmare" — a 3D first-person horror maze game built with Three.js, TypeScript, and Vite. The player navigates through 3 floors (Basement → House → Village), avoiding an AI enemy, collecting items (key, map, compass), and finding stairs/exit. Features flashlight with battery, spatialized audio, procedural textures, and stealth mechanics.

## Commands

```bash
npm run dev      # Vite dev server (hot reload on port 5173)
npm run build    # Production build to dist/
npm run preview  # Preview production build
```

No test framework is configured. No linter is configured.

## Architecture

### Entry Flow
`index.html` → `src/main.ts` → creates `Game` instance → `Game.start()` begins the render loop.

### Core Modules

| File | Responsibility |
|---|---|
| `Game.ts` | Central orchestrator. Owns the Three.js scene, camera, renderer, game loop, floor transitions, fog, flashlight, death/respawn, and coordinates all subsystems. |
| `Player.ts` | First-person physics: movement (WASD), sprint, crouch, jump, gravity, collision with walls/obstacles. Exposes `noiseLevel` for enemy detection. Head bob synced to footstep timing. |
| `Enemy.ts` | AI with FSM (SEARCHING → CHASING). Suspicion-based detection (fills gradually, triggers chase at 100%). BFS pathfinding on maze grid. Chains volume tracks movement speed; second chains layer during chase. |
| `SoundField.ts` | Dijkstra flood-fill from an enemy position through open corridors, building a flow-field of sound arrival directions and energy. Used for enemy panner direction behind walls. |
| `Maze.ts` | Procedural maze generation (recursive backtracker), mesh building (walls, floors, ceilings, obstacles, stairs, windows). Exports `CELL_SIZE=4`, `WALL_HEIGHT=3.5`. Per-floor themes with colors, fog density, ceiling/window config. |
| `AudioManager.ts` | Web Audio API graph: master → dry/reverb split (mono downmix before convolver for headphone stereo). Manages enemy sound channels (PannerNode per enemy), spatialized floor ambience (N sources per floor), procedural footsteps, jumpscare stingers. |
| `SoundConfig.ts` | Declarative sound configuration. Add/change sounds here without touching game logic. |

### Supporting Modules

| File | Responsibility |
|---|---|
| `types.ts` | Core types: `Cell`, `MazeFloor`, `FloorTheme`, `EnemyState`, `Vec2` |
| `TextureFactory.ts` | Procedural canvas-based textures (brick, floor tile, wood, stone, enemy sprite) |
| `HorrorShader.ts` | Custom post-processing shader (vignette, noise, chromatic aberration) |
| `MapDistribution.ts` | Distributes N positions evenly across map using quadrant-based circular spreading (used for ambience sources) |
| `InputMode.ts` | Singleton detecting mouse vs touch input, fires `onChange` callbacks |
| `MobileControls.ts` | Touch joystick + buttons for mobile play |
| `GamepadManager.ts` | Gamepad input abstraction |
| `Item.ts` | Collectible item sprites (key, map, compass) with billboard rendering |

### Audio Signal Path
```
Sources (footsteps, enemy panners, ambience panners)
  → masterGain
  ├─→ dryGain → compressor → destination      (panned stereo)
  └─→ monoGain (ch=1) → convolver → wetGain → compressor → destination  (diffuse reverb)
```
Mono downmix before reverb is critical for headphone stereo separation. All spatialized sources use HRTF panners.

### Enemy AI & Detection
- **Suspicion system**: Enemy builds a `suspicion` meter (0–1) instead of instant-triggering chase. Reaches 100% → CHASING. Decays slowly when player not visible/audible. Exception: instant chase if within close range and directly visible.
- **Visibility inputs**: `playerVisibility` (0–1) passed from Game — flashlight on = 1.0, otherwise scaled by nearby lantern exposure. Scene lanterns increase how visible the player is.
- **Audibility inputs**: `playerAudibility` from `AudioManager` — tracks footstep/landing sounds, decays over time.
- **Suspicion rates**: Direct sight × visibility × distance falloff; peripheral glow range (slower); noise (independent of visibility, squared falloff).
- **Sound direction**: Uses `SoundField.ts` Dijkstra flow-field for panner direction when enemy is behind walls; switches to real position when visible.
- **Pathfinding**: BFS on maze grid. Wall check uses AND logic — passage exists only when NEITHER side has a wall bit set.
- **Spawning**: BFS reachability from player position, ignores obstacles (enemies walk over them).

### Player Noise / Audibility System
`Player.noiseLevel` (0–1) is smoothed (fast attack, slow decay):

| State | Noise Level |
|---|---|
| Crouch + still | 0 |
| Crouch + moving | 0 (silent) |
| Walking | ~0.3 |
| Sprinting | ~0.7 |
| Landing (from jump/fall) | up to 1.0 |

`AudioManager.playerAudibility` is a separate value that spikes on footstep/landing sounds and decays per frame. Both are passed to `enemy.update()` each frame.

### Crouch Implementation
Crouch is a **camera-only offset** (`currentCrouchDip`), NOT a physics Y change. This avoids false fall detection and obstacle collision issues. Speed multiplied by `CROUCH_MULT=0.4`. Reset on death via `player.resetCrouch()` + camera position snap.

## Key Constants

- `CELL_SIZE = 4` (world units per maze cell)
- `WALL_HEIGHT = 3.5`
- `OBSTACLE_HEIGHT = 0.85`
- `PLAYER_HEIGHT = 1.6` (eye level)
- `CROUCH_HEIGHT = 0.7`
- 3 floors: index 0=Basement, 1=House, 2=Village
- Max 8 moving point lights (pooled, not per-cell)

## Known Patterns & Pitfalls

- **Async audio loading**: MP3 buffers load asynchronously. Floor ambience uses a pending request pattern — if buffer isn't ready when `setFloorAmbience` is called, it retries after load completes.
- **Enemy channel cleanup**: `stopEnemySound()` must clear the channels Map and reset `nextChannelId` to prevent ghost sounds on death/respawn.
- **BFS reachability**: Do NOT add obstacle blocking to `bfsReachableFrom` — enemies ignore obstacles and blocking them causes spawn issues.
- **SoundField cost**: Walls are fully opaque (no leakage). `MAX_COST=80` caps propagation range. Energy decays as `exp(-cost * 0.10)`. Rebuild the map each frame from the enemy's cell.
- **Enemy FSM**: Only two states now — SEARCHING and CHASING (SPOTTED was removed). Suspicion meter bridges the gap.
- **Footstep/bob sync**: Both use the same interval formula `1/(0.5 - speedT*0.2)`. Change one, change both.
- **Death animation**: Must call `player.resetCrouch()` AND snap camera position, since death animation bypasses `player.update()`.
- **Light pooling**: Only 8 `PointLight` instances are reused across the scene for performance. Don't create per-cell lights.

## Asset Files (public/)

Audio: `ambient-basement.mp3`, `ambient-house.mp3`, `ambient-village.mp3`, `enemy-chains.mp3`, `jumpscare-01.mp3`, `jumpscare-02.mp3`, `death-growl.mp3`, `notice.mp3`
Images: `item-key.png`, `item-map.png`, `item-compass.png`
Attribution: see `THIRD_PARTY_LICENSES.md`
