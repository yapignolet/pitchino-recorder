/**
 * Reine, DOM-freie Rhythmus-Logik: Pattern-Definitionen, Hysterese-basierte
 * Ton-Segment-Erkennung (Einsatz + gehaltene Tonlänge) und dauer-bewusste
 * Bewertung. Wird von der App (src/ui/rhythm.ts) und vom Test-Harness genutzt,
 * damit Tests exakt die Logik prüfen, die im Spiel läuft.
 */

export const BPM = 60;
export const BEAT_SEC = 60 / BPM; // 1.0 s pro Viertel
export const TOLERANCE_SEC = 0.45; // ±450 ms = großzügig für Kinder
export const ON_RMS_GATE = 0.018; // Ton-an-Schwelle
export const OFF_RMS_GATE = 0.01; // Ton-aus-Schwelle (Hysterese gegen Flackern)
export const MIN_HOLD_RATIO = 0.5; // Note muss ≥ 50 % ihrer Notenlänge gehalten werden
export const MAX_HOLD_EXTRA = 0.6; // … und höchstens so viel länger als vorgesehen
export const TAKT_PASS_RATIO = 0.75; // ≥ 75 % korrekte Einsätze → 1 Stern für den Takt
export const ONSET_POLL_MS = 30; // feste Mess-Taktung der Mic-Schleife

export interface Beat {
  /** Dauer in Vierteln (1=Viertel, 0.5=Achtel, 2=Halbe, 4=Ganze) */
  beats: number;
  /** VexFlow duration: 'q','8','h','w' */
  vex: string;
}
export type Pattern = { name: string; notes: Beat[] };

export const PATTERNS: Pattern[] = [
  { name: 'Viertelnoten', notes: [{ beats: 1, vex: 'q' }, { beats: 1, vex: 'q' }, { beats: 1, vex: 'q' }, { beats: 1, vex: 'q' }] },
  { name: 'Halbe + Vierteln', notes: [{ beats: 2, vex: 'h' }, { beats: 1, vex: 'q' }, { beats: 1, vex: 'q' }] },
  { name: 'Vierteln + Halbe', notes: [{ beats: 1, vex: 'q' }, { beats: 1, vex: 'q' }, { beats: 2, vex: 'h' }] },
  { name: '2 Halbe', notes: [{ beats: 2, vex: 'h' }, { beats: 2, vex: 'h' }] },
  { name: 'Ganze Note', notes: [{ beats: 4, vex: 'w' }] },
  { name: 'Achtel + Vierteln', notes: [{ beats: .5, vex: '8' }, { beats: .5, vex: '8' }, { beats: 1, vex: 'q' }, { beats: 1, vex: 'q' }, { beats: 1, vex: 'q' }] },
  { name: 'Vierteln + Achtel', notes: [{ beats: 1, vex: 'q' }, { beats: .5, vex: '8' }, { beats: .5, vex: '8' }, { beats: 1, vex: 'q' }, { beats: 1, vex: 'q' }] },
  { name: 'Viele Achtel', notes: [{ beats: .5, vex: '8' }, { beats: .5, vex: '8' }, { beats: .5, vex: '8' }, { beats: .5, vex: '8' }, { beats: 1, vex: 'q' }, { beats: 1, vex: 'q' }] },
];

/** Erwartete Einsatz-Zeitpunkte (Sekunden ab Pattern-Start). */
export function computeOnsets(pat: Pattern): number[] {
  let t = 0;
  return pat.notes.map((b) => {
    const s = t;
    t += b.beats * BEAT_SEC;
    return s;
  });
}

/** Gesamtdauer eines Patterns inkl. letzter Note + Toleranz (Sekunden). */
export function patternDurationSec(pat: Pattern): number {
  const onsets = computeOnsets(pat);
  const last = pat.notes[pat.notes.length - 1];
  return onsets[onsets.length - 1] + last.beats * BEAT_SEC + TOLERANCE_SEC;
}

/** RMS eines Frames. */
export function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

