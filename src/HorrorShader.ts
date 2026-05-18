/**
 * Combined post-processing shader:
 *  - Saturation boost (warm horror tones)
 *  - Posterize (reduce colour bands for retro/creepy look)
 *  - Film grain noise (animated per-frame)
 *  - Subtle vignette (darken edges)
 *  - VHS death effect (scanlines, distortion, color bleed, heavy static)
 */
export const HorrorShader = {
  uniforms: {
    tDiffuse:     { value: null },
    time:         { value: 0.0 },
    brightness:   { value: 1.10 },   // +10% brightness
    saturation:   { value: 1.35 },   // >1 = more saturated
    posterLevels: { value: 12.0 },   // lower = more posterised
    noiseAmount:  { value: 0.08 },   // grain intensity
    vignetteStr:  { value: 0.45 },   // vignette darkness
    // VHS death effect (0 = off, 1 = full)
    vhsIntensity:   { value: 0.0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float brightness;
    uniform float saturation;
    uniform float posterLevels;
    uniform float noiseAmount;
    uniform float vignetteStr;
    uniform float vhsIntensity;

    varying vec2 vUv;

    // Simple pseudo-random
    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;

      // ── VHS distortion ───────────────────────────────
      if (vhsIntensity > 0.0) {
        // Horizontal jitter — scanline-like wobble
        float jitter = rand(vec2(floor(uv.y * 200.0), time * 30.0)) - 0.5;
        uv.x += jitter * 0.025 * vhsIntensity;

        // Rolling band — thick distortion bar that scrolls
        float band = smoothstep(0.0, 0.06, abs(fract(uv.y - time * 0.8) - 0.5) - 0.3);
        uv.x += (1.0 - band) * 0.04 * sin(time * 20.0) * vhsIntensity;

        // Occasional big glitch
        float glitch = step(0.97, rand(vec2(floor(time * 8.0), 1.0)));
        uv.x += glitch * (rand(vec2(uv.y, time)) - 0.5) * 0.15 * vhsIntensity;
      }

      // ── Chromatic aberration (VHS color bleed) ───────
      vec3 col;
      if (vhsIntensity > 0.0) {
        float aberr = 0.008 * vhsIntensity;
        col.r = texture2D(tDiffuse, vec2(uv.x + aberr, uv.y)).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, vec2(uv.x - aberr, uv.y)).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // ── Brightness boost ─────────────────────────────
      col *= brightness;

      // ── Saturation ───────────────────────────────────
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      // VHS desaturates toward the end
      float sat = mix(saturation, 0.3, vhsIntensity * 0.6);
      col = mix(vec3(lum), col, sat);

      // ── Posterize ────────────────────────────────────
      float levels = mix(posterLevels, 5.0, vhsIntensity * 0.7);
      col = floor(col * levels + 0.5) / levels;

      // ── Film grain / VHS static ──────────────────────
      float grain = rand(uv * 800.0 + time * 100.0) - 0.5;
      float totalNoise = mix(noiseAmount, 0.5, vhsIntensity);
      col += grain * totalNoise;

      // ── VHS scanlines ────────────────────────────────
      if (vhsIntensity > 0.0) {
        float scanline = sin(uv.y * 800.0) * 0.5 + 0.5;
        col *= 1.0 - scanline * 0.3 * vhsIntensity;

        // Occasional horizontal white noise bars
        float noiseLine = step(0.985, rand(vec2(floor(uv.y * 120.0), floor(time * 12.0))));
        col += noiseLine * 0.6 * vhsIntensity;
      }

      // ── Vignette ─────────────────────────────────────
      vec2 uvc = vUv - 0.5;
      float vigStr = mix(vignetteStr, 1.2, vhsIntensity);
      float vig = 1.0 - dot(uvc, uvc) * vigStr * 2.5;
      col *= clamp(vig, 0.0, 1.0);

      // ── VHS color tint (sickly green/red) ────────────
      if (vhsIntensity > 0.0) {
        col.r += 0.06 * vhsIntensity;
        col.g -= 0.02 * vhsIntensity;
      }

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};
