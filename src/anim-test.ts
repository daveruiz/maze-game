import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const MAX_SPEED = 8;

const ANIM_COLORS: Record<string, string> = {
  'Walking':              '#2a5fd6',
  'Alert':                '#c47b10',
  'Running':              '#c43030',
  'Triple_Combo_Attack':  '#2a7a2a',
  'run_fast_10_inplace':  '#8a2a8a',
};
function animColor(name: string) { return ANIM_COLORS[name] || '#555'; }

interface Zone {
  anim: string;
  minSpeed: number;
  maxSpeed: number;
  refSpeed: number;
  minScale: number;
}

// Speed zones — editable via the UI
const zones: Zone[] = [
  { anim: 'Alert',                minSpeed: 0,   maxSpeed: 0.1, refSpeed: 1.0, minScale: 1.0 },
  { anim: 'Walking',              minSpeed: 0.1, maxSpeed: 2.0, refSpeed: 1.4, minScale: 0.15 },
  { anim: 'run_fast_10_inplace',  minSpeed: 2.0, maxSpeed: 4.5, refSpeed: 3.0, minScale: 0.20 },
  { anim: 'Running',              minSpeed: 4.5, maxSpeed: MAX_SPEED, refSpeed: 5.0, minScale: 0.30 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Three.js setup
// ─────────────────────────────────────────────────────────────────────────────
const canvasWrap = document.getElementById('canvas-wrap')!;

// Debug globals — accessible from browser console
(window as any).__dbg = {};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
canvasWrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x181818);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(0, 1.7, 5.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.15, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 1;
controls.maxDistance = 14;
controls.update();

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
keyLight.position.set(3, 6, 4);
keyLight.castShadow = true;
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x8899ff, 0.6);
fillLight.position.set(-4, 3, -3);
scene.add(fillLight);

// Floor — treadmill: checker texture scrolls at the current speed so you can
// judge whether the animation's foot-plant matches ground travel.
const checkerCanvas = document.createElement('canvas');
checkerCanvas.width = 256;
checkerCanvas.height = 256;
const cctx = checkerCanvas.getContext('2d')!;
const tileSize = 32; // px per checker square
for (let y = 0; y < 256; y += tileSize) {
  for (let x = 0; x < 256; x += tileSize) {
    const dark = ((x / tileSize + y / tileSize) & 1) === 0;
    cctx.fillStyle = dark ? '#1a1a1a' : '#252525';
    cctx.fillRect(x, y, tileSize, tileSize);
  }
}
const checkerTex = new THREE.CanvasTexture(checkerCanvas);
checkerTex.wrapS = THREE.RepeatWrapping;
checkerTex.wrapT = THREE.RepeatWrapping;
checkerTex.repeat.set(5, 5); // 5×5 checker tiles across the 10-unit plane
checkerTex.magFilter = THREE.NearestFilter;

const floorMat = new THREE.MeshStandardMaterial({
  map: checkerTex, roughness: 0.9, metalness: 0,
});
const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), floorMat);
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.receiveShadow = true;
scene.add(floorMesh);

// Grid lines on top — also scrolls
const grid = new THREE.GridHelper(10, 10, 0x333333, 0x2a2a2a);
scene.add(grid);

// Treadmill scroll offset (accumulated)
let treadmillOffset = 0;

