export type Instrument = 'bass' | 'cello' | 'violin/viola' | 'guitar' | 'custom';

export type StringNote = { label: string; hz: number };

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

function noteFromLabel(label: string): { midi: number; hz: number } {
  const m = label.match(/^([A-G]#?)(-?\d+)$/);
  if (!m) throw new Error(`bad note label: ${label}`);
  const [, name, oct] = m;
  const idx = NAMES.indexOf(name as (typeof NAMES)[number]);
  if (idx < 0) throw new Error(`bad note name: ${name}`);
  const midi = (Number(oct) + 1) * 12 + idx;
  const hz = 440 * Math.pow(2, (midi - 69) / 12);
  return { midi, hz };
}

function strings(labels: string[]): StringNote[] {
  return labels.map((label) => ({ label, hz: noteFromLabel(label).hz }));
}

export const NATURAL_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
export const SHARP_NAMES = ['C#', 'D#', 'F#', 'G#', 'A#'] as const;
export const FLAT_NAMES = ['D♭', 'E♭', 'G♭', 'A♭', 'B♭'] as const;

export type Accidental = 'natural' | 'sharp' | 'flat';

// Flats normalize to their enharmonic sharp for frequency lookup, but keep
// the flat label for display.
const FLAT_TO_SHARP: Record<string, string> = {
  'D♭': 'C#',
  'E♭': 'D#',
  'G♭': 'F#',
  'A♭': 'G#',
  'B♭': 'A#',
};

export function notesForOctave(octave: number, mode: Accidental): StringNote[] {
  const names =
    mode === 'natural'
      ? NATURAL_NAMES
      : mode === 'sharp'
        ? SHARP_NAMES
        : FLAT_NAMES;
  return names.map((name) => {
    const label = `${name}${octave}`;
    const lookup = `${FLAT_TO_SHARP[name] ?? name}${octave}`;
    return { label, hz: noteFromLabel(lookup).hz };
  });
}

// Standard tunings, low → high. Violin/viola combines viola's C string with
// violin's E string over the shared G/D/A middle.
export const TUNINGS: Record<Exclude<Instrument, 'custom'>, StringNote[]> = {
  bass: strings(['E1', 'A1', 'D2', 'G2']),
  cello: strings(['C2', 'G2', 'D3', 'A3']),
  'violin/viola': strings(['C3', 'G3', 'D4', 'A4', 'E5']),
  guitar: strings(['E2', 'A2', 'D3', 'G3', 'B3', 'E4']),
};

// Single shared context + oscillator for all synthesized tones (sustained
// and one-shots). Ramps prevent clicks; a shared node means new presses
// replace any in-flight tone instead of stacking.
let toneCtx: AudioContext | null = null;
let toneOsc: OscillatorNode | null = null;
let toneGain: GainNode | null = null;
let lowShelf: BiquadFilterNode | null = null;
let highShelf: BiquadFilterNode | null = null;
let masterGain: GainNode | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let masterVolume = 1;
const TONE_BASE = 0.25;
const TONE_ATTACK = 0.03;
const TONE_RELEASE = 0.08;

// Playback shaping is split into three stages so each fixes one problem:
//
//   1. `gainForHz` (this function) — a gentle per-note gain adjustment
//      based on the ear's ISO-226-ish sensitivity curve. Cheap ratio,
//      not the whole compensation.
//   2. Low-shelf filter (+12 dB @ 150 Hz) — compensates for tiny-speaker
//      bass rolloff. Applied in the node graph, not here.
//   3. High-shelf filter (−8 dB @ 2 kHz) — tames pure-sine harshness in
//      the ear's most sensitive band. Also in the node graph.
//
// Result: the gain curve stays modest (base * √(440/hz), ~2.5× low→mid),
// and the biquads carry the rest.
const EXP = 0.5;
const GAIN_FLOOR = 0.06;
const GAIN_CEIL = 0.7;

export function gainForHz(hz: number, base = TONE_BASE): number {
  const ratio = 440 / Math.max(hz, 1);
  const scale = Math.pow(ratio, EXP);
  return Math.min(GAIN_CEIL, Math.max(GAIN_FLOOR, base * scale));
}

export function setMasterVolume(v: number) {
  masterVolume = Math.max(0, Math.min(1, v));
  if (masterGain && toneCtx) {
    const now = toneCtx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setTargetAtTime(masterVolume, now, 0.02);
  }
}

function ensureToneNodes() {
  const AC = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!AC) return null;
  if (!toneCtx) toneCtx = new AC();
  if (!toneOsc || !toneGain || !masterGain || !lowShelf || !highShelf) {
    toneOsc = toneCtx.createOscillator();
    toneGain = toneCtx.createGain();
    // Speaker-compensation shelves — see comment on gainForHz.
    lowShelf = toneCtx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 150;
    lowShelf.gain.value = 12;
    highShelf = toneCtx.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 2000;
    highShelf.gain.value = -8;
    masterGain = toneCtx.createGain();
    toneOsc.type = 'sine';
    toneGain.gain.value = 0.0001;
    masterGain.gain.value = masterVolume;
    toneOsc
      .connect(toneGain)
      .connect(lowShelf)
      .connect(highShelf)
      .connect(masterGain)
      .connect(toneCtx.destination);
    toneOsc.start();
  }
  return { ctx: toneCtx, osc: toneOsc, gain: toneGain };
}

function clearStopTimer() {
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
}

export function startSustainedTone(hz: number) {
  const nodes = ensureToneNodes();
  if (!nodes) return;
  clearStopTimer();
  const { ctx, osc, gain } = nodes;
  const now = ctx.currentTime;
  osc.frequency.cancelScheduledValues(now);
  osc.frequency.setTargetAtTime(hz, now, 0.005);
  const target = gainForHz(hz);
  const current = Math.max(0.0001, gain.gain.value);
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(current, now);
  gain.gain.exponentialRampToValueAtTime(target, now + TONE_ATTACK);
}

export function stopSustainedTone() {
  clearStopTimer();
  if (!toneCtx || !toneGain) return;
  const now = toneCtx.currentTime;
  const current = Math.max(0.0001, toneGain.gain.value);
  toneGain.gain.cancelScheduledValues(now);
  toneGain.gain.setValueAtTime(current, now);
  toneGain.gain.exponentialRampToValueAtTime(0.0001, now + TONE_RELEASE);
}

// One-shot: plays a tone through the shared oscillator for `durationMs` and
// releases. A new call replaces any in-flight tone (no stacking).
export function playTone(hz: number, durationMs = 3500) {
  startSustainedTone(hz);
  stopTimer = setTimeout(stopSustainedTone, durationMs);
}
