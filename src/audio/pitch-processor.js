// AudioWorkletProcessor: isolate a pure instrument tone from noise.
//
// Pipeline per 2048-sample frame:
//   1. RMS gate on the raw signal (skip silence).
//   2. DC removal + pre-emphasis high-pass (kills sub-bass rumble).
//   3. Hann window.
//   4. FFT → magnitude spectrum.
//      a. Spectral flatness measure (SFM): rejects broadband noise
//         (HVAC, fan, keyboard) even when it's loud.
//      b. Peak-to-median ratio: the dominant bin must stand well above
//         the noise floor.
//   5. Normalized autocorrelation with first-significant-peak picking
//      chooses the fundamental (robust against harmonic-heavy instrument
//      tones where the 2nd/3rd harmonic can be louder than the 1st).
//   6. Parabolic interpolation on the winning lag for sub-sample Hz.

// Long analysis window for low-note accuracy: at 48 kHz, 8192 samples ≈
// 170 ms, so a 60 Hz signal fits ~10 periods per frame — plenty for a
// reliable autocorrelation. Latency is bounded by the frame *midpoint*
// (~85 ms), not the emit rate — so we overlap frames with a small HOP and
// keep the update cadence snappy.
const FRAME = 8192;
const FFT_BITS = 13; // log2(FRAME)
const HOP = 2048; // emit every 2048 new samples (~23/sec at 48 kHz)
const MIN_HZ = 60;
const MAX_HZ = 1200;
const RMS_GATE = 0.01;

// Downsampled log-frequency spectrogram we send back to main every frame.
const SPEC_BINS = 96;
const SPEC_MIN_HZ = 40;
const SPEC_MAX_HZ = 4000;
const SPEC_LOG_MIN = Math.log2(SPEC_MIN_HZ);
const SPEC_LOG_MAX = Math.log2(SPEC_MAX_HZ);

