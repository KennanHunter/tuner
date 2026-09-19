import { Title } from '@solidjs/meta';
import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js';
import AmplitudeGraph from '../components/AmplitudeGraph';
import PitchGraph from '../components/PitchGraph';
import SpectrogramGraph from '../components/SpectrogramGraph';
import InstrumentTuner from '../components/InstrumentTuner';
import { createTuner } from '../audio/useTuner';
import { setMasterVolume } from '../audio/tuning';
import {
  uiState,
  setUi,
  persist,
  restorableState,
  applyState,
  type XPreset,
  type YPreset,
} from '../stores/ui';
import type { SmoothingPreset, NoiseRejectionPreset } from '../audio/useTuner';

type MicStatus = 'loading' | 'unsupported' | 'denied' | 'empty' | 'ready';

// Worklet emits ~23 frames/s (2048 samples @ 48kHz). Preset → sample count.
const X_PRESETS: Record<XPreset, { samples: number; label: string }> = {
  short: { samples: 230, label: '10s' },
  medium: { samples: 460, label: '20s' },
  long: { samples: 1035, label: '45s' },
};

// Half-window height for the pitch panel, in semitones.
const Y_PRESETS: Record<YPreset, { semitones: number; label: string }> = {
  semitone: { semitones: 1, label: '±1' },
  default: { semitones: 3, label: '±3' },
  'half-octave': { semitones: 6, label: '½ oct' },
  octave: { semitones: 12, label: '1 oct' },
};

