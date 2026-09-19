// Pitch detection AudioWorklet.
//
// Split into three concerns that never cross:
//   - `Config` — frozen tables & thresholds derived from sample rate.
//   - `Scratch` — reusable Float32Array buffers (no per-frame allocation).
//   - `State` — mutable streaming state (ring, HPF taps, history).
//
// Stages are plain functions with every input in their signature. The
// worklet itself is a thin adapter that owns the three objects.
//
// Algorithm: 2nd-order Butterworth HPF → windowed FFT for spectral gates
// (SFM + peak-to-median) → time-domain NSDF (McLeod) + peak-ratio picking
// → parabolic interpolation → median smoothing over recent confident
// estimates.

// ── AudioWorklet ambients ─────────────────────────────────────────────
// These globals only exist inside AudioWorkletGlobalScope; declare them
// locally so this file typechecks against the app's DOM lib.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

const SPEC_BINS = 96;
const SPEC_MIN_HZ = 40;
const SPEC_MAX_HZ = 4000;
const SFM_MAX_HZ = 5000;
const SMOOTH_WINDOW = 5;

// ── Config ────────────────────────────────────────────────────────────

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };
type Gates = { sfm: number; peakToMedian: number; clarity: number };

type Config = Readonly<{
  sampleRate: number;
  frame: number;
  hop: number;
  minHz: number;
  maxHz: number;
  hpfHz: number;
  rmsGate: number;
  peakRatioK: number;
  gates: Readonly<Gates>;
  minLag: number;
  maxLag: number;
  window: Float32Array;
  bitrev: Uint32Array;
  hpf: Biquad;
  fftBits: number;
}>;

const hann = (n: number): Float32Array => {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
};

const bitReversal = (n: number): Uint32Array => {
  const bits = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
    rev[i] = r;
  }
  return rev;
};

// RBJ audio-EQ cookbook biquad HPF, Q = 1/√2 for Butterworth response.
const butterworthHp2 = (fc: number, sr: number): Biquad => {
  const w0 = (2 * Math.PI * fc) / sr;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  const Q = Math.SQRT1_2;
  const alpha = sn / (2 * Q);
  const b0 = (1 + cs) / 2;
  const b1 = -(1 + cs);
  const b2 = (1 + cs) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cs;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
};

type ConfigOverrides = Partial<{
  frame: number;
  hop: number;
  minHz: number;
  maxHz: number;
  hpfHz: number;
  rmsGate: number;
  peakRatioK: number;
  gates: Partial<Gates>;
}>;

const makeConfig = (sr: number, overrides: ConfigOverrides = {}): Config => {
  const c = {
    frame: 8192,
    hop: 2048,
    minHz: 60,
    maxHz: 1200,
    hpfHz: 30,
    rmsGate: 0.01,
    peakRatioK: 0.9,
    ...overrides,
    gates: {
      sfm: 0.35,
      peakToMedian: 6,
      clarity: 0.6,
      ...(overrides.gates ?? {}),
    },
  };
  return Object.freeze({
    sampleRate: sr,
    frame: c.frame,
    hop: c.hop,
    minHz: c.minHz,
    maxHz: c.maxHz,
    hpfHz: c.hpfHz,
    rmsGate: c.rmsGate,
    peakRatioK: c.peakRatioK,
    gates: Object.freeze(c.gates),
    minLag: Math.floor(sr / c.maxHz),
    maxLag: Math.floor(sr / c.minHz),
    window: hann(c.frame),
    bitrev: bitReversal(c.frame),
    hpf: butterworthHp2(c.hpfHz, sr),
    fftBits: Math.log2(c.frame) | 0,
  });
};

// ── State + scratch ───────────────────────────────────────────────────

type Scratch = {
  x: Float32Array;
  xw: Float32Array;
  re: Float32Array;
  im: Float32Array;
  mag: Float32Array;
  nsdf: Float32Array;
  noise: Float32Array;
  spec: Float32Array;
};

