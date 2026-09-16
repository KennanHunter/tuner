import { createStore } from 'solid-js';
import type { SmoothingPreset, NoiseRejectionPreset } from '../audio/useTuner';
import type { Accidental, Instrument } from '../audio/tuning';

export type XPreset = 'short' | 'medium' | 'long';
export type YPreset = 'semitone' | 'default' | 'half-octave' | 'octave';

export type UiState = {
  settingsOpen: boolean;
  ampOpen: boolean;
  pitchOpen: boolean;
  spectroOpen: boolean;
  volume: number;
  xPreset: XPreset;
  yPreset: YPreset;
  smoothing: SmoothingPreset;
  noiseRejection: NoiseRejectionPreset;
  activeInstrument: Instrument;
  octave: number;
  accidental: Accidental;
  customHz: number;
};

const DEFAULTS: UiState = {
  settingsOpen: false,
  ampOpen: true,
  pitchOpen: true,
  spectroOpen: false,
  volume: 1,
  xPreset: 'medium',
  yPreset: 'default',
  smoothing: 'medium',
  noiseRejection: 'balanced',
  activeInstrument: 'violin/viola',
  octave: 4,
  accidental: 'natural',
  customHz: 440,
};

const LS_KEY = 'tuner.ui';

const X_PRESETS: readonly XPreset[] = ['short', 'medium', 'long'];
const Y_PRESETS: readonly YPreset[] = ['semitone', 'default', 'half-octave', 'octave'];
const SMOOTHING_PRESETS: readonly SmoothingPreset[] = ['off', 'low', 'medium', 'high'];
const NOISE_PRESETS: readonly NoiseRejectionPreset[] = ['loose', 'balanced', 'strict'];
const INSTRUMENTS: readonly Instrument[] = [
  'bass',
  'cello',
  'violin/viola',
  'guitar',
  'custom',
];
const ACCIDENTALS: readonly Accidental[] = ['natural', 'sharp', 'flat'];

function pickEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function pickBool(v: unknown, fallback: boolean): boolean {
  if (v === '1' || v === 'true' || v === true) return true;
  if (v === '0' || v === 'false' || v === false) return false;
  return fallback;
}

function pickNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function fromRecord(obj: Record<string, unknown> | null): UiState {
  if (!obj) return { ...DEFAULTS };
  return {
    settingsOpen: pickBool(obj.settingsOpen, DEFAULTS.settingsOpen),
    ampOpen: pickBool(obj.ampOpen, DEFAULTS.ampOpen),
    pitchOpen: pickBool(obj.pitchOpen, DEFAULTS.pitchOpen),
    spectroOpen: pickBool(obj.spectroOpen, DEFAULTS.spectroOpen),
    volume: pickNumber(obj.volume, DEFAULTS.volume, 0, 1),
    xPreset: pickEnum(obj.xPreset, X_PRESETS, DEFAULTS.xPreset),
    yPreset: pickEnum(obj.yPreset, Y_PRESETS, DEFAULTS.yPreset),
    smoothing: pickEnum(obj.smoothing, SMOOTHING_PRESETS, DEFAULTS.smoothing),
    noiseRejection: pickEnum(obj.noiseRejection, NOISE_PRESETS, DEFAULTS.noiseRejection),
    activeInstrument: pickEnum(obj.activeInstrument, INSTRUMENTS, DEFAULTS.activeInstrument),
    octave: Math.round(pickNumber(obj.octave, DEFAULTS.octave, 0, 8)),
    accidental: pickEnum(obj.accidental, ACCIDENTALS, DEFAULTS.accidental),
    customHz: pickNumber(obj.customHz, DEFAULTS.customHz, 1, 20000),
  };
}

function toRecord(s: UiState): Record<string, string> {
  return {
    settingsOpen: s.settingsOpen ? '1' : '0',
    ampOpen: s.ampOpen ? '1' : '0',
    pitchOpen: s.pitchOpen ? '1' : '0',
    spectroOpen: s.spectroOpen ? '1' : '0',
    volume: s.volume.toFixed(3),
    xPreset: s.xPreset,
    yPreset: s.yPreset,
    smoothing: s.smoothing,
    noiseRejection: s.noiseRejection,
    activeInstrument: s.activeInstrument,
    octave: String(s.octave),
    accidental: s.accidental,
    customHz: s.customHz.toFixed(2),
  };
}

function readQuery(): Record<string, string> | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if ([...params.keys()].length === 0) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

function readLocal(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function writeLocal(s: UiState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(toRecord(s)));
  } catch {
    /* quota exceeded — ignore */
  }
}

function writeQuery(s: UiState) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(toRecord(s));
  const url = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState(null, '', url);
}

const initialQuery = readQuery();
const initialLocal = readLocal();

export const [uiState, setUiState] = createStore<UiState>(fromRecord(initialQuery));

// Path-style setter for ergonomics — Solid 2 setStore takes a single draft
// callback, so we wrap `setUiState(k, v)` back into shape.
export function setUi<K extends keyof UiState>(key: K, value: UiState[K]): void;
export function setUi<K extends keyof UiState>(key: K, updater: (prev: UiState[K]) => UiState[K]): void;
export function setUi<K extends keyof UiState>(
  key: K,
  valueOrUpdater: UiState[K] | ((prev: UiState[K]) => UiState[K]),
): void {
  setUiState((s) => {
    s[key] =
      typeof valueOrUpdater === 'function'
        ? (valueOrUpdater as (prev: UiState[K]) => UiState[K])(s[key])
        : valueOrUpdater;
  });
}

export function persist() {
  writeQuery(uiState);
  writeLocal(uiState);
}

// The saved state we'd offer to restore. Non-null only when there's a
// localStorage entry AND the URL didn't already carry state.
export const restorableState: UiState | null =
  initialQuery === null && initialLocal !== null ? fromRecord(initialLocal) : null;

export function applyState(s: UiState) {
  setUiState((prev) => Object.assign(prev, s));
}
