# Audio Pipeline

Two independent chains: **capture → analysis** (microphone in) and
**synthesis → playback** (reference tones out). They share no nodes — a
sustained tone from the custom panel is not fed into the analyser.

---

## 1. Capture / Analysis (mic in → pitch on screen)

### 1.1 Browser input

`navigator.mediaDevices.getUserMedia({ audio: { deviceId, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })`
→ `AudioContext.createMediaStreamSource(stream)` →
`AudioWorkletNode('pitch-processor')`.

All browser DSP (AEC, noise suppression, AGC) is disabled — otherwise the
system would try to "clean" the signal in ways that hurt pitch detection
(pumping, comb filtering, spectral gating).

### 1.2 Worklet frame loop (`src/audio/pitch-processor.js`)

Runs on the audio thread. Fills a 2048-sample ring buffer, then emits
once per full frame (~23 frames/sec at 48 kHz sample rate).

Per frame:

1. **Raw RMS** on the untouched frame — drives the amplitude meter and the
   `RMS_GATE = 0.01` silence gate.
2. **DC removal**: subtract mean.
3. **Pre-emphasis high-pass** `y[n] = x[n] − 0.97·x[n−1]` — knocks down
   sub-bass rumble that would otherwise dominate autocorrelation.
4. **Hann window** — reduces spectral leakage.
5. **2048-point radix-2 iterative FFT** (in-place, precomputed bit-reversal
   table and windowed twiddle math). Magnitudes in `mag[0..1023]`.
6. **Spectral Flatness Measure** over bins 60–5000 Hz:
   `SFM = geo_mean(mag) / arith_mean(mag)`. Pure tone → SFM ≈ 0; broadband
   noise → SFM ≈ 1.
7. **Peak-to-median ratio**: strongest bin in the 60–1200 Hz pitch range
   divided by the median magnitude in the 60–5000 Hz range (noise floor
   estimate).
8. **Tonal gate**: `SFM < gates.sfm AND peak/median ≥ gates.peakToMedian`.
   Thresholds live in `this.gates`, updated by `port.postMessage({ type:
   'gates', ... })` from `useTuner.setNoiseRejection()`.
   - `loose`: 0.5, 3, clarity 0.5
   - `balanced`: 0.35, 6, clarity 0.6 (default)
   - `strict`: 0.2, 10, clarity 0.75
9. If tonal, **normalized autocorrelation** across lags corresponding to
   60–1200 Hz. Uses the pre-emphasized/windowed frame divided by zero-lag
   energy so clarity ∈ ~[−1, 1]. **First-significant-peak picking** walks
   lags low → high and takes the first local max above threshold — this
   prevents octave-down errors when the 2nd harmonic is louder than the
   fundamental.
10. **Parabolic interpolation** on the three autocorrelation samples around
    the winning lag → sub-sample-accurate `Hz`.
11. `port.postMessage({ rms, hz, sfm })` to main.

### 1.3 Main-thread smoothing (`src/audio/useTuner.ts`)

The stream from the worklet is smoothed before hitting the ring buffer:

1. **Median filter** (window `medianN` = 1/3/7/15 per Smoothing preset) —
   kills single-frame outliers and residual octave flips.
