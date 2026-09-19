import { createSignal, For, Show, onCleanup } from 'solid-js';
import {
  TUNINGS,
  notesForOctave,
  playTone,
  startSustainedTone,
  stopSustainedTone,
  type Accidental,
  type Instrument,
} from '../audio/tuning';
import { uiState, setUi } from '../stores/ui';

const TABS: Instrument[] = ['bass', 'cello', 'violin/viola', 'guitar', 'custom'];

// A quartertone is 50 cents (1/24 of an octave). Snap the current freq to
// the nearest quartertone grid point *before* stepping, so four consecutive
// taps advance by exactly 200 cents (a whole tone) and land on the same Hz
// as a whole-tone-away preset button — no floating-point drift.
const QUARTERTONE_CENTS = 50;
function snapToQuartertone(hz: number): number {
  const cents = 1200 * Math.log2(hz / 440);
  const snapped = Math.round(cents / QUARTERTONE_CENTS) * QUARTERTONE_CENTS;
  return 440 * Math.pow(2, snapped / 1200);
}
function stepQuartertone(hz: number, dir: 1 | -1): number {
  const cents = 1200 * Math.log2(hz / 440);
  const stepped =
    Math.round(cents / QUARTERTONE_CENTS) * QUARTERTONE_CENTS +
    dir * QUARTERTONE_CENTS;
  return 440 * Math.pow(2, stepped / 1200);
}

