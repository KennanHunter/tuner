// Standard 12-TET notes keyed by frequency (Hz), labeled with scientific
// pitch notation. Generated once at module load from MIDI numbers using
// A4 = 440 Hz.

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function midiToLabel(m: number): string {
  const name = NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

// MIDI 12 (C0, ~16.35 Hz) through MIDI 120 (C9, ~8372 Hz) — a superset that
// covers anything we might want to plot.
export const NOTES: ReadonlyMap<number, string> = (() => {
  const m = new Map<number, string>();
  for (let midi = 12; midi <= 120; midi++) {
    m.set(midiToHz(midi), midiToLabel(midi));
  }
  return m;
})();

export type NoteEntry = { hz: number; label: string };

export function notesInRange(minHz: number, maxHz: number): NoteEntry[] {
  const out: NoteEntry[] = [];
  for (const [hz, label] of NOTES) {
    if (hz >= minHz && hz <= maxHz) out.push({ hz, label });
  }
  out.sort((a, b) => a.hz - b.hz);
  return out;
}