// Adjustable via port message: { type: 'gates', sfm, peakToMedian, clarity }
const DEFAULT_GATES = {
  sfm: 0.35,
  peakToMedian: 6,
  clarity: 0.6,
};

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer of the last FRAME samples. `writePos` is the *next* slot
    // to write (i.e. the oldest sample sits there once the ring is full).
    this.buf = new Float32Array(FRAME);
    this.linear = new Float32Array(FRAME); // unrolled snapshot for analysis
    this.work = new Float32Array(FRAME);
    this.fftReal = new Float32Array(FRAME);
    this.fftImag = new Float32Array(FRAME);
    this.mag = new Float32Array(FRAME / 2);
    this.window = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FRAME - 1)));
    }
    this.rev = new Uint32Array(FRAME);
    for (let i = 0; i < FRAME; i++) {
      let r = 0;
      for (let b = 0; b < FFT_BITS; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.writePos = 0;
    this.filled = 0;
    this.hopCount = 0;
    this.prev = 0;
    this.gates = { ...DEFAULT_GATES };
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'gates') {
        if (typeof d.sfm === 'number') this.gates.sfm = d.sfm;
        if (typeof d.peakToMedian === 'number') this.gates.peakToMedian = d.peakToMedian;
        if (typeof d.clarity === 'number') this.gates.clarity = d.clarity;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;
    const n = ch.length;
    for (let i = 0; i < n; i++) {
      this.buf[this.writePos] = ch[i];
      this.writePos = (this.writePos + 1) % FRAME;
      if (this.filled < FRAME) this.filled++;
      this.hopCount++;
      if (this.hopCount >= HOP && this.filled >= FRAME) {
        this.emit();
        this.hopCount = 0;
      }
    }
    return true;
  }

  fft() {
    const real = this.fftReal;
    const imag = this.fftImag;
    const rev = this.rev;
    const n = FRAME;
    // In-place bit reversal.
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (r > i) {
        const tr = real[i]; real[i] = real[r]; real[r] = tr;
        const ti = imag[i]; imag[i] = imag[r]; imag[r] = ti;
      }
    }
    // Iterative Cooley-Tukey radix-2.
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
          const uR = real[a];
          const uI = imag[a];
          const vR = real[b] * wR - imag[b] * wI;
          const vI = real[b] * wI + imag[b] * wR;
          real[a] = uR + vR;
          imag[a] = uI + vI;
          real[b] = uR - vR;
          imag[b] = uI - vI;
          const nwR = wR * wlenR - wI * wlenI;
          wI = wR * wlenI + wI * wlenR;
          wR = nwR;
        }
      }
    }
  }

  emit() {
    // Unroll the ring buffer into `linear` so the analysis reads a
    // contiguous FRAME-length signal in chronological order. `writePos`
    // is the oldest sample once the ring is full.
    const src = this.linear;
    for (let i = 0; i < FRAME; i++) {
      src[i] = this.buf[(this.writePos + i) % FRAME];
    }
    const work = this.work;

    // Raw RMS drives the amplitude meter and the silence gate.
    let sumSq = 0;
    for (let i = 0; i < FRAME; i++) sumSq += src[i] * src[i];
    const rms = Math.sqrt(sumSq / FRAME);

    let hz = -1;
    let sfm = 1;

    if (rms >= RMS_GATE) {
      // DC removal + pre-emphasis, then window.
      let mean = 0;
      for (let i = 0; i < FRAME; i++) mean += src[i];
      mean /= FRAME;
      let prev = this.prev;
      const win = this.window;
      for (let i = 0; i < FRAME; i++) {
        const x = src[i] - mean;
        const y = x - 0.97 * prev;
        prev = x;
        work[i] = y * win[i];
      }
      this.prev = prev;

      // ── FFT gates ──────────────────────────────────────────────────
      this.fftReal.set(work);
      this.fftImag.fill(0);
      this.fft();
      const mag = this.mag;
      for (let i = 0; i < FRAME / 2; i++) {
        const r = this.fftReal[i];
        const im = this.fftImag[i];
        mag[i] = Math.sqrt(r * r + im * im);
      }

      const binHz = sampleRate / FRAME;
      const loBin = Math.max(1, Math.floor(MIN_HZ / binHz));
      const hiBin = Math.min(FRAME / 2 - 2, Math.ceil(MAX_HZ / binHz));
      // Wider band for SFM so we sample the noise floor above the pitch
      // range too — makes broadband hiss unambiguous.
      const sfmHi = Math.min(FRAME / 2 - 1, Math.floor(5000 / binHz));

      let sumLog = 0;
      let sumLin = 0;
      let sfmCount = 0;
      for (let i = loBin; i <= sfmHi; i++) {
        const m = mag[i] + 1e-12;
        sumLog += Math.log(m);
        sumLin += m;
        sfmCount++;
      }
      const geo = Math.exp(sumLog / sfmCount);
      const arith = sumLin / sfmCount;
      sfm = arith > 0 ? geo / arith : 1;

      // Peak-to-median ratio: dominant bin in pitch range vs the median
      // magnitude in the wider band (noise floor estimator).
      let peakMag = 0;
      for (let i = loBin; i <= hiBin; i++) {
        if (mag[i] > peakMag) peakMag = mag[i];
      }
      // Copy the SFM range so we can partial-sort for the median without
      // allocating on each frame's hot path.
      // Small enough (~200 bins) that the cost is negligible.
      const sample = new Float32Array(sfmHi - loBin + 1);
      for (let i = 0; i < sample.length; i++) sample[i] = mag[loBin + i];
      sample.sort();
      const median = sample[Math.floor(sample.length / 2)] + 1e-12;
      const peakRatio = peakMag / median;

      const g = this.gates;
      const tonal = sfm < g.sfm && peakRatio >= g.peakToMedian;

      // ── Autocorrelation for fundamental picking ─────────────────────
      if (tonal) {
        let energy = 0;
        for (let i = 0; i < FRAME; i++) energy += work[i] * work[i];
        if (energy > 0) {
          const sr = sampleRate;
          const minLag = Math.floor(sr / MAX_HZ);
          const maxLag = Math.floor(sr / MIN_HZ);
          let bestLag = -1;
          let bestClarity = 0;
          let prevClarity = -Infinity;
          let rising = false;
          for (let lag = minLag; lag <= maxLag; lag++) {
            let corr = 0;
            for (let i = 0; i < FRAME - lag; i++) corr += work[i] * work[i + lag];
            const clarity = corr / energy;
            if (rising && clarity < prevClarity && prevClarity > bestClarity) {
              bestClarity = prevClarity;
              bestLag = lag - 1;
              if (bestClarity >= g.clarity) break;
            }
            rising = clarity > prevClarity;
            prevClarity = clarity;
          }
          if (bestLag > 0 && bestClarity >= g.clarity) {
            const acAt = (k) => {
              let c = 0;
              for (let i = 0; i < FRAME - k; i++) c += work[i] * work[i + k];
              return c / energy;
            };
            const y1 = acAt(bestLag - 1);
            const y2 = bestClarity;
            const y3 = acAt(bestLag + 1);
            const denom = y1 - 2 * y2 + y3;
            const shift = denom !== 0 ? (0.5 * (y1 - y3)) / denom : 0;
            hz = sr / (bestLag + shift);
          }
        }
      }
    }

    // Build log-frequency spectrogram column.
    const bins = new Float32Array(SPEC_BINS);
    if (rms >= RMS_GATE) {
      const binHz = sampleRate / FRAME;
      for (let bin = 0; bin < SPEC_BINS; bin++) {
        const loLog = SPEC_LOG_MIN + (bin / SPEC_BINS) * (SPEC_LOG_MAX - SPEC_LOG_MIN);
        const hiLog =
          SPEC_LOG_MIN + ((bin + 1) / SPEC_BINS) * (SPEC_LOG_MAX - SPEC_LOG_MIN);
        const loBin = Math.max(1, Math.floor(Math.pow(2, loLog) / binHz));
        const hiBin = Math.min(FRAME / 2 - 1, Math.ceil(Math.pow(2, hiLog) / binHz));
        let peak = 0;
        for (let i = loBin; i <= hiBin; i++) {
          if (this.mag[i] > peak) peak = this.mag[i];
        }
        bins[bin] = peak;
      }
    }
    this.port.postMessage({ rms, hz, sfm, bins }, [bins.buffer]);
  }
}

registerProcessor('pitch-processor', PitchProcessor);
