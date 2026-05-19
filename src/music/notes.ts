/** Eine spielbare Note auf dem Cello. */
export interface Note {
  /** Interne ID, englische Konvention inkl. Oktavzahl, z.B. "C2", "F#2", "Bb3". */
  id: string;
  /** Soll-Frequenz in Hz. */
  freq: number;
  /** VexFlow-Key inkl. optionalem Accidental, z.B. "c/2", "f#/2", "bb/3". */
  vex: string;
}

export interface Level {
  name: string;
  notes: Note[];
}

/** Die vier leeren Saiten – Reihenfolge wie auf dem Cello (tief → hoch). */
export const OPEN_STRINGS: { label: string; id: string; freq: number; vex: string }[] = [
  { label: 'A-Saite', id: 'A3', freq: 220.0, vex: 'a/3' },
  { label: 'D-Saite', id: 'D3', freq: 146.83, vex: 'd/3' },
  { label: 'G-Saite', id: 'G2', freq: 98.0, vex: 'g/2' },
  { label: 'C-Saite', id: 'C2', freq: 65.41, vex: 'c/2' },
];

/** Progressive Level: leere Saiten → 1.–3. Finger → Vorzeichen. */
export const LEVELS: Level[] = [
  {
    name: 'Leere Saiten',
    notes: [
      { id: 'C2', freq: 65.41, vex: 'c/2' },
      { id: 'G2', freq: 98.0, vex: 'g/2' },
      { id: 'D3', freq: 146.83, vex: 'd/3' },
      { id: 'A3', freq: 220.0, vex: 'a/3' },
    ],
  },
  {
    name: 'Neue Töne',
    notes: [
      { id: 'D2', freq: 73.42, vex: 'd/2' },
      { id: 'A2', freq: 110.0, vex: 'a/2' },
      { id: 'E3', freq: 164.81, vex: 'e/3' },
      { id: 'B3', freq: 246.94, vex: 'b/3' },
    ],
  },
  {
    name: 'Mehr Töne',
    notes: [
      { id: 'E2', freq: 82.41, vex: 'e/2' },
      { id: 'B2', freq: 123.47, vex: 'b/2' },
      { id: 'F3', freq: 174.61, vex: 'f/3' },
      { id: 'C4', freq: 261.63, vex: 'c/4' },
    ],
  },
  {
    name: 'Alle Töne',
    notes: [
      { id: 'F2', freq: 87.31, vex: 'f/2' },
      { id: 'C3', freq: 130.81, vex: 'c/3' },
      { id: 'G3', freq: 196.0, vex: 'g/3' },
      { id: 'D4', freq: 293.66, vex: 'd/4' },
    ],
  },
  {
    // Fortgeschritten: typische Halbtöne der 1. Lage mit Versetzungszeichen.
    name: 'Vorzeichen 🎯',
    notes: [
      { id: 'F#2', freq: 92.5, vex: 'f#/2' }, // Fis2 – C-Saite, 4. Finger / D-Saite-Nachbar
      { id: 'Eb3', freq: 155.56, vex: 'eb/3' }, // Es3 – D-Saite, 1. Finger tief
      { id: 'F#3', freq: 185.0, vex: 'f#/3' }, // Fis3 – D-Saite, 3. Finger
      { id: 'C#3', freq: 138.59, vex: 'c#/3' }, // Cis3 – G-Saite, 3. Finger
      { id: 'Bb3', freq: 233.08, vex: 'bb/3' }, // B3 (B♭) – A-Saite, 1. Finger tief
      { id: 'C#4', freq: 277.18, vex: 'c#/4' }, // Cis4 – A-Saite, 3. Finger
    ],
  },
];

/** Index des Vorzeichen-Levels (letztes Level). */
export const ACCIDENTALS_LEVEL_INDEX = LEVELS.length - 1;

export const ALL_NOTES: Note[] = LEVELS.flatMap((l) => l.notes);

const STEP_DE: Record<string, string> = {
  A: 'A',
  B: 'H', // englisch B = deutsch H
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  G: 'G',
};

// Deutsche Endungen für Vorzeichen: Kreuz = "is", b = "es"/"s".
const FLAT_DE: Record<string, string> = {
  A: 'As',
  B: 'B', // englisch Bb = deutsch B
  C: 'Ces',
  D: 'Des',
  E: 'Es',
  F: 'Fes',
  G: 'Ges',
};

const SHARP_DE: Record<string, string> = {
  A: 'Ais',
  B: 'His',
  C: 'Cis',
  D: 'Dis',
  E: 'Eis',
  F: 'Fis',
  G: 'Gis',
};

/**
 * Wandelt eine interne Noten-ID (z.B. "B3", "F#2", "Bb3") in den deutschen
 * Notennamen mit korrekter Helmholtz-Oktavnotation um:
 *   Oktave 2 → große Oktave: Großbuchstabe  (C, D … H)
 *   Oktave 3 → kleine Oktave: Kleinbuchstabe (c, d … h)
 *   Oktave 4 → eingestrichene Oktave: Kleinbuchstabe + ′  (c′, d′ … h′)
 * (tiefer als Oktave 2 → Kontra-Marke mit Komma, höher analog mit weiteren ′)
 */
export function germanName(id: string): string {
  const m = /^([A-G])(#|b)?(-?\d)/.exec(id);
  if (!m) return id;
  const [, step, acc, octStr] = m;
  const octave = parseInt(octStr);
  let name: string;
  if (acc === '#') name = SHARP_DE[step] ?? (step + 'is');
  else if (acc === 'b') name = FLAT_DE[step] ?? (step + 'es');
  else name = STEP_DE[step] ?? step;

  if (octave <= 2) {
    // Große Oktave (2) und tiefer (Kontra…) → Großbuchstabe, ggf. Komma-Marke.
    return name.toUpperCase().charAt(0) + name.slice(1) + ','.repeat(Math.max(0, 2 - octave));
  }
  // Kleine Oktave (3) → Kleinbuchstabe; eingestrichen (4) und höher → + ′ je Oktave.
  return name.toLowerCase() + "'".repeat(octave - 3);
}

/** Findet das Level, das eine gegebene Note enthält. */
export function levelOf(id: string): Level | undefined {
  return LEVELS.find((l) => l.notes.some((n) => n.id === id));
}
