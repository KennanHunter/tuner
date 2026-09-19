import { createSignal, onCleanup } from 'solid-js';
import pitchProcessorUrl from './processor/pitch-processor.ts?worker&url';

export const HISTORY = 1200;
export const SPEC_BINS = 96;
export const SPEC_MIN_HZ = 40;
export const SPEC_MAX_HZ = 4000;

export type TunerBuffers = {
  amps: Float32Array;
  pitches: Float32Array;
  // Flattened HISTORY × SPEC_BINS. Column `i` = spec[i * SPEC_BINS + bin].
  spectrogram: Float32Array;
  headRef: { value: number };
  latestRef: { rms: number; hz: number };
};

export type SmoothingPreset = 'off' | 'low' | 'medium' | 'high';
export type NoiseRejectionPreset = 'loose' | 'balanced' | 'strict';

export type TunerControls = {
  buffers: TunerBuffers;
  running: () => boolean;
  start: () => Promise<void>;
  stop: () => void;
  setSmoothing: (preset: SmoothingPreset) => void;
  setNoiseRejection: (preset: NoiseRejectionPreset) => void;
};

const NOISE_PRESETS: Record<
  NoiseRejectionPreset,
  { sfm: number; peakToMedian: number; clarity: number }
> = {
  loose: { sfm: 0.5, peakToMedian: 3, clarity: 0.5 },
  balanced: { sfm: 0.35, peakToMedian: 6, clarity: 0.6 },
  strict: { sfm: 0.2, peakToMedian: 10, clarity: 0.75 },
};

const SMOOTHING_PRESETS: Record<SmoothingPreset, { median: number; alpha: number }> = {
  off: { median: 1, alpha: 1 },
  low: { median: 3, alpha: 0.5 },
  medium: { median: 7, alpha: 0.2 },
  high: { median: 15, alpha: 0.08 },
};

export function createTuner(
  getDeviceId: () => string,
  onError: (message: string) => void,
): TunerControls {
  const buffers: TunerBuffers = {
    amps: new Float32Array(HISTORY),
    pitches: new Float32Array(HISTORY).fill(-1),
    spectrogram: new Float32Array(HISTORY * SPEC_BINS),
    headRef: { value: 0 },
    latestRef: { rms: 0, hz: -1 },
  };

  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let logTimer: ReturnType<typeof setInterval> | null = null;
  let frameCount = 0;
  let noisePreset: NoiseRejectionPreset = 'balanced';
  const [running, setRunning] = createSignal(false);

  const setNoiseRejection = (preset: NoiseRejectionPreset) => {
    noisePreset = preset;
    if (node) {
      node.port.postMessage({ type: 'gates', ...NOISE_PRESETS[preset] });
    }
  };

  // Adjustable smoothing.
  let medianN = SMOOTHING_PRESETS.medium.median;
  let emaAlpha = SMOOTHING_PRESETS.medium.alpha;
  const JUMP_SEMITONES = 3;
  const SILENCE_HOLD = 4;
  const rawWindow: number[] = [];
  let emaLog = -1;
  let silenceCount = 0;

  const setSmoothing = (preset: SmoothingPreset) => {
    const p = SMOOTHING_PRESETS[preset];
    medianN = p.median;
    emaAlpha = p.alpha;
    rawWindow.length = 0;
    emaLog = -1;
  };

  const smoothPitch = (rawHz: number): number => {
    if (rawHz <= 0) {
      silenceCount++;
      if (silenceCount >= SILENCE_HOLD) {
        rawWindow.length = 0;
        emaLog = -1;
        return -1;
      }
      return emaLog > 0 ? Math.pow(2, emaLog) : -1;
    }
    silenceCount = 0;

    rawWindow.push(rawHz);
    if (rawWindow.length > medianN) rawWindow.shift();
    const sorted = [...rawWindow].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const medianLog = Math.log2(median);

    if (emaLog < 0 || emaAlpha >= 1) {
      emaLog = medianLog;
    } else if (Math.abs(medianLog - emaLog) * 12 > JUMP_SEMITONES) {
      emaLog = medianLog;
    } else {
      emaLog = emaLog + emaAlpha * (medianLog - emaLog);
    }
    return Math.pow(2, emaLog);
  };

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const hzToNote = (hz: number) => {
    if (hz <= 0) return '—';
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  };

  const stop = () => {
    if (logTimer !== null) {
      clearInterval(logTimer);
      logTimer = null;
    }
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
      node = null;
    }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    ctx?.close();
    ctx = null;
    // Freeze the current state instead of clearing so the graphs keep
    // showing the last captured window.
    buffers.latestRef.rms = 0;
    rawWindow.length = 0;
    emaLog = -1;
    silenceCount = 0;
    setRunning(false);
  };

  const start = async () => {
    if (running()) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: getDeviceId() ? { exact: getDeviceId() } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      onError(
        (err as DOMException)?.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : 'Could not open microphone.',
      );
      return;
    }

    ctx = new AudioContext();
    try {
      await ctx.audioWorklet.addModule(pitchProcessorUrl);
    } catch (err) {
      onError(`Failed to load audio worklet: ${(err as Error).message}`);
      stop();
      return;
    }

    const source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pitch-processor');
    let latestSfm = 1;
    node.port.onmessage = (
      e: MessageEvent<{ rms: number; hz: number; sfm: number; bins?: Float32Array }>,
    ) => {
      const { rms, hz, sfm, bins } = e.data;
      const smoothed = smoothPitch(hz);
      latestSfm = sfm;
      buffers.latestRef.rms = rms;
      buffers.latestRef.hz = smoothed;
      const i = buffers.headRef.value;
      buffers.amps[i] = rms;
      buffers.pitches[i] = smoothed;
      if (bins && bins.length === SPEC_BINS) {
        buffers.spectrogram.set(bins, i * SPEC_BINS);
      }
      buffers.headRef.value = (i + 1) % HISTORY;
      frameCount++;
    };
    source.connect(node);
    // Sync current preset to the freshly-created worklet.
    node.port.postMessage({ type: 'gates', ...NOISE_PRESETS[noisePreset] });

    frameCount = 0;
    let lastLog = performance.now();
    logTimer = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastLog) / 1000;
      const fps = frameCount / dt;
      const { rms, hz } = buffers.latestRef;
      const detected = hz > 0;
      console.log(
        `[tuner] sr=${ctx?.sampleRate ?? '?'}Hz frames=${frameCount} (${fps.toFixed(1)}/s) ` +
          `rms=${rms.toFixed(4)} sfm=${latestSfm.toFixed(3)} ` +
          `pitch=${detected ? `${hz.toFixed(1)}Hz ${hzToNote(hz)}` : 'silent'}`,
      );
      frameCount = 0;
      lastLog = now;
    }, 1000);

    setRunning(true);
  };

  onCleanup(stop);
  return { buffers, running, start, stop, setSmoothing, setNoiseRejection };
}
