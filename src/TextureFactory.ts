import * as THREE from 'three';

function makeCanvas(size: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function hexToRgb(hex: number) {
  return {
    r: (hex >> 16) & 0xff,
    g: (hex >> 8) & 0xff,
    b: hex & 0xff,
  };
}

export function makeBrickTexture(baseColor: number, size = 256): THREE.CanvasTexture {
  const { r, g, b } = hexToRgb(baseColor);
  return makeCanvas(size, ctx => {
    // Base color
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, size, size);

    // Noise
    const imageData = ctx.getImageData(0, 0, size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 30;
      data[i]   = Math.min(255, Math.max(0, data[i]   + noise));
      data[i+1] = Math.min(255, Math.max(0, data[i+1] + noise));
      data[i+2] = Math.min(255, Math.max(0, data[i+2] + noise));
    }
    ctx.putImageData(imageData, 0, 0);

    // Bricks
    const bW = size / 4, bH = size / 8;
    ctx.strokeStyle = `rgba(0,0,0,0.5)`;
    ctx.lineWidth = 2;
    for (let row = 0; row < 8; row++) {
      const offset = (row % 2) * (bW / 2);
      for (let col = -1; col < 5; col++) {
        ctx.strokeRect(col * bW + offset, row * bH, bW, bH);
      }
    }

    // Grout highlight
    ctx.strokeStyle = `rgba(255,255,255,0.07)`;
    ctx.lineWidth = 1;
    for (let row = 0; row < 8; row++) {
      const offset = (row % 2) * (bW / 2);
      for (let col = -1; col < 5; col++) {
        ctx.strokeRect(col * bW + offset + 1, row * bH + 1, bW - 2, bH - 2);
      }
    }
  });
}

export function makeFloorTexture(baseColor: number, size = 256): THREE.CanvasTexture {
  const { r, g, b } = hexToRgb(baseColor);
  return makeCanvas(size, ctx => {
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, size, size);

    // Noise
    const imageData = ctx.getImageData(0, 0, size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 20;
      data[i]   = Math.min(255, Math.max(0, data[i]   + noise));
      data[i+1] = Math.min(255, Math.max(0, data[i+1] + noise));
      data[i+2] = Math.min(255, Math.max(0, data[i+2] + noise));
    }
    ctx.putImageData(imageData, 0, 0);

    // Tile grid
    const tS = size / 4;
    ctx.strokeStyle = `rgba(0,0,0,0.35)`;
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * tS, 0); ctx.lineTo(i * tS, size);
      ctx.moveTo(0, i * tS); ctx.lineTo(size, i * tS);
      ctx.stroke();
    }
  });
}

export function makeEnemySprite(size = 128): THREE.CanvasTexture {
  return makeCanvas(size, ctx => {
    // Transparent background
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;

    // Shadow/glow
    const grd = ctx.createRadialGradient(cx, cy + 20, 5, cx, cy, size * 0.45);
    grd.addColorStop(0, 'rgba(180,0,0,0.6)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);

    // Body — dark hooded shape
    ctx.fillStyle = '#1a0a0a';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 10, size * 0.30, size * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    // Hood
    ctx.fillStyle = '#110808';
    ctx.beginPath();
    ctx.arc(cx, cy - 8, size * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // Eyes — red glowing
    const eyeY = cy - 10;
    const eyeOff = 10;
    [-eyeOff, eyeOff].forEach(ox => {
      const eg = ctx.createRadialGradient(cx + ox, eyeY, 1, cx + ox, eyeY, 8);
      eg.addColorStop(0, '#ff4444');
      eg.addColorStop(0.5, '#aa0000');
      eg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.arc(cx + ox, eyeY, 8, 0, Math.PI * 2);
      ctx.fill();
    });

    // Claws / tendrils at bottom
    ctx.strokeStyle = 'rgba(80,10,10,0.7)';
    ctx.lineWidth = 2;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 12, cy + 38);
      ctx.bezierCurveTo(
        cx + i * 12 + (Math.random() - 0.5) * 10, cy + 50,
        cx + i * 14, cy + 60,
        cx + i * 16 + (Math.random() - 0.5) * 5, cy + 70
      );
      ctx.stroke();
    }
  });
}

export function makeWoodTexture(baseColor: number, size = 256): THREE.CanvasTexture {
  const { r, g, b } = hexToRgb(baseColor);
  return makeCanvas(size, ctx => {
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 18; i++) {
      const y = (i / 18) * size;
      const noise = (Math.random() - 0.5) * 6;
      ctx.strokeStyle = `rgba(0,0,0,${0.08 + Math.random() * 0.12})`;
      ctx.lineWidth = 1 + Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(0, y + noise);
      for (let x = 0; x < size; x += 20) {
        ctx.lineTo(x, y + noise + (Math.random() - 0.5) * 4);
      }
      ctx.stroke();
    }
    const plankW = size / 3;
    ctx.strokeStyle = `rgba(0,0,0,0.25)`;
    ctx.lineWidth = 2;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(i * plankW, 0); ctx.lineTo(i * plankW, size);
      ctx.stroke();
    }
  });
}

export function makeStoneTexture(baseColor: number, size = 256): THREE.CanvasTexture {
  const { r, g, b } = hexToRgb(baseColor);
  return makeCanvas(size, ctx => {
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, size, size);
    const imageData = ctx.getImageData(0, 0, size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const n = (Math.random() - 0.5) * 25;
      data[i]   = Math.min(255, Math.max(0, data[i]   + n));
      data[i+1] = Math.min(255, Math.max(0, data[i+1] + n));
      data[i+2] = Math.min(255, Math.max(0, data[i+2] + n));
    }
    ctx.putImageData(imageData, 0, 0);
    ctx.strokeStyle = `rgba(0,0,0,0.4)`;
    ctx.lineWidth = 2;
    const rows = 4;
    for (let row = 0; row < rows; row++) {
      const h = size / rows;
      const offset = (row % 2) * (size / 4);
      ctx.beginPath(); ctx.moveTo(0, row * h); ctx.lineTo(size, row * h); ctx.stroke();
      for (let col = 0; col < 3; col++) {
        const x = col * (size / 2.5) + offset;
        ctx.beginPath(); ctx.moveTo(x, row * h); ctx.lineTo(x + (Math.random() - 0.5) * 10, (row + 1) * h); ctx.stroke();
      }
    }
  });
}
