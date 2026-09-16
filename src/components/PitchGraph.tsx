import { createSignal, onCleanup, Show } from 'solid-js';
import type { TunerBuffers, NoiseRejectionPreset } from '../audio/useTuner';
import { HISTORY } from '../audio/useTuner';
import { notesInRange } from '../audio/notes';
import { uiState, setUi } from '../stores/ui';

const NOISE_LEVELS: NoiseRejectionPreset[] = ['loose', 'balanced', 'strict'];

const AVG_WINDOW = 12;
const DEFAULT_SEMITONES_VISIBLE = 3;
const DEFAULT_CENTER_HZ = 440;
const AXIS_W = 52;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function hzToNote(hz: number): string {
  if (hz <= 0) return '—';
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}
const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const NOTE_CATALOG = notesInRange(16, 8000);

export default function PitchGraph(props: {
  buffers: TunerBuffers;
  visibleCount?: () => number;
  semitonesVisible?: () => number;
  running?: () => boolean;
}) {
  let canvas!: HTMLCanvasElement;
  let raf = 0;
  const [hasPitch, setHasPitch] = createSignal(false);

  const canDecreaseNoise = () => uiState.noiseRejection !== 'loose';
  const decreaseNoise = () => {
    const idx = NOISE_LEVELS.indexOf(uiState.noiseRejection);
    if (idx > 0) setUi('noiseRejection', NOISE_LEVELS[idx - 1]);
  };

  const draw = () => {
    const { pitches, headRef, latestRef } = props.buffers;
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

    // rolling avg → log-Hz center
    let sumLog = 0;
    let count = 0;
    for (let i = 0; i < HISTORY && count < AVG_WINDOW; i++) {
      const hz = pitches[(headRef.value - 1 - i + HISTORY) % HISTORY];
      if (hz > 0) {
        sumLog += Math.log2(hz);
        count++;
      }
    }
    const logCenter = count > 0 ? sumLog / count : Math.log2(DEFAULT_CENTER_HZ);
    const semitonesVisible = props.semitonesVisible?.() ?? DEFAULT_SEMITONES_VISIBLE;
    const halfSpan = semitonesVisible / 12;
    const logLo = logCenter - halfSpan;
    const logHi = logCenter + halfSpan;
    const top = 2;
    const bottom = h - 2;
    const yFor = (hz: number) => {
      const norm = (Math.log2(hz) - logLo) / (logHi - logLo);
      return bottom - norm * (bottom - top);
    };

    // note grid + labels
    c.font = '11px system-ui';
    c.textBaseline = 'middle';
    const centerMidi = Math.round(69 + 12 * (logCenter - Math.log2(440)));
    for (const { hz, label } of NOTE_CATALOG) {
      const l = Math.log2(hz);
      if (l < logLo || l > logHi) continue;
      const y = yFor(hz);
      const midi = Math.round(69 + 12 * Math.log2(hz / 440));
      const isCenter = midi === centerMidi;
      c.strokeStyle = isCenter ? '#3f3f46' : '#171717';
      c.lineWidth = isCenter ? 1.5 : 1;
      c.beginPath();
      c.moveTo(AXIS_W, y);
      c.lineTo(w, y);
      c.stroke();

      c.fillStyle = isCenter ? '#e5e5e5' : '#525252';
      c.textAlign = 'right';
      c.fillText(label, AXIS_W - 6, y);
    }
    c.lineWidth = 1;

    // ± whole-tone chips on the axis
    const drawEdge = (midi: number) => {
      const hz = midiHz(midi);
      const l = Math.log2(hz);
      if (l < logLo || l > logHi) return;
      const y = yFor(hz);
      c.fillStyle = '#38bdf8';
      c.textAlign = 'right';
      c.font = '9px system-ui';
      c.fillText('◂', AXIS_W - 1, y);
    };
    drawEdge(centerMidi + 2);
    drawEdge(centerMidi - 2);

    // pitch trace
    const plotX = AXIS_W;
    const N = Math.min(HISTORY, Math.max(10, props.visibleCount?.() ?? HISTORY));
    const step = (w - plotX) / N;
    const startIdx = (headRef.value - N + HISTORY) % HISTORY;
    let anyValidPitch = false;
    c.strokeStyle = '#38bdf8';
    c.lineWidth = 2;
    c.beginPath();
    let started = false;
    let lastX = 0;
    let lastY = 0;
    let lastHz = -1;
    for (let i = 0; i < N; i++) {
      const hz = pitches[(startIdx + i) % HISTORY];
      if (hz <= 0) {
        started = false;
        continue;
      }
      anyValidPitch = true;
      const l = Math.log2(hz);
      if (l < logLo || l > logHi) {
        started = false;
        continue;
      }
      const y = yFor(hz);
      const x = plotX + i * step;
      if (!started) {
        c.moveTo(x, y);
        started = true;
      } else {
        c.lineTo(x, y);
      }
      lastX = x;
      lastY = y;
      lastHz = hz;
    }
    c.stroke();

    if (anyValidPitch !== hasPitch()) setHasPitch(anyValidPitch);

    // Overlay: note + Hz hovering the newest datapoint.
    const currHz = latestRef.hz > 0 ? latestRef.hz : lastHz;
    if (currHz > 0) {
      const note = hzToNote(currHz);
      const hzText = `${currHz.toFixed(1)} Hz`;

      const anchorX = latestRef.hz > 0 ? w - 2 : lastX;
      const anchorY = latestRef.hz > 0 ? yFor(latestRef.hz) : lastY;

      // marker dot
      c.fillStyle = '#38bdf8';
      c.beginPath();
      c.arc(anchorX, anchorY, 3, 0, Math.PI * 2);
      c.fill();

      // label box, anchored to the right, floated left of the dot
      c.font = '600 12px system-ui';
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      const noteW = c.measureText(note).width;
      c.font = '10px system-ui';
      const hzW = c.measureText(hzText).width;
      const padX = 6;
      const gap = 6;
      const boxW = noteW + gap + hzW + padX * 2;
      const boxH = 18;
      let boxX = anchorX - boxW - 6;
      if (boxX < plotX + 2) boxX = anchorX + 6;
      // Push the label well above the trace so it never covers pitch
      // history. Clamped to stay in-panel.
      const LABEL_OFFSET_UP = 50;
      const boxY = Math.max(
        2,
        Math.min(h - boxH - 2, anchorY - boxH / 2 - LABEL_OFFSET_UP),
      );

      c.fillStyle = 'rgba(10,10,10,0.85)';
      c.fillRect(boxX, boxY, boxW, boxH);
      c.strokeStyle = '#38bdf8';
      c.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);

      c.fillStyle = '#e0f2fe';
      c.font = '600 12px system-ui';
      c.fillText(note, boxX + padX, boxY + boxH / 2);
      c.fillStyle = '#94a3b8';
      c.font = '10px system-ui';
      c.fillText(hzText, boxX + padX + noteW + gap, boxY + boxH / 2);
    }

    raf = requestAnimationFrame(draw);
  };

  queueMicrotask(() => (raf = requestAnimationFrame(draw)));
  onCleanup(() => cancelAnimationFrame(raf));

  return (
    <div class="relative w-full h-full">
      <canvas ref={canvas} class="w-full h-full block" />
      <Show when={props.running?.() && !hasPitch()}>
        <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-neutral-950/95 border border-neutral-800 px-3 py-2 grid gap-2 max-w-[220px] shadow-lg shadow-black/50">
          <p class="text-[11px] text-neutral-300 leading-snug text-center">
            No pitch detected: try moving to a quieter area.
          </p>
          <Show when={canDecreaseNoise()}>
            <button
              type="button"
              class="px-2 py-1.5 text-[10px] font-medium border border-neutral-800 hover:bg-neutral-900 text-sky-300"
              onClick={decreaseNoise}
            >
              Decrease filtering to{' '}
              {NOISE_LEVELS[NOISE_LEVELS.indexOf(uiState.noiseRejection) - 1]}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