export default function Home() {
  const [mics, setMics] = createSignal<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = createSignal<string>('');
  const [micStatus, setMicStatus] = createSignal<MicStatus>('loading');
  const [error, setError] = createSignal<string>('');
  const [showRestore, setShowRestore] = createSignal(restorableState !== null);
  const [micOpen, setMicOpen] = createSignal(false);

  const selectedLabel = () => {
    const d = mics().find((m) => m.deviceId === selected());
    return d?.label || (d ? `Microphone (${d.deviceId.slice(0, 6)})` : 'Select microphone');
  };

  const closeOnOutside = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest('[data-mic-dropdown]')) setMicOpen(false);
  };
  createEffect(
    () => micOpen(),
    (open) => {
      if (open) document.addEventListener('mousedown', closeOnOutside);
      else document.removeEventListener('mousedown', closeOnOutside);
    },
  );
  onCleanup(() => document.removeEventListener('mousedown', closeOnOutside));

  const tuner = createTuner(selected, (msg) => {
    setError(msg);
    tuner.stop();
  });

  // Persist any store change to URL + localStorage, and drive downstream
  // side effects.
  createEffect(
    () => ({ ...uiState }),
    (snap) => persist(snap),
  );
  createEffect(
    () => uiState.volume,
    (v) => setMasterVolume(v),
  );
  createEffect(
    () => uiState.smoothing,
    (s) => tuner.setSmoothing(s),
  );
  createEffect(
    () => uiState.noiseRejection,
    (n) => tuner.setNoiseRejection(n),
  );

  const visibleCount = () => X_PRESETS[uiState.xPreset].samples;
  const semitonesVisible = () => Y_PRESETS[uiState.yPreset].semitones;

  (async () => {
    if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
      setMicStatus('unsupported');
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (err) {
      const name = (err as DOMException)?.name;
      setMicStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'empty');
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    if (inputs.length === 0) {
      setMicStatus('empty');
      return;
    }
    setMics(inputs);
    setSelected(inputs[0].deviceId);
    setMicStatus('ready');
  })();

  const micMessage = () => {
    switch (micStatus()) {
      case 'loading':
        return 'Requesting microphone…';
      case 'unsupported':
        return 'Browser does not support microphone access.';
      case 'denied':
        return 'Microphone permission denied.';
      case 'empty':
        return 'No microphones detected.';
      default:
        return '';
    }
  };

  const toggle = async () => {
    setError('');
    if (tuner.running()) tuner.stop();
    else await tuner.start();
  };

  const restore = () => {
    if (restorableState) applyState(restorableState);
    setShowRestore(false);
  };

  return (
    <main class="h-screen w-screen bg-neutral-950 text-neutral-200 overflow-hidden text-sm flex flex-col">
      <Title>Kennan's Tuner</Title>

      {/* Restore modal — click-away to dismiss. */}
      <Show when={showRestore()}>
        <div
          class="fixed inset-0 z-50 bg-black/70 grid place-items-center"
          onClick={() => setShowRestore(false)}
        >
          <div
            class="bg-neutral-950 border border-neutral-800 p-5 max-w-sm w-[calc(100%-2rem)] grid gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="text-sm font-medium text-neutral-100">Restore previous session?</h2>
            <p class="text-xs text-neutral-400 leading-relaxed">
              We found saved settings from a previous visit. Click Restore to load them, or
              click outside to keep the current defaults.
            </p>
            <div class="flex flex-col gap-2 pt-2">
              <button
                type="button"
                class="w-full py-4 text-base font-medium bg-emerald-500 hover:bg-emerald-400 text-neutral-950"
                onClick={restore}
              >
                Restore
              </button>
              <button
                type="button"
                class="w-full py-4 text-base text-neutral-300 border border-neutral-800 hover:bg-neutral-900"
                onClick={() => setShowRestore(false)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Header */}
      <header class="flex items-center justify-between px-3 h-11 border-b border-neutral-800 bg-neutral-950 shrink-0">
        <h1 class="text-sm font-medium tracking-tight flex items-center gap-2">
          <img src="/half-sharp.svg" alt="" width="16" height="16" />
          Kennan's Tuner
        </h1>
        <div class="flex items-center h-full">
          <a
            href="https://github.com/kennanhunter/tuner"
            target="_blank"
            rel="noreferrer noopener"
            class="h-full px-4 grid place-items-center text-xs text-neutral-300 hover:bg-neutral-900 border-l border-neutral-800"
          >
            GitHub
          </a>
          <a
            href="https://kennan.dev"
            target="_blank"
            rel="noreferrer noopener"
            class="h-full px-4 grid place-items-center text-xs font-medium bg-emerald-500 hover:bg-emerald-400 text-neutral-950"
          >
            Hire
          </a>
        </div>
      </header>

      {/* Mic bar */}
      <div class="grid grid-cols-[auto_1fr] items-stretch h-11 border-b border-neutral-800 shrink-0">
        <button
          type="button"
          class={`px-5 text-xs font-medium border-r border-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed ${
            tuner.running()
              ? 'bg-rose-500 hover:bg-rose-400 text-neutral-950'
              : 'bg-emerald-500 hover:bg-emerald-400 text-neutral-950'
          }`}
          onClick={toggle}
          disabled={micStatus() !== 'ready'}
        >
          {tuner.running() ? 'Stop' : 'Listen'}
        </button>
        <Show
          when={micStatus() === 'ready'}
          fallback={
            <div
              class={`px-3 flex items-center text-xs ${
                micStatus() === 'loading' ? 'text-neutral-400' : 'text-amber-400'
              }`}
            >
              {micMessage()}
            </div>
          }
        >
          <div class="relative w-full h-full" data-mic-dropdown>
            <button
              type="button"
              class="w-full h-full bg-neutral-950 pl-3 pr-10 text-xs text-left text-neutral-200 hover:bg-neutral-900 focus:outline-none focus:bg-neutral-900 flex items-center truncate"
              onClick={() => setMicOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={String(micOpen()) as 'true' | 'false'}
            >
              <span class="truncate">{selectedLabel()}</span>
            </button>
            <span
              class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 grid place-items-center text-neutral-400"
              aria-hidden="true"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class={`motion-safe:transition-transform ${micOpen() ? 'rotate-180' : ''}`}>
                <path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <Show when={micOpen()}>
              <ul
                role="listbox"
                class="absolute left-0 right-0 top-full z-30 bg-neutral-950 border border-neutral-800 shadow-xl shadow-black/60 max-h-72 overflow-y-auto py-1"
              >
                <For each={mics()}>
                  {(d) => {
                    const isActive = () => d.deviceId === selected();
                    const label = d.label || `Microphone (${d.deviceId.slice(0, 6)})`;
                    return (
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected={String(isActive()) as 'true' | 'false'}
                          class={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-neutral-800 ${
                            isActive()
                              ? 'bg-neutral-900 text-sky-300 hover:text-sky-200'
                              : 'text-neutral-300 hover:text-neutral-100'
                          }`}
                          onClick={() => {
                            setSelected(d.deviceId);
                            setMicOpen(false);
                          }}
                        >
                          <span
                            class={`w-1.5 h-1.5 rounded-full shrink-0 ${
                              isActive() ? 'bg-sky-400' : 'bg-neutral-700'
                            }`}
                            aria-hidden="true"
                          />
                          <span class="truncate">{label}</span>
                        </button>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={error()}>
        <div class="px-3 py-1 text-xs text-amber-400 bg-amber-950/30 border-b border-amber-900/40 shrink-0">
          {error()}
        </div>
      </Show>

      {/* Scrollable body */}
      <div
        class="flex-1 min-h-0 overflow-y-auto grid relative bg-black"
        style={{
          'grid-template-rows': `auto ${uiState.ampOpen ? 'minmax(0, 1fr)' : 'auto'} ${uiState.pitchOpen ? 'minmax(0, 2fr)' : 'auto'} ${uiState.spectroOpen ? 'minmax(0, 1fr)' : 'auto'} ${!uiState.ampOpen && !uiState.pitchOpen && !uiState.spectroOpen ? 'minmax(0, 1fr)' : '0px'}`,
        }}
      >
        {/* Settings */}
        <section class="border-b border-neutral-800">
          <button
            type="button"
            class="sticky top-0 z-10 w-full flex items-center justify-between h-9 px-3 bg-black border-b border-neutral-800 hover:bg-neutral-900 text-left"
            onClick={() => setUi('settingsOpen', (v) => !v)}
            aria-expanded={String(uiState.settingsOpen) as "true" | "false"}
          >
            <span class="text-sm uppercase tracking-wide text-neutral-300 font-medium">
              Settings
            </span>
            <span class="w-7 h-7 grid place-items-center text-neutral-400">
              {uiState.settingsOpen ? '−' : '+'}
            </span>
          </button>
          <Show when={uiState.settingsOpen}>
            <div class="grid gap-3 p-3 text-xs">
              <label class="grid grid-cols-[80px_1fr_40px] items-center gap-3">
                <span class="text-neutral-400">Volume</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={uiState.volume}
                  onInput={(e) => setUi('volume', Number(e.currentTarget.value))}
                  class="w-full"
                />
                <span class="text-right text-neutral-500">
                  {Math.round(uiState.volume * 100)}%
                </span>
              </label>

              <div class="grid grid-cols-[80px_1fr] items-center gap-3">
                <span class="text-neutral-400">Window</span>
                <div class="flex border border-neutral-800">
                  <For each={Object.entries(X_PRESETS) as [XPreset, { label: string }][]}>
                    {([key, { label }]) => (
                      <button
                        type="button"
                        class={`flex-1 px-3 py-1.5 text-xs border-r border-neutral-800 last:border-r-0 ${
                          uiState.xPreset === key
                            ? 'bg-neutral-800 text-sky-300'
                            : 'text-neutral-400 hover:bg-neutral-900'
                        }`}
                        onClick={() => setUi('xPreset', key)}
                      >
                        {label}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <div class="grid grid-cols-[80px_1fr] items-center gap-3">
                <span class="text-neutral-400">Y axis</span>
                <div class="flex border border-neutral-800">
                  <For each={Object.entries(Y_PRESETS) as [YPreset, { label: string }][]}>
                    {([key, { label }]) => (
                      <button
                        type="button"
                        class={`flex-1 px-3 py-1.5 text-xs border-r border-neutral-800 last:border-r-0 ${
                          uiState.yPreset === key
                            ? 'bg-neutral-800 text-sky-300'
                            : 'text-neutral-400 hover:bg-neutral-900'
                        }`}
                        onClick={() => setUi('yPreset', key)}
                      >
                        {label}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <div class="grid grid-cols-[80px_1fr] items-center gap-3">
                <span class="text-neutral-400">Smoothing</span>
                <div class="flex border border-neutral-800">
                  <For each={['off', 'low', 'medium', 'high'] as const}>
                    {(key: SmoothingPreset) => (
                      <button
                        type="button"
                        class={`flex-1 px-3 py-1.5 text-xs capitalize border-r border-neutral-800 last:border-r-0 ${
                          uiState.smoothing === key
                            ? 'bg-neutral-800 text-sky-300'
                            : 'text-neutral-400 hover:bg-neutral-900'
                        }`}
                        onClick={() => setUi('smoothing', key)}
                      >
                        {key}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <div class="grid grid-cols-[80px_1fr] items-center gap-3">
                <span class="text-neutral-400">Noise reject</span>
                <div class="flex border border-neutral-800">
                  <For each={['loose', 'balanced', 'strict'] as const}>
                    {(key: NoiseRejectionPreset) => (
                      <button
                        type="button"
                        class={`flex-1 px-3 py-1.5 text-xs capitalize border-r border-neutral-800 last:border-r-0 ${
                          uiState.noiseRejection === key
                            ? 'bg-neutral-800 text-sky-300'
                            : 'text-neutral-400 hover:bg-neutral-900'
                        }`}
                        onClick={() => setUi('noiseRejection', key)}
                      >
                        {key}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </Show>
        </section>

        {/* Amplitude */}
        <section
          class="border-b border-neutral-800 grid min-h-0"
          style={{ 'grid-template-rows': `auto ${uiState.ampOpen ? 'minmax(0, 1fr)' : '0px'}` }}
        >
          <button
            type="button"
            class="sticky top-9 z-10 w-full flex items-center justify-between h-9 px-3 bg-black border-b border-neutral-800 hover:bg-neutral-900 text-left"
            onClick={() => setUi('ampOpen', (v) => !v)}
            aria-expanded={String(uiState.ampOpen) as "true" | "false"}
          >
            <span class="text-sm uppercase tracking-wide text-neutral-300 font-medium">
              Amplitude
            </span>
            <span class="w-7 h-7 grid place-items-center text-neutral-400">
              {uiState.ampOpen ? '−' : '+'}
            </span>
          </button>
          <Show when={uiState.ampOpen}>
            <div class="min-h-0">
              <AmplitudeGraph buffers={tuner.buffers} visibleCount={visibleCount} />
            </div>
          </Show>
        </section>

        {/* Pitch */}
        <section
          class="border-b border-neutral-800 grid min-h-0"
          style={{ 'grid-template-rows': `auto ${uiState.pitchOpen ? 'minmax(0, 1fr)' : '0px'}` }}
        >
          <button
            type="button"
            class="sticky top-18 z-10 w-full flex items-center justify-between h-9 px-3 bg-black border-b border-neutral-800 hover:bg-neutral-900 text-left"
            onClick={() => setUi('pitchOpen', (v) => !v)}
            aria-expanded={String(uiState.pitchOpen) as "true" | "false"}
          >
            <span class="text-sm uppercase tracking-wide text-neutral-300 font-medium">
              Pitch
            </span>
            <span class="w-7 h-7 grid place-items-center text-neutral-400">
              {uiState.pitchOpen ? '−' : '+'}
            </span>
          </button>
          <Show when={uiState.pitchOpen}>
            <div class="min-h-0">
              <PitchGraph
                buffers={tuner.buffers}
                visibleCount={visibleCount}
                semitonesVisible={semitonesVisible}
                running={tuner.running}
              />
            </div>
          </Show>
        </section>

        {/* Spectrogram — default collapsed */}
        <section
          class="border-b border-neutral-800 grid min-h-0"
          style={{ 'grid-template-rows': `auto ${uiState.spectroOpen ? 'minmax(0, 1fr)' : '0px'}` }}
        >
          <button
            type="button"
            class="sticky top-27 z-10 w-full flex items-center justify-between h-9 px-3 bg-black border-b border-neutral-800 hover:bg-neutral-900 text-left"
            onClick={() => setUi('spectroOpen', (v) => !v)}
            aria-expanded={String(uiState.spectroOpen) as 'true' | 'false'}
          >
            <span class="text-sm uppercase tracking-wide text-neutral-300 font-medium">
              Spectrogram
            </span>
            <span class="w-7 h-7 grid place-items-center text-neutral-400">
              {uiState.spectroOpen ? '−' : '+'}
            </span>
          </button>
          <Show when={uiState.spectroOpen}>
            <div class="min-h-0">
              <SpectrogramGraph buffers={tuner.buffers} visibleCount={visibleCount} />
            </div>
          </Show>
        </section>

        {/* Empty-state filler shown only when all graphs are collapsed. */}
        <Show when={!uiState.ampOpen && !uiState.pitchOpen && !uiState.spectroOpen}>
          <div class="grid place-items-center text-neutral-600 select-none">
            <div class="text-center px-6 grid gap-4 justify-items-center">
              <div class="text-sm text-neutral-400">Thank you for using!</div>
              <a
                href="https://ko-fi.com/kennan"
                target="_blank"
                rel="noreferrer noopener"
                class="px-5 py-3 text-sm font-medium bg-emerald-500 hover:bg-emerald-400 text-neutral-950"
              >
                Donate
              </a>
            </div>
          </div>
        </Show>
      </div>

      <section class="shrink-0">
        <InstrumentTuner />
      </section>
    </main>
  );
}