// Resize — fit canvas exactly to its container
function onResize() {
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(onResize).observe(canvasWrap);
onResize();

// ─────────────────────────────────────────────────────────────────────────────
// Animation state
// ─────────────────────────────────────────────────────────────────────────────
let mixer: THREE.AnimationMixer | null = null;
const actions = new Map<string, THREE.AnimationAction>();
let currentAnimName = '';
let overrideAnim: string | null = null;
let currentTS = 1.0;
let allClipNames: string[] = [];

// Suspicion blend — Alert animation runs as a persistent layer, weight = suspicion
let alertAction: THREE.AnimationAction | null = null;
let suspicionValue = 0;
let smoothAlertWeight = 0; // actual weight applied, lerps toward target over time

// Cross-fade duration when switching between locomotion animations
const CROSSFADE_DURATION = 0.3; // seconds

function playAnimation(name: string, fade = 0.25) {
  if (!mixer || name === currentAnimName) return;
  if (name === 'Alert') return; // Alert is managed as a blend layer
  const next = actions.get(name);
  if (!next) { console.warn('[anim-test] clip not found:', name); return; }

  next.loop = THREE.LoopRepeat;
  next.enabled = true;
  next.setEffectiveWeight(1);
  next.play();

  const prev = actions.get(currentAnimName);
  if (prev && prev !== alertAction && fade > 0) prev.crossFadeTo(next, fade, true);
  else if (prev && prev !== alertAction)        prev.stop();

  currentAnimName = name;
}

function scaleFor(speed: number, zone: Zone) {
  return Math.max(zone.minScale, speed / Math.max(0.001, zone.refSpeed));
}

function activeZoneFor(speed: number): Zone {
  for (const z of zones) if (speed <= z.maxSpeed) return z;
  return zones[zones.length - 1];
}

function applySpeed(speed: number) {
  const zone = activeZoneFor(speed);

  if (overrideAnim) {
    // Override mode: single clip, scale by the override's zone (or 1.0)
    const z = zones.find(z => z.anim === overrideAnim) || zone;
    currentTS = scaleFor(speed, z);
    if (mixer) mixer.timeScale = currentTS;
    highlightActiveZone(zone);
    return;
  }

  // Hard zone: pick ONE target animation, cross-fade to it
  if (zone.anim === 'Alert') {
    // Stopped: play the full-body Alert as the locomotion clip
    playAnimation('AlertFull', CROSSFADE_DURATION);
    currentTS = zone.minScale;
  } else {
    playAnimation(zone.anim, CROSSFADE_DURATION);
    currentTS = scaleFor(speed, zone);
  }
  if (mixer) mixer.timeScale = currentTS;
  highlightActiveZone(zone);
}

function highlightActiveZone(active: Zone) {
  document.querySelectorAll<HTMLElement>('.rzone').forEach(el => {
    el.classList.toggle('active', el.dataset.zoneIdx === String(zones.indexOf(active)));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Load model
// ─────────────────────────────────────────────────────────────────────────────
const loader = new GLTFLoader();
loader.load('/enemynew.glb', gltf => {
  document.getElementById('loading')!.style.display = 'none';

  const model = skeletonClone(gltf.scene) as THREE.Group;

  // Auto-scale to 2.31 world-units tall
  model.updateMatrixWorld(true);
  const b1 = new THREE.Box3().setFromObject(model);
  const h = b1.max.y - b1.min.y;
  if (h > 0) model.scale.setScalar(2.31 / h);
  model.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(model);
  model.position.y = -b2.min.y;   // feet at y = 0

  // Fix materials — override metalness so the model doesn't look like chrome.
  model.traverse(child => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.SkinnedMesh)) return;
    child.castShadow    = true;
    child.receiveShadow = false;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    const cloned = mats.map((m: THREE.Material) => {
      const mat = (m as THREE.MeshStandardMaterial).clone();
      mat.metalness = 0.0;          // kill chrome look
      mat.roughness = 0.85;         // matte flesh/cloth
      mat.emissiveIntensity = 0;
      mat.depthWrite = true;
      mat.depthTest  = true;
      if (mat.transparent && mat.opacity >= 0.99) {
        mat.transparent = false;
        mat.alphaTest = 0.1;
      }
      return mat;
    });
    child.material = cloned.length === 1 ? cloned[0] : cloned;
    if (child instanceof THREE.SkinnedMesh) child.frustumCulled = false;
  });

  // Leg bone names — Alert should NOT affect these (legs stay driven by locomotion)
  const LEG_BONES = [
    'LeftToeBase', 'LeftFoot', 'LeftLeg', 'LeftUpLeg',
    'RightToeBase', 'RightFoot', 'RightLeg', 'RightUpLeg',
  ];

  // Build mixer + actions
  mixer = new THREE.AnimationMixer(model);
  allClipNames = gltf.animations.map(c => c.name).sort();
  for (const clip of gltf.animations) {
    let useClip = clip;
    if (clip.name === 'Alert') {
      // Create TWO versions of Alert:
      // 1. Upper-body-only clip → blend layer (suspicion while moving)
      const upperTracks = clip.tracks.filter(t => {
        const boneName = t.name.split('.')[0];
        return !LEG_BONES.some(lb => boneName.includes(lb));
      });
      const upperClip = new THREE.AnimationClip('Alert', clip.duration, upperTracks);
      const upperAction = mixer!.clipAction(upperClip);
      upperAction.clampWhenFinished = true;
      actions.set('Alert', upperAction);

      // 2. Full-body clip → played as locomotion when stopped
      const fullClip = new THREE.AnimationClip('AlertFull', clip.duration, clip.tracks.slice());
      const fullAction = mixer!.clipAction(fullClip);
      fullAction.clampWhenFinished = true;
      actions.set('AlertFull', fullAction);
      continue;
    }
    const action = mixer.clipAction(useClip);
    action.clampWhenFinished = true;
    actions.set(clip.name, action);
  }

  // Set up Alert (upper-body) as a persistent blend layer (weight driven by suspicion slider)
  const alertAct = actions.get('Alert');
  if (alertAct) {
    alertAct.loop = THREE.LoopRepeat;
    alertAct.enabled = true;
    alertAct.setEffectiveWeight(0);
    alertAct.play();
    alertAction = alertAct;
  }

  scene.add(model);

  // ── Debug helpers (removed — no longer needed) ────────────────────────────


  // Log material state for debugging
  model.traverse(child => {
    if (child instanceof THREE.SkinnedMesh || child instanceof THREE.Mesh) {
      const mat = Array.isArray(child.material) ? child.material[0] : child.material;
      console.log(`[mat] ${child.name} → ${mat.type} roughness=${(mat as any).roughness} metalness=${(mat as any).metalness} visible=${mat.visible}`);
    }
  });

  // Expose debug info
  const dbg = (window as any).__dbg;
  dbg.model = model;
  dbg.scene = scene;
  dbg.camera = camera;
  dbg.mixer = mixer;
  dbg.modelPos = { x: model.position.x, y: model.position.y, z: model.position.z };
  dbg.modelScale = model.scale.x;
  dbg.sceneChildren = scene.children.length;

  // Build UI now we know clip names
  buildZoneCards();
  buildAnimButtons();

  applySpeed(parseFloat((document.getElementById('speed-slider') as HTMLInputElement).value));
  console.log('[anim-test] model loaded, clips:', allClipNames);

}, undefined, err => {
  document.getElementById('loading')!.innerHTML =
    `<span style="color:#f66">Failed to load /enemynew.glb</span><br><small>${err}</small>`;
  console.error('[anim-test] load error', err);
});

// ─────────────────────────────────────────────────────────────────────────────
// Speed slider
// ─────────────────────────────────────────────────────────────────────────────
const speedSlider = document.getElementById('speed-slider') as HTMLInputElement;

function onSpeedInput() {
  const v = parseFloat(speedSlider.value);
  document.getElementById('speed-val')!.textContent = v.toFixed(2);
  document.getElementById('st-spd')!.textContent    = v.toFixed(2);
  moveNeedle(v);
  applySpeed(v);
}
speedSlider.addEventListener('input', onSpeedInput);

// ─────────────────────────────────────────────────────────────────────────────
// Suspicion slider
// ─────────────────────────────────────────────────────────────────────────────
const suspicionSlider = document.getElementById('suspicion-slider') as HTMLInputElement;

function onSuspicionInput() {
  suspicionValue = parseFloat(suspicionSlider.value);
  document.getElementById('suspicion-val')!.textContent = suspicionValue.toFixed(2);
  document.getElementById('st-sus')!.textContent        = suspicionValue.toFixed(2);
}
suspicionSlider.addEventListener('input', onSuspicionInput);

// ─────────────────────────────────────────────────────────────────────────────
// Range bar
// ─────────────────────────────────────────────────────────────────────────────
function moveNeedle(speed: number) {
  const n = document.getElementById('speed-needle');
  if (n) n.style.left = (speed / MAX_SPEED * 100) + '%';
}

function buildRangeBar() {
  const bar = document.getElementById('rbar')!;
  bar.innerHTML = '';

  zones.forEach((z, i) => {
    const seg = document.createElement('div');
    seg.className = 'rzone';
    seg.dataset.zoneIdx = String(i);
    seg.style.background = animColor(z.anim);
    positionSeg(seg, z);
    seg.textContent = z.anim.replace('_', ' ');
    bar.appendChild(seg);
  });

  for (let i = 1; i < zones.length; i++) {
    const h = document.createElement('div');
    h.className = 'rhandle';
    h.dataset.handleIdx = String(i);
    positionHandle(h, zones[i].minSpeed);
    bar.appendChild(h);
    initHandleDrag(h, i);
  }

  const needle = document.createElement('div');
  needle.id = 'speed-needle';
  needle.style.left = (parseFloat(speedSlider.value) / MAX_SPEED * 100) + '%';
  bar.appendChild(needle);
}

function positionSeg(el: HTMLElement, zone: Zone) {
  el.style.left  = (zone.minSpeed / MAX_SPEED * 100) + '%';
  el.style.width = ((zone.maxSpeed - zone.minSpeed) / MAX_SPEED * 100) + '%';
}

function positionHandle(el: HTMLElement, speed: number) {
  el.style.left = (speed / MAX_SPEED * 100) + '%';
}

function initHandleDrag(handle: HTMLElement, zoneIdx: number) {
  let dragging = false;

  handle.addEventListener('mousedown', e => {
    dragging = true; handle.classList.add('dragging'); e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const bar  = document.getElementById('rbar')!;
    const rect = bar.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const spd  = pct * MAX_SPEED;

    const lo = zones[zoneIdx - 1].minSpeed + 0.3;
    const hi = zoneIdx < zones.length - 1 ? zones[zoneIdx + 1].maxSpeed - 0.3 : MAX_SPEED - 0.2;
    const clamped = Math.max(lo, Math.min(hi, spd));

    zones[zoneIdx - 1].maxSpeed = clamped;
    zones[zoneIdx].minSpeed     = clamped;

    refreshBarPositions();
    buildZoneCards();
    applySpeed(parseFloat(speedSlider.value));
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; handle.classList.remove('dragging'); }
  });
}

