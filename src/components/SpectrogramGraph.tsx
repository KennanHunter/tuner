import { onCleanup } from 'solid-js';
import type { TunerBuffers } from '../audio/useTuner';
import { HISTORY, SPEC_BINS } from '../audio/useTuner';

// Log-magnitude → color LUT. Bright turquoise for peaks, deep blue for low
// energy, black background.
function color(intensity: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, intensity));
  // Piecewise: 0..0.4 blue-ish, 0.4..0.8 cyan, 0.8..1 white.
  if (t < 0.4) {
    const k = t / 0.4;
    return [Math.round(20 * k), Math.round(60 * k), Math.round(120 + 40 * k)];
  } else if (t < 0.8) {
    const k = (t - 0.4) / 0.4;
    return [Math.round(20 + 40 * k), Math.round(60 + 140 * k), Math.round(160 + 60 * k)];
  } else {
    const k = (t - 0.8) / 0.2;
    return [Math.round(60 + 195 * k), Math.round(200 + 55 * k), Math.round(220 + 35 * k)];
  }
}

export default function SpectrogramGraph(props: {
  buffers: TunerBuffers;
  visibleCount?: () => number;
}) {
  let canvas!: HTMLCanvasElement;
  let raf = 0;
  // Auto-scale to the loudest bin recently seen — same idea as
  // AmplitudeGraph. Fast attack, slow release.
  let peak = 0.05;
  const MIN_PEAK = 0.02;
  const ATTACK = 0.3;
  const RELEASE = 0.005;

  const draw = () => {
    const { spectrogram, headRef } = props.buffers;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) {
      raf = requestAnimationFrame(draw);
      return;
    }
    const N = Math.min(HISTORY, Math.max(10, props.visibleCount?.() ?? HISTORY));
    // Draw at native resolution N × SPEC_BINS and let CSS scale up. Pixel
    // rendering stays crisp with `image-rendering: pixelated`.
    if (canvas.width !== N || canvas.height !== SPEC_BINS) {
      canvas.width = N;
      canvas.height = SPEC_BINS;
    }
    const c = canvas.getContext('2d')!;
    const img = c.createImageData(N, SPEC_BINS);
    const data = img.data;

    // Recompute the running peak across the visible window.
    const startIdx = (headRef.value - N + HISTORY) % HISTORY;
    let currentMax = 0;
    for (let i = 0; i < N; i++) {
      const col = (startIdx + i) % HISTORY;
      for (let b = 0; b < SPEC_BINS; b++) {
        const v = spectrogram[col * SPEC_BINS + b];
        if (v > currentMax) currentMax = v;
      }
    }
    const target = Math.max(currentMax, MIN_PEAK);
    const alpha = target > peak ? ATTACK : RELEASE;
    peak = peak + alpha * (target - peak);
    const scale = 1 / peak;

    // Fill pixels. Y axis inverted: bin 0 (low freq) at bottom.
    for (let i = 0; i < N; i++) {
      const col = (startIdx + i) % HISTORY;
      for (let b = 0; b < SPEC_BINS; b++) {
        const v = spectrogram[col * SPEC_BINS + b] * scale;
        // Log-mag compression for perceptual contrast.
        const mag = v > 0 ? Math.min(1, Math.log10(1 + 9 * v)) : 0;
        const [r, g, bl] = color(mag);
        const y = SPEC_BINS - 1 - b;
        const p = (y * N + i) * 4;
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = bl;
        data[p + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    raf = requestAnimationFrame(draw);
  };

  queueMicrotask(() => (raf = requestAnimationFrame(draw)));
  onCleanup(() => cancelAnimationFrame(raf));

  return (
    <canvas
      ref={canvas}
      class="w-full h-full block"
      style={{ 'image-rendering': 'pixelated' }}
    />
  );
}