2. **EMA in log2-Hz** with alpha `emaAlpha` (1.0/0.5/0.2/0.08 per preset).
3. **Jump-snap**: if `|median − ema| > 3 semitones`, replace EMA with the
   median (don't glide over an attack).
4. **Silence hold**: up to 4 empty frames hold the last EMA value before
   the trace drops.
5. Store `smoothed` in `pitches[headRef.value]`; store raw `rms` in
   `amps[headRef.value]`; advance head.

Ring buffer size `HISTORY = 1200` covers ~52 s. Graphs read a windowed slice
(230/460/1035 samples per X-axis preset — 10/20/45 s).

### 1.4 Rendering

- `AmplitudeGraph` — per-frame `rAF`, scans buffer for `currentMax`,
  smooths that into `peak` (attack 0.15, release 0.003, `MIN_PEAK = 0.15`),
  draws bars at `min(1, amps[i] / peak)`.
- `PitchGraph` — computes a rolling log-Hz center from the last 12 valid
  pitches, y-scale is ±semitonesVisible (1/3/6/12 per Y preset), draws
  every note label in the visible band and highlights the center MIDI
  note. Overlay chip near the newest datapoint shows note + Hz.

### 1.5 What the input pipeline does *well*

- Aggressive noise rejection via FFT gates keeps hiss/fans out.
- Autocorrelation with first-peak picking is robust against
  harmonic-heavy instrument tones (guitar, violin) where FFT-peak-picking
  alone would report the wrong octave.
- Median + EMA smoothing produces a clean trace without much lag.
- All heavy math is on the audio thread — main thread only sees ~23
  messages/sec.

### 1.6 What can be improved

Sorted by cost-vs-payoff.

1. **Cents-stability lock-in** (cheap; ~130 ms extra latency). Require the
   smoothed pitch to stay within ±30 cents for 3 consecutive frames before
   *displaying*. Kills flicker from partial hits and transient overtones.
2. **Peak-to-runner-up autocorrelation ratio** (cheap). Track second-best
   peak; require best ≥ 1.5× second best. Ambiguous frames (chord smear,
   voice) fail even when they pass raw clarity.
3. **Adaptive noise floor**. Currently `RMS_GATE` is a constant `0.01`.
   Track an EMA of RMS during no-pitch frames and gate at ~3× that floor
   instead. Handles a range of rooms without user tweaking.
4. **Harmonic Product Spectrum** (medium). Multiply spectrum × downsampled
   copies ÷2/÷3/÷4. Cross-check the winning autocorrelation lag against
   the HPS peak — if they disagree by an octave, take the one with more
   support. Best octave-stability we can get short of switching algorithms.
5. **YIN / MPM** (bigger rewrite). Replace autocorrelation with the
   cumulative-mean-normalized difference function. Designed specifically
   for noise robustness. Would supersede several of the tweaks above.
6. **Overlap between analysis frames** (medium). Currently 0% overlap —
   analysis is spaced 2048 samples apart. A 50% hop would double the
   effective time resolution and let smoothing be tightened without
   lengthening the visible-lag.
7. **Longer frames at low pitch**. At 60 Hz one period is ~800 samples, so
   2048 fits ~2.5 periods — not much to correlate against. Switching to a
   4096-point FFT below ~200 Hz would help low-string tuning
   substantially. Costs CPU and adds latency, so may be preset-gated.
8. **Adaptive bandpass around the previous pitch**. Once a note locks,
   BiquadFilter with narrow bandwidth around that Hz on the input, then
   analyse the filtered signal. Rejects overlapping tones, at the cost of
   slower lock-on to new notes.

---

## 2. Synthesis / Playback (Play button / note buttons → speakers)

### 2.1 Node graph

A single, shared graph is created lazily on first use and reused for the
lifetime of the page.

```
OscillatorNode (sine, .start() called once)
   ↓
GainNode toneGain      ← envelope (ADSR-ish)
   ↓
GainNode masterGain    ← volume slider (setMasterVolume)
   ↓
AudioDestinationNode
```

`playTone` (one-shots on string tabs) and `startSustainedTone` (custom
tab) both drive the same nodes. `playTone(hz, ms)` calls
`startSustainedTone(hz)` and schedules `stopSustainedTone` via
`setTimeout` — so a new press cancels the previous timer and retunes in
place. Nothing ever stacks.

### 2.2 Envelope

- **Attack** 30 ms — `exponentialRampToValueAtTime(target, now + 0.03)`.
- **Frequency slew** 5 ms via `setTargetAtTime` — mid-play retunes glide,
  no zipper noise.
- **Release** 80 ms sustained, 400 ms one-shot — `exponentialRampToValue
  AtTime(0.0001, ...)`. Exponential ramps prevent clicks.

### 2.3 Frequency-aware gain (`gainForHz`)

**Current implementation** — a naive inverse-frequency curve:

```
target = base * (440 / hz)^1.0,  clamped [0.03, 0.9]
base   = 0.18
```

Rough values:

| Note | Hz | Digital gain |
|------|----|--------------|
| E1   | 41 | 0.90 (clamped) |
| A2   | 110 | 0.72 |
| A3   | 220 | 0.36 |
| A4   | 440 | 0.18 |
| A5   | 880 | 0.09 |
| A6   | 1760 | 0.045 |
| C8   | ~4200 | 0.03 (floor) |

### 2.4 Why the current playback amplitude is bad

The current curve is a **naive frequency-ratio compensation**. It's
attacking three separate problems with a single knob, and doing all of
them incorrectly:

1. **Human ear sensitivity is non-linear** and does not follow a simple
   `1/f`. The ISO 226 equal-loudness contour at 60 phons shows we need
   ~+30 dB SPL at 60 Hz vs 1 kHz — that's ~32× energy, way beyond what
   `(440/60)^1 ≈ 7×` can supply. So low notes still sound quiet even at
   the ceiling gain.
2. **Laptop / phone speakers roll off hard below ~200 Hz.** Even if we
   send a full-scale sine at 41 Hz, the driver physically can't move
   enough air. No amount of digital gain helps — you need EQ on the
   playback chain (a low-shelf boost / bandpass) or the small speaker
   just won't produce it.
3. **Sinusoids in the 2–5 kHz band are perceptually piercing** — that's
   the ear's most sensitive region. Cutting to `0.045` at A6 still feels
   uncomfortably bright because a pure sine has no harmonics to spread
   the energy. The ear locks onto the fundamental.

Result: low notes are inaudible ("did anything play?") and high notes
still shrill through the cut. The single-curve approach can't fix all
three because they're different problems.

### 2.5 What playback should actually do

Sorted by cost-vs-payoff.

1. **Insert a fixed EQ chain in front of `masterGain`** — one
   `BiquadFilter` lowshelf at ~150 Hz +12 dB and one highshelf at ~2 kHz
   −8 dB. This directly compensates speaker rolloff (bass) and pure-sine
   harshness (treble) and doesn't fight the gain stage. Web Audio's
   `BiquadFilterNode` is free CPU-wise. Biggest single quality bump.
2. **Approximate ISO 226 for the gain curve** instead of `1/f`. A cheap
   fit is a piecewise function: below 100 Hz boost extra hard (linear in
   log-Hz, ~+18 dB from 200→60 Hz); 100–1000 Hz mostly flat; above 2 kHz
   attenuate. Combined with the shelf EQ, this gives perceptually flat
   output across the range.
3. **Use a compound waveform, not a pure sine** — a sine plus a small
   third-harmonic (10–15% at 3× hz) sounds warmer and less piercing for
   high notes, more present for low notes on tiny speakers. Two
   `OscillatorNode`s summed via a mixer gain. Still tuning-accurate
   because the fundamental dominates.
4. **DynamicsCompressor after `masterGain`** with a modest ratio (2:1,
   threshold −12 dBFS) to keep peaks bounded. Optional, useful mostly
   if the user has boosted volume high.
5. **Output-device profile presets** — "Laptop speakers", "Headphones",
   "External speakers". Each swaps the shelf EQ values and the gain
   curve steepness. Lets the user tell us what output they're on so we
   compensate correctly.
6. **A-weighted gain metering** — expose an actual RMS meter of the
   post-EQ signal so the user can see how loud their reference tone
   is, similar to the input amplitude panel.

### 2.6 Recommended concrete change

Small, self-contained, biggest win: **insert two BiquadFilters between
`toneGain` and `masterGain`** with fixed shelf EQ, and drop the
frequency-aware `gain` exponent from 1.0 back to ~0.5 (since the shelf
is doing the heavy lifting). About 20 lines of code and it fixes both
the "can't hear the bass" and "highs are piercing" complaints without
any user-facing preset changes.