export default function InstrumentTuner() {
  // `playing` is transient (per user request, not persisted in the URL / store).
  const [playing, setPlaying] = createSignal(false);

  const customNotes = () => notesForOctave(uiState.octave, uiState.accidental);

  // Snap every committed frequency to the quartertone grid (50-cent
  // increments from A4). This covers every natural, sharp, and flat in
  // 12-EDO — plus the neutral quartertones between them — and eliminates
  // float drift from repeated stepping. Called from all three entry
  // points: the +/- buttons, the note preset buttons, and the input's
  // change event.
  const setFreq = (hz: number) => {
    const snapped = snapToQuartertone(Math.max(1, hz));
    const rounded = Math.round(snapped * 100) / 100;
    setUi('customHz', rounded);
    if (playing()) startSustainedTone(rounded);
  };

  const togglePlay = () => {
    if (playing()) {
      stopSustainedTone();
      setPlaying(false);
    } else {
      startSustainedTone(uiState.customHz);
      setPlaying(true);
    }
  };

  const selectNote = (hz: number) => {
    const rounded = Math.round(hz * 100) / 100;
    setUi('customHz', rounded);
    if (!playing()) setPlaying(true);
    startSustainedTone(rounded);
  };

  const isNoteSelected = (hz: number) =>
    Math.abs(Math.round(hz * 100) / 100 - uiState.customHz) < 0.005;

  const setTab = (t: Instrument) => {
    if (t !== uiState.activeInstrument && playing()) {
      stopSustainedTone();
      setPlaying(false);
    }
    setUi('activeInstrument', t);
    setUi('instrumentOpen', true);
  };

  const setMode = (m: Accidental) => setUi('accidental', m);

  onCleanup(stopSustainedTone);

  return (
    <div
      class="grid h-full min-h-0 min-w-0 w-full border-t border-neutral-800 overflow-hidden"
      style={{ 'grid-template-rows': `auto ${uiState.instrumentOpen ? 'minmax(0, 1fr)' : '0px'}` }}
    >
      <div class="flex h-9 border-b border-neutral-800 min-w-0 overflow-hidden">
        <For each={TABS}>
          {(tab) => (
            <button
              type="button"
              class={`min-w-0 flex-shrink px-3 text-xs capitalize whitespace-nowrap truncate border-r border-neutral-800 ${
                uiState.activeInstrument === tab && uiState.instrumentOpen
                  ? 'bg-neutral-900 text-sky-300'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
              }`}
              onClick={() => setTab(tab)}
            >
              {tab}
            </button>
          )}
        </For>
        <button
          type="button"
          class="flex-1 min-w-0 flex items-center justify-end pr-3 hover:bg-neutral-900"
          onClick={() => setUi('instrumentOpen', (v) => !v)}
          aria-expanded={String(uiState.instrumentOpen) as 'true' | 'false'}
          aria-label={uiState.instrumentOpen ? 'Collapse instrument tuner' : 'Expand instrument tuner'}
        >
          <span class="w-7 h-7 grid place-items-center text-neutral-400">
            {uiState.instrumentOpen ? '−' : '+'}
          </span>
        </button>
      </div>

      <Show when={uiState.instrumentOpen}>
      <div class="grid min-h-0 min-w-0 p-2 overflow-hidden">
        <Show
          when={uiState.activeInstrument === 'custom'}
          fallback={
            <div class="flex gap-1 justify-center w-full min-w-0">
              <For
                each={TUNINGS[uiState.activeInstrument as Exclude<Instrument, 'custom'>]}
              >
                {(s) => (
                  <button
                    type="button"
                    class="flex-1 min-w-0 max-w-28 bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-sky-500/50 px-2 py-2 text-neutral-100 grid gap-0 leading-tight overflow-hidden"
                    onClick={() => playTone(s.hz)}
                  >
                    <span class="text-xs font-semibold text-sky-300 truncate">
                      {s.label}
                    </span>
                    <span class="text-[9px] text-neutral-500 truncate">
                      {s.hz.toFixed(1)}
                    </span>
                  </button>
                )}
              </For>
            </div>
          }
        >
          <div class="grid gap-1 grid-rows-2 h-full min-w-0">
            <div class="flex gap-1 items-stretch min-w-0">
              <div class="flex border border-neutral-800 shrink-0 min-w-0 h-full">
                <button
                  type="button"
                  class="w-7 shrink-0 grid place-items-center text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 border-r border-neutral-800"
                  onClick={() => setUi('octave', Math.max(0, uiState.octave - 1))}
                  disabled={uiState.octave <= 0}
                  aria-label="Lower octave"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M2 5h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </button>
                <div class="w-6 shrink-0 grid place-items-center text-xs text-sky-300 font-medium tabular-nums">
                  {uiState.octave}
                </div>
                <button
                  type="button"
                  class="w-7 shrink-0 grid place-items-center text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 border-l border-neutral-800"
                  onClick={() => setUi('octave', Math.min(8, uiState.octave + 1))}
                  disabled={uiState.octave >= 8}
                  aria-label="Raise octave"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M2 5h6M5 2v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                </button>
              </div>

              <div class="flex border border-neutral-800 shrink-0">
                <For each={['flat', 'natural', 'sharp'] as const}>
                  {(m) => (
                    <button
                      type="button"
                      class={`w-6 shrink-0 text-xs ${
                        uiState.accidental === m
                          ? 'bg-neutral-800 text-sky-300'
                          : 'text-neutral-400 hover:bg-neutral-800'
                      }`}
                      onClick={() => setMode(m)}
                    >
                      {m === 'flat' ? '♭' : m === 'natural' ? '♮' : '#'}
                    </button>
                  )}
                </For>
              </div>

              <div class="flex-1 flex border border-neutral-800 min-w-0 h-full">
                <button
                  type="button"
                  class="w-7 shrink-0 grid place-items-center text-neutral-300 hover:bg-neutral-800 disabled:opacity-30 border-r border-neutral-800"
                  onClick={() => setFreq(stepQuartertone(uiState.customHz, -1))}
                  disabled={stepQuartertone(uiState.customHz, -1) < 1}
                  aria-label="Down a quartertone"
                >
                  {/* Reverse flat (quartertone down) */}
                  <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden="true">
                    <path
                      d="M8 2.5 V11"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                    />
                    <path
                      d="M8 6.5 C 4 5.6, 3 9.5, 8 9.5"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      fill="none"
                    />
                  </svg>
                </button>
                <input
                  type="number"
                  step="any"
                  min="1"
                  value={uiState.customHz}
                  onChange={(e) => {
                    const v = Number(e.currentTarget.value);
                    if (Number.isFinite(v) && v > 0) setFreq(v);
                    else e.currentTarget.value = String(uiState.customHz);
                  }}
                  class="flex-1 min-w-0 bg-transparent px-2 text-xs text-neutral-100 tabular-nums focus:outline-none focus:bg-neutral-900 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span class="px-2 grid place-items-center text-[10px] text-neutral-500 border-l border-neutral-800">
                  Hz
                </span>
                <button
                  type="button"
                  class="w-7 shrink-0 grid place-items-center text-neutral-300 hover:bg-neutral-800 border-l border-neutral-800"
                  onClick={() => setFreq(stepQuartertone(uiState.customHz, 1))}
                  aria-label="Up a quartertone"
                >
                  {/* Half sharp (quartertone up) */}
                  <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden="true">
                    <path
                      d="M6 2 V12"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                    />
                    <path
                      d="M3 6 L9 5"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                    />
                    <path
                      d="M3 9 L9 8"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                    />
                  </svg>
                </button>
              </div>

              <button
                type="button"
                class={`px-4 py-2 text-xs font-medium border border-neutral-800 ${
                  playing()
                    ? 'bg-rose-500 hover:bg-rose-400 text-neutral-950 border-rose-500'
                    : 'bg-emerald-500 hover:bg-emerald-400 text-neutral-950 border-emerald-500'
                }`}
                onClick={togglePlay}
              >
                {playing() ? 'Pause' : 'Play'}
              </button>
            </div>

            <div class="flex gap-1 min-w-0 overflow-hidden">
              <For each={customNotes()}>
                {(s) => {
                  const isSelected = () => isNoteSelected(s.hz);
                  return (
                    <button
                      type="button"
                      class={`flex-1 min-w-0 max-w-28 overflow-hidden bg-neutral-900 hover:bg-neutral-800 border px-2 py-2 text-neutral-100 grid gap-0 leading-tight ${
                        isSelected()
                          ? 'border-sky-400 bg-neutral-800'
                          : 'border-neutral-800 hover:border-sky-500/50'
                      }`}
                      onClick={() => selectNote(s.hz)}
                    >
                      <span
                        class={`text-xs font-semibold truncate ${
                          isSelected() ? 'text-sky-200' : 'text-sky-300'
                        }`}
                      >
                        {s.label}
                      </span>
                      <span class="text-[9px] text-neutral-500 truncate">
                        {s.hz.toFixed(1)}
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>
      </div>
      </Show>
    </div>
  );
}
