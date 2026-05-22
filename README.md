# Maze Game

A 3D first-person horror maze game built with Three.js and TypeScript — made just for fun!

## Play

https://daveruiz.github.io/maze-game/

## The Story

You remember him as a baby. Those tiny hands. That toothless smile. He used to run toward you with arms wide open, shouting *"Papa!"* like you were the greatest thing in the universe.

Then he turned thirteen.

At first, it was subtle. The grunts. The eye rolls. The way he'd appear in the kitchen at midnight demanding food — not asking, *demanding* — like some kind of creature risen from the depths. His room became a forbidden catacomb: dark, foul-smelling, and full of unspeakable things.

By fourteen, the transformation was complete. The sweet boy was gone. In his place stood something else entirely — a towering, ravenous beast fueled by hormones and Wi-Fi, roaming the house at all hours, hunting you down with a single, terrifying demand:

*"Dad. Unlock the computer."*

There is no reasoning with him. There is no negotiation. He can hear the sound of a laptop opening from three floors away. He can sense a password being typed. And he will *never* stop asking.

*"Just five more minutes."* *"I need it for homework."* *"PLEASE, Dad. PLEASE."*

Your only hope? Run. Hide in the darkness. Turn off your flashlight so he can't find you. Navigate the increasingly chaotic maze that your home has become — from the tight, suffocating **basement** where you've been hiding with the router, through the sprawling **haunted house** that used to be your peaceful home, and into the vast, abandoned **village** outside where other fathers have already fled.

He is out there. He is getting faster. And he brought friends — all of them need the Wi-Fi password.

*Good luck, Papa.*

---

This is a personal project made for fun and learning. Navigate through three increasingly challenging floors, avoid enemies, and find the exit!

### Floors

- **Sótano** — tight recursive maze with obstacles
- **La Casa** — a sprawling haunted house with rooms and corridors (2x size)
- **El Pueblo** — a massive abandoned village with dead ends and narrow alleys (5x size)

### Features

- First-person 3D navigation with flashlight mechanics
- Animated 3D enemies (GLB models with skeletal animation)
- Speed-zone locomotion system with crossfade transitions
- Suspicion-driven AI: idle → investigate → chase → hunt
- Line-of-sight detection with direct chase movement
- Hunt mode: enemies converge on the player after key collection
- 3D positional audio for enemy vocalizations and chains
- Hard shadows from flashlight and lanterns
- Cinematic death sequence with hit flinch and VHS overlay
- Flashlight battery drain/recharge system
- Post-processing effects (film grain, vignette, posterization)
- Minimap with enemy tracking
- Jumpable obstacles
- Gamepad and touch controls

### Controls

**Keyboard + Mouse**
- **WASD / Arrow keys** — Move
- **Mouse** — Look around
- **Shift** — Sprint
- **Space** — Jump
- **F** — Toggle flashlight

**Gamepad**
- **Left stick** — Move (L3 press to sprint)
- **Right stick** — Look around
- **A / Cross** — Jump
- **X / Square** — Toggle flashlight

**Touch** (auto-detected)
- **Left side** — Virtual joystick (push to edge to sprint)
- **Right side** — Drag to look around
- **Buttons** — Jump & Flashlight

## Tech Stack

- Three.js
- TypeScript
- Vite
- Web Audio API (procedural + MP3 positional audio)

## Build

```bash
# Unix/Mac
npm install && npm run build

# Windows (via WSL)
powershell -File build.ps1
```

## Credits

- **3D Models** — David Ruiz
- **Textures** — David Ruiz
- **Sounds** — Sourced from [Pixabay](https://pixabay.com/) (see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for details)
- **Font** — Barriecito by Omnibus-Type (Google Fonts, OFL 1.1)
- **AI** — Built with heavy assistance from [Claude](https://claude.ai/) (Anthropic). Without AI this project would not have been possible.

## License

This project is for personal/educational use. Feel free to explore the code!
