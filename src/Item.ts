import * as THREE from 'three';

export type ItemType = 'key' | 'map' | 'compass';

const ITEM_TEXTURES: Record<ItemType, string> = {
  key:     'item-key.png',
  map:     'item-map.png',
  compass: 'item-compass.png',
};

const FLOAT_SPEED    = 2.0;   // oscillation speed
const FLOAT_AMP      = 0.25;  // up/down amplitude
const COLLECT_RADIUS = 2.0;   // how close the player must be
const SPRITE_HEIGHT  = 1.4;   // target height in world units

// Aspect ratios (width / height) measured from the source images
const ITEM_ASPECTS: Record<ItemType, number> = {
  key:     1.5,    // landscape ~3:2
  map:     1.5,    // landscape ~3:2
  compass: 0.9,    // nearly square, slightly wide
};

export class Item {
  mesh: THREE.Mesh;
  type: ItemType;
  floorIndex: number;
  collected = false;

  private baseY: number;
  private glow: THREE.PointLight;

  constructor(scene: THREE.Scene, type: ItemType, worldPos: THREE.Vector3, floorIndex: number) {
    this.type = type;
    this.floorIndex = floorIndex;
    this.baseY = worldPos.y + 1.2; // float above ground

    const loader = new THREE.TextureLoader();
    const tex = loader.load(ITEM_TEXTURES[type]);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    const aspect = ITEM_ASPECTS[type];
    const geo = new THREE.PlaneGeometry(SPRITE_HEIGHT * aspect, SPRITE_HEIGHT);
    const mat = new THREE.MeshLambertMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveIntensity: 0.05,  // 5% self-lighting
      transparent: true,
      alphaTest: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(worldPos.x, this.baseY, worldPos.z);
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);

    // Small glow under the item
    const glowColor = type === 'key' ? 0xffcc00 : type === 'map' ? 0x44aaff : 0x44ff88;
    this.glow = new THREE.PointLight(glowColor, 2.0, 8);
    this.glow.position.copy(this.mesh.position);
    scene.add(this.glow);
  }

  update(t: number, playerPos: THREE.Vector3, playerFloor: number, camera: THREE.Camera): boolean {
    if (this.collected) return false;

    // Hide if not on the same floor
    const visible = this.floorIndex === playerFloor;
    this.mesh.visible = visible;
    this.glow.visible = visible;
    if (!visible) return false;

    // Float (no rotation — billboard toward camera)
    this.mesh.position.y = this.baseY + Math.sin(t * FLOAT_SPEED) * FLOAT_AMP;
    const toCamera = camera.position.clone().sub(this.mesh.position);
    toCamera.y = 0;
    this.mesh.rotation.y = Math.atan2(toCamera.x, toCamera.z);
    this.glow.position.y = this.mesh.position.y - 0.5;
    this.glow.intensity = 1.5 + Math.sin(t * 3) * 0.5;

    // Check collection
    const dist = this.mesh.position.distanceTo(playerPos);
    if (dist < COLLECT_RADIUS) {
      this.collect();
      return true;
    }
    return false;
  }

  private collect() {
    this.collected = true;
    this.mesh.visible = false;
    this.glow.visible = false;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.mesh);
    scene.remove(this.glow);
  }
}