const makeScratch = (cfg: Config): Scratch => ({
  x: new Float32Array(cfg.frame),
  xw: new Float32Array(cfg.frame),
  re: new Float32Array(cfg.frame),
  im: new Float32Array(cfg.frame),
  mag: new Float32Array(cfg.frame / 2),
  nsdf: new Float32Array(cfg.maxLag + 2),
  noise: new Float32Array(cfg.frame / 2),
  spec: new Float32Array(SPEC_BINS),
});

type HpfState = { x1: number; x2: number; y1: number; y2: number };
type HistoryEntry = { hz: number; clarity: number };
type State = {
  ring: Float32Array;
  writePos: number;
  filled: number;
  hopCount: number;
  hpf: HpfState;
  history: HistoryEntry[];
};

const makeState = (cfg: Config): State => ({
  ring: new Float32Array(cfg.frame),
  writePos: 0,
  filled: 0,
  hopCount: 0,
  hpf: { x1: 0, x2: 0, y1: 0, y2: 0 },
  history: [],
});

// ── Streaming ─────────────────────────────────────────────────────────

const pushSample = (cfg: Config, st: State, s: number): void => {
  const { b0, b1, b2, a1, a2 } = cfg.hpf;
  const h = st.hpf;
  const y = b0 * s + b1 * h.x1 + b2 * h.x2 - a1 * h.y1 - a2 * h.y2;
  h.x2 = h.x1;
  h.x1 = s;
  h.y2 = h.y1;
  h.y1 = y;
  st.ring[st.writePos] = y;
  st.writePos = (st.writePos + 1) % cfg.frame;
  if (st.filled < cfg.frame) st.filled++;
  st.hopCount++;
};

const readyForFrame = (cfg: Config, st: State): boolean =>
  st.filled >= cfg.frame && st.hopCount >= cfg.hop;

// ── Stages ────────────────────────────────────────────────────────────

const snapshot = (
  ring: Float32Array,
  writePos: number,
  out: Float32Array,
): Float32Array => {
  const n = ring.length;
  for (let i = 0; i < n; i++) out[i] = ring[(writePos + i) % n];
  return out;
};

const rms = (x: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
};

const applyWindow = (
  x: Float32Array,
  w: Float32Array,
  out: Float32Array,
): Float32Array => {
  for (let i = 0; i < x.length; i++) out[i] = x[i] * w[i];
  return out;
};

// In-place iterative Cooley-Tukey radix-2 FFT.
const fft = (re: Float32Array, im: Float32Array, bitrev: Uint32Array): void => {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const r = bitrev[i];
    if (r > i) {
      const tr = re[i];
      re[i] = re[r];
      re[r] = tr;
      const ti = im[i];
      im[i] = im[r];
      im[r] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wlenR = Math.cos(angle);
    const wlenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wR = 1;
      let wI = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const vR = re[b] * wR - im[b] * wI;
        const vI = re[b] * wI + im[b] * wR;
        const uR = re[a];
        const uI = im[a];
        re[a] = uR + vR;
        im[a] = uI + vI;
        re[b] = uR - vR;
        im[b] = uI - vI;
        const nwR = wR * wlenR - wI * wlenI;
        wI = wR * wlenI + wI * wlenR;
        wR = nwR;
      }
    }
  }
};

const magnitudeSpectrum = (cfg: Config, xw: Float32Array, sc: Scratch): Float32Array => {
  sc.re.set(xw);
  sc.im.fill(0);
  fft(sc.re, sc.im, cfg.bitrev);
  const n2 = cfg.frame / 2;
  for (let i = 0; i < n2; i++) sc.mag[i] = Math.hypot(sc.re[i], sc.im[i]);
  return sc.mag;
};

type GateResult = { sfm: number; peakRatio: number; tonal: boolean };

