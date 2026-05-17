/**
 * Combined post-processing shader:
 *  - Saturation boost (warm horror tones)
 *  - Posterize (reduce colour bands for retro/creepy look)
 *  - Film grain noise (animated per-frame)
 *  - Subtle vignette (darken edges)
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

    varying vec2 vUv;

    // Simple pseudo-random
    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 col = texel.rgb;

      // ── Brightness boost ─────────────────────────────
      col *= brightness;

      // ── Saturation ───────────────────────────────────
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(lum), col, saturation);

      // ── Posterize ────────────────────────────────────
      col = floor(col * posterLevels + 0.5) / posterLevels;

      // ── Film grain noise ─────────────────────────────
      float grain = rand(vUv * 800.0 + time * 100.0) - 0.5;
      col += grain * noiseAmount;

      // ── Vignette ─────────────────────────────────────
      vec2 uvc = vUv - 0.5;
      float vig = 1.0 - dot(uvc, uvc) * vignetteStr * 2.5;
      col *= clamp(vig, 0.0, 1.0);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), texel.a);
    }
  `,
};