function refreshBarPositions() {
  zones.forEach((z, i) => {
    const seg = document.querySelector<HTMLElement>(`.rzone[data-zone-idx="${i}"]`);
    if (seg) positionSeg(seg, z);
    if (i > 0) {
      const h = document.querySelector<HTMLElement>(`.rhandle[data-handle-idx="${i}"]`);
      if (h) positionHandle(h, z.minSpeed);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone cards
// ─────────────────────────────────────────────────────────────────────────────
function buildZoneCards() {
  const container = document.getElementById('zone-cards')!;
  const focusedEl = document.activeElement as HTMLElement | null;
  const focusedZone  = focusedEl?.dataset?.zoneIdx;
  const focusedField = focusedEl?.dataset?.field;

  container.innerHTML = '';

  zones.forEach((zone, i) => {
    const col = animColor(zone.anim);
    const card = document.createElement('div');
    card.className = 'zcard';
    card.style.background = col + '18';
    card.style.border      = `1px solid ${col}40`;

    const sMin = scaleFor(zone.minSpeed, zone).toFixed(2);
    const sMid = scaleFor((zone.minSpeed + zone.maxSpeed) / 2, zone).toFixed(2);
    const sMax = scaleFor(zone.maxSpeed, zone).toFixed(2);

    const opts = allClipNames.map(n =>
      `<option value="${n}"${n === zone.anim ? ' selected' : ''}>${n}</option>`
    ).join('');

    const selectEl = allClipNames.length
      ? `<select data-zone-idx="${i}" data-field="anim" style="color:${col}">${opts}</select>`
      : `<span style="color:${col}">${zone.anim}</span>`;

    card.innerHTML = `
      <div class="zcard-head">
        <div class="zcard-dot" style="background:${col}"></div>
        <div class="zcard-name">${selectEl}</div>
      </div>
      <div class="zcard-range">${zone.minSpeed.toFixed(2)} – ${zone.maxSpeed.toFixed(2)} m/s</div>
      <div class="zcard-fields">
        <div class="zfield">
          <label>Ref speed  (→ timeScale = 1.0)</label>
          <input type="number" min="0.1" max="20" step="0.05" value="${zone.refSpeed}"
                 data-zone-idx="${i}" data-field="refSpeed">
        </div>
        <div class="zfield">
          <label>Min timeScale  (floor clamp)</label>
          <input type="number" min="0.01" max="3" step="0.01" value="${zone.minScale}"
                 data-zone-idx="${i}" data-field="minScale">
        </div>
      </div>
      <div class="zcard-scales">
        <span>@ ${zone.minSpeed.toFixed(2)}: <b>${sMin}×</b></span>
        <span>@ mid: <b>${sMid}×</b></span>
        <span>@ ${zone.maxSpeed.toFixed(2)}: <b>${sMax}×</b></span>
      </div>`;

    container.appendChild(card);
  });

  container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach(el => {
    el.addEventListener('change', () => onZoneFieldChange(el));
    el.addEventListener('input',  () => onZoneFieldChange(el));
    if (el.dataset.zoneIdx === focusedZone && el.dataset.field === focusedField) el.focus();
  });
}

function onZoneFieldChange(el: HTMLInputElement | HTMLSelectElement) {
  const i = parseInt(el.dataset.zoneIdx!);
  const f = el.dataset.field!;
  if (f === 'anim') {
    zones[i].anim = el.value;
    const seg = document.querySelector<HTMLElement>(`.rzone[data-zone-idx="${i}"]`);
    if (seg) { seg.style.background = animColor(el.value); seg.textContent = el.value.replace('_', ' '); }
    currentAnimName = '';
    applySpeed(parseFloat(speedSlider.value));
  } else {
    const val = parseFloat((el as HTMLInputElement).value);
    if (!isNaN(val) && val > 0) (zones[i] as any)[f] = val;
  }
  buildZoneCards();
  applySpeed(parseFloat(speedSlider.value));
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation override buttons
// ─────────────────────────────────────────────────────────────────────────────
function buildAnimButtons() {
  const container = document.getElementById('anim-btns')!;
  container.innerHTML = '';

  for (const name of allClipNames) {
    const btn = document.createElement('button');
    btn.className = 'abtn';
    btn.dataset.animName = name;
    btn.textContent = name;
    btn.style.borderColor = animColor(name) + '88';
    btn.addEventListener('click', () => {
      overrideAnim = name;
      currentAnimName = '';
      playAnimation(name, 0.2);
      document.querySelectorAll('.abtn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('btn-auto')!.classList.remove('active');
      document.getElementById('st-mode')!.textContent = 'override';
      applySpeed(parseFloat(speedSlider.value));
    });
    container.appendChild(btn);
  }
}

document.getElementById('btn-auto')!.addEventListener('click', () => {
  overrideAnim = null;
  currentAnimName = '';
  document.querySelectorAll('.abtn').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-auto')!.classList.add('active');
  document.getElementById('st-mode')!.textContent = 'speed';
  applySpeed(parseFloat(speedSlider.value));
});
(document.getElementById('btn-auto') as HTMLElement).classList.add('active');

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('export-btn')!.addEventListener('click', () => {
  const lines: string[] = [
    `// ── Animation speed zones (from anim-test) ──────────────────────────`,
  ];
  zones.forEach((z, i) => {
    lines.push(`// Zone ${i}: ${z.anim}  ${z.minSpeed.toFixed(2)}–${z.maxSpeed.toFixed(2)} m/s  ref=${z.refSpeed}  minScale=${z.minScale}`);
  });
  lines.push('');
  zones.forEach((z, i) => {
    const prefix = i === 0 ? 'if' : '} else if';
    lines.push(`${prefix} (actualSpeed <= ${z.maxSpeed}) {`);
    lines.push(`  this.playAnimation('${z.anim}', 0.3);`);
    lines.push(`  this.mixer.timeScale = Math.max(${z.minScale}, actualSpeed / ${z.refSpeed});`);
  });
  lines.push('}');
  const code = lines.join('\n');

  navigator.clipboard.writeText(code).then(() => {
    const t = document.getElementById('copy-toast')!;
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 2000);
  }).catch(() => {});

  const out = document.getElementById('export-out')!;
  out.textContent = code;
  out.style.display = 'block';
});

// ─────────────────────────────────────────────────────────────────────────────
// Render loop
// ─────────────────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
(function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const speed = parseFloat(speedSlider.value);

  // Target alert weight: forced to 1.0 when stopped, otherwise driven by slider
  const targetAlert = speed <= zones[0].maxSpeed ? 1.0 : suspicionValue;

  // Smooth lerp toward target — pose interpolation, not instant snap
  smoothAlertWeight += (targetAlert - smoothAlertWeight) * Math.min(1, 5 * dt);

  // Apply smoothed suspicion → Alert blend weight
  if (alertAction) (alertAction as THREE.AnimationAction).setEffectiveWeight(smoothAlertWeight);

  if (mixer) (mixer as THREE.AnimationMixer).update(dt);
  controls.update();

  // Treadmill: scroll floor texture + grid at current speed (backward = enemy appears to move forward)
  treadmillOffset += speed * dt;
  // Texture scroll — 1 world-unit = repeat/planeSize tiles (repeat=5, plane=10 → 0.5 per unit)
  checkerTex.offset.y = -treadmillOffset * (checkerTex.repeat.y / 10);
  // Grid scroll — move the grid mesh along Z
  grid.position.z = -(treadmillOffset % 2); // repeats every 2 units (grid cell size = 10/10 = 1)

  renderer.render(scene, camera);

  document.getElementById('st-anim')!.textContent = currentAnimName || '—';
  document.getElementById('st-ts')!.textContent   = currentTS.toFixed(2) + '×';
})();

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
buildRangeBar();
buildZoneCards();
onSpeedInput();