const spectralGates = (
  cfg: Config,
  mag: Float32Array,
  noiseScratch: Float32Array,
): GateResult => {
  const binHz = cfg.sampleRate / cfg.frame;
  const loBin = Math.max(1, Math.floor(cfg.minHz / binHz));
  const hiBin = Math.min(cfg.frame / 2 - 2, Math.ceil(cfg.maxHz / binHz));
  const sfmHi = Math.min(cfg.frame / 2 - 1, Math.floor(SFM_MAX_HZ / binHz));

  let sumLog = 0;
  let sumLin = 0;
  let count = 0;
  for (let i = loBin; i <= sfmHi; i++) {
    const m = mag[i] + 1e-12;
    sumLog += Math.log(m);
    sumLin += m;
    count++;
  }
  const geo = Math.exp(sumLog / count);
  const arith = sumLin / count;
  const sfm = arith > 0 ? geo / arith : 1;

  let peakMag = 0;
  for (let i = loBin; i <= hiBin; i++) {
    if (mag[i] > peakMag) peakMag = mag[i];
  }

  const nSamp = sfmHi - loBin + 1;
  for (let i = 0; i < nSamp; i++) noiseScratch[i] = mag[loBin + i];
  const sub = noiseScratch.subarray(0, nSamp);
  sub.sort();
  const median = sub[Math.floor(nSamp / 2)] + 1e-12;
  const peakRatio = peakMag / median;
  const tonal = sfm < cfg.gates.sfm && peakRatio >= cfg.gates.peakToMedian;
  return { sfm, peakRatio, tonal };
};

// McLeod NSDF: 2·r(τ) / (e_left(τ) + e_right(τ)). Ranges roughly in
// [-1, 1] where 1 = perfectly periodic at lag τ.
const nsdf = (cfg: Config, x: Float32Array, out: Float32Array): Float32Array => {
  const N = x.length;
  const maxLag = cfg.maxLag;
  for (let lag = 0; lag <= maxLag; lag++) {
    let r = 0;
    let eL = 0;
    let eR = 0;
    const end = N - lag;
    for (let i = 0; i < end; i++) {
      const a = x[i];
      const b = x[i + lag];
      r += a * b;
      eL += a * a;
      eR += b * b;
    }
    out[lag] = (2 * r) / (eL + eR + 1e-12);
  }
  return out;
};

type PickResult = { lag: number; clarity: number };

// MPM picking: find the tallest local max in [minLag, maxLag], then take
// the first local max whose height is ≥ k × tallest. Prevents octave-down
// misfires when a shorter-lag peak sits below a stronger harmonic.
const pickPeriod = (cfg: Config, n: Float32Array): PickResult | null => {
  const minLag = cfg.minLag;
  const maxLag = cfg.maxLag;
  let bestClarity = -Infinity;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (n[lag] > n[lag - 1] && n[lag] >= n[lag + 1] && n[lag] > 0) {
      if (n[lag] > bestClarity) bestClarity = n[lag];
    }
  }
  if (bestClarity <= 0) return null;
  const threshold = cfg.peakRatioK * bestClarity;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (
      n[lag] > n[lag - 1] &&
      n[lag] >= n[lag + 1] &&
      n[lag] > 0 &&
      n[lag] >= threshold
    ) {
      // Parabolic sub-sample interpolation around the peak.
      const y1 = n[lag - 1];
      const y2 = n[lag];
      const y3 = n[lag + 1];
      const d = y1 - 2 * y2 + y3;
      const shift = d !== 0 ? (0.5 * (y1 - y3)) / d : 0;
      const clarity = y2 - 0.25 * (y1 - y3) * shift;
      return { lag: lag + shift, clarity };
    }
  }
  return null;
};

