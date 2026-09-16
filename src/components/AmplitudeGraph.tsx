import { onCleanup } from 'solid-js';
import type { TunerBuffers } from '../audio/useTuner';
import { HISTORY } from '../audio/useTuner';

export default function AmplitudeGraph(props: {
  buffers: TunerBuffers;
  visibleCount?: () => number;
}) {
  let canvas!: HTMLCanvasElement;
  let raf = 0;
  // Auto-scale: `peak` tracks the loudest recent RMS so bars fill the
  // panel for real signals — but is floored at MIN_PEAK so ambient noise
  // doesn't get amplified up to full height. ATTACK is moderate (peak
  // creeps up when louder samples arrive), RELEASE is very slow (so scale
  // doesn't blow up the moment a note ends).
  let peak = 0.15;
  const MIN_PEAK = 0.15;
  const ATTACK = 0.15;
  const RELEASE = 0.003;

  const draw = () => {
    const { amps, headRef } = props.buffers;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) {
      raf = requestAnimationFrame(draw);
      return;
    }
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const c = canvas.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);

    c.strokeStyle = '#1f1f1f';
    c.beginPath();
    c.moveTo(0, h / 2);
    c.lineTo(w, h / 2);
    c.stroke();

    const N = Math.min(HISTORY, Math.max(10, props.visibleCount?.() ?? HISTORY));
    const step = w / N;
    // Show the newest N samples ending at head-1.
    const startIdx = (headRef.value - N + HISTORY) % HISTORY;
    const idxAt = (i: number) => (startIdx + i) % HISTORY;

    let currentMax = 0;
    for (let i = 0; i < N; i++) {
      const v = amps[idxAt(i)];
      if (v > currentMax) currentMax = v;
    }
    const target = Math.max(currentMax, MIN_PEAK);
    const alpha = target > peak ? ATTACK : RELEASE;
    peak = peak + alpha * (target - peak);
    const scale = 1 / peak;

    c.fillStyle = '#10b981';
    for (let i = 0; i < N; i++) {
      const v = Math.min(1, amps[idxAt(i)] * scale);
      const bh = v * (h / 2 - 1);
      c.fillRect(i * step, h / 2 - bh, Math.max(1, step - 0.5), bh * 2);
    }

    raf = requestAnimationFrame(draw);
  };

  queueMicrotask(() => (raf = requestAnimationFrame(draw)));
  onCleanup(() => cancelAnimationFrame(raf));

  return <canvas ref={canvas} class="w-full h-full block" />;
}