/** Ein erkanntes Ton-Segment: Einsatz und Ende in Sekunden ab Start. */
export interface Segment {
  start: number;
  end: number;
}

/**
 * Inkrementeller Hysterese-Detektor – identische Logik wie die Mic-Loop in der
 * App: Ton-an bei lautem Signal (> ON_RMS_GATE), Ton-aus erst wenn deutlich
 * leiser (< OFF_RMS_GATE). Erfasst sowohl Einsatz als auch gehaltene Länge.
 */
export function createSegmentDetector() {
  let soundOn = false;
  let segStart = 0;
  const segments: Segment[] = [];
  return {
    /** Ein Frame: gemessener RMS und zugehöriger Zeitstempel t (Sekunden). */
    push(frameRms: number, t: number): void {
      if (!soundOn && frameRms > ON_RMS_GATE) {
        soundOn = true;
        segStart = t;
      } else if (soundOn && frameRms < OFF_RMS_GATE) {
        soundOn = false;
        segments.push({ start: segStart, end: t });
      }
    },
    /** Am Ende einen noch klingenden Ton schließen. */
    finalize(t: number): Segment[] {
      if (soundOn) {
        soundOn = false;
        segments.push({ start: segStart, end: t });
      }
      return segments;
    },
    getSegments(): Segment[] {
      return segments;
    },
  };
}

/**
 * Offline-Variante: läuft den Hysterese-Detektor im POLL_MS-Takt über ein
 * komplettes Signal und liefert die erkannten Ton-Segmente.
 */
export function detectSegments(
  samples: Float32Array,
  sampleRate: number,
  pollMs = ONSET_POLL_MS,
): Segment[] {
  const det = createSegmentDetector();
  const step = Math.max(1, Math.round((sampleRate * pollMs) / 1000));
  let i = 0;
  for (; i + step <= samples.length; i += step) {
    det.push(rms(samples.subarray(i, i + step)), i / sampleRate);
  }
  return det.finalize(i / sampleRate);
}

export interface RhythmScore {
  /** Pro erwarteter Note: Einsatz im Fenster UND passend lang gehalten. */
  results: boolean[];
  /** Anteil korrekt gespielter Noten (0..1). */
  ratio: number;
  /** Vergebene Sterne (0 oder 1 – ein Stern pro sauber gespieltem Takt). */
  stars: number;
}

/** Ein Stern pro Takt, wenn genug Noten sauber gespielt wurden. */
export function starForRatio(ratio: number): number {
  return ratio >= TAKT_PASS_RATIO ? 1 : 0;
}

/**
 * Ordnet Ton-Segmente den erwarteten Noten zu – identisch zur evaluate()-
 * Funktion der App: jedes Segment zählt nur einmal; eine Note gilt als richtig,
 * wenn der Einsatz im Toleranzfenster liegt UND lang genug (nicht zu lang)
 * gehalten wurde.
 */
export function scoreRhythm(
  pattern: Pattern,
  expectedOnsets: number[],
  segments: Segment[],
  tolerance = TOLERANCE_SEC,
): RhythmScore {
  const used = new Set<number>();
  const results = expectedOnsets.map((exp, i) => {
    let bestIdx = -1;
    let bestDiff = Infinity;
    segments.forEach((s, si) => {
      if (!used.has(si) && Math.abs(s.start - exp) < bestDiff) {
        bestDiff = Math.abs(s.start - exp);
        bestIdx = si;
      }
    });
    if (bestIdx < 0 || bestDiff > tolerance) return false;
    used.add(bestIdx);
    const seg = segments[bestIdx];
    const heldDur = seg.end - seg.start;
    const wantDur = pattern.notes[i].beats * BEAT_SEC;
    const longEnough = heldDur >= wantDur * MIN_HOLD_RATIO;
    const notTooLong = heldDur <= wantDur + MAX_HOLD_EXTRA;
    return longEnough && notTooLong;
  });
  const total = results.length;
  const ratio = total === 0 ? 0 : results.filter(Boolean).length / total;
  return { results, ratio, stars: starForRatio(ratio) };
}