// Log-frequency downsampled spectrogram column for the UI.
const logSpectrogram = (
  cfg: Config,
  mag: Float32Array,
  out: Float32Array,
): Float32Array => {
  const binHz = cfg.sampleRate / cfg.frame;
  const logMin = Math.log2(SPEC_MIN_HZ);
  const logMax = Math.log2(SPEC_MAX_HZ);
  const n2 = cfg.frame / 2;
  for (let bin = 0; bin < SPEC_BINS; bin++) {
    const loLog = logMin + (bin / SPEC_BINS) * (logMax - logMin);
    const hiLog = logMin + ((bin + 1) / SPEC_BINS) * (logMax - logMin);
    const loBin = Math.max(1, Math.floor(Math.pow(2, loLog) / binHz));
    const hiBin = Math.min(n2 - 1, Math.ceil(Math.pow(2, hiLog) / binHz));
    let peak = 0;
    for (let i = loBin; i <= hiBin; i++) {
      if (mag[i] > peak) peak = mag[i];
    }
    out[bin] = peak;
  }
  return out;
};

// Median of the last N confident (hz > 0) estimates. Confidence-weighting
// happens implicitly because we drop hz = -1 frames.
const smooth = (history: HistoryEntry[], est: HistoryEntry): number => {
  history.push(est);
  if (history.length > SMOOTH_WINDOW) history.shift();
  const hzs: number[] = [];
  for (const e of history) if (e.hz > 0) hzs.push(e.hz);
  if (hzs.length === 0) return -1;
  hzs.sort((a, b) => a - b);
  return hzs[Math.floor(hzs.length / 2)];
};

// ── Frame analysis ────────────────────────────────────────────────────

type FrameOut = { rms: number; hz: number; sfm: number; spec: Float32Array };

const analyzeFrame = (cfg: Config, sc: Scratch, st: State): FrameOut => {
  const x = snapshot(st.ring, st.writePos, sc.x);
  const level = rms(x);
  if (level < cfg.rmsGate) {
    sc.spec.fill(0);
    // Feed silence into the smoother so the history flushes to -1.
    smooth(st.history, { hz: -1, clarity: 0 });
    return { rms: level, hz: -1, sfm: 1, spec: sc.spec };
  }

  const mag = magnitudeSpectrum(cfg, applyWindow(x, cfg.window, sc.xw), sc);
  const g = spectralGates(cfg, mag, sc.noise);
  const period = g.tonal ? pickPeriod(cfg, nsdf(cfg, x, sc.nsdf)) : null;
  const raw =
    period && period.clarity >= cfg.gates.clarity ? cfg.sampleRate / period.lag : -1;
  const hz = smooth(st.history, { hz: raw, clarity: period?.clarity ?? 0 });
  return { rms: level, hz, sfm: g.sfm, spec: logSpectrogram(cfg, mag, sc.spec) };
};

// ── Worklet adapter ───────────────────────────────────────────────────

type GatesMessage = {
  type: 'gates';
  sfm?: number;
  peakToMedian?: number;
  clarity?: number;
};

class PitchProcessor extends AudioWorkletProcessor {
  private cfg: Config;
  private sc: Scratch;
  private st: State;

  constructor() {
    super();
    this.cfg = makeConfig(sampleRate);
    this.sc = makeScratch(this.cfg);
    this.st = makeState(this.cfg);
    this.port.onmessage = (e: MessageEvent<GatesMessage>) => {
      const d = e.data;
      if (d?.type === 'gates') {
        // Rebuild config so it stays frozen; tables/coefficients don't
        // need to change since gate-only overrides won't touch them.
        this.cfg = makeConfig(sampleRate, {
          gates: {
            sfm: d.sfm ?? this.cfg.gates.sfm,
            peakToMedian: d.peakToMedian ?? this.cfg.gates.peakToMedian,
            clarity: d.clarity ?? this.cfg.gates.clarity,
          },
        });
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      pushSample(this.cfg, this.st, ch[i]);
      if (readyForFrame(this.cfg, this.st)) {
        const out = analyzeFrame(this.cfg, this.sc, this.st);
        this.st.hopCount = 0;
        // Copy spec so scratch memory stays owned here.
        const specCopy = new Float32Array(out.spec);
        this.port.postMessage(
          { rms: out.rms, hz: out.hz, sfm: out.sfm, bins: specCopy },
          [specCopy.buffer as ArrayBuffer],
        );
      }
    }
    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);
