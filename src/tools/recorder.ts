/**
 * Aufnahme-Tool für den Cello-Test-Korpus. Läuft als eigenständige Static-Page
 * (GitHub Pages) – Pierre öffnet sie auf dem iPhone, bekommt vorgegeben was er
 * spielen soll, nimmt auf und exportiert am Ende ein ZIP mit allen Takes.
 *
 * Wichtig: exakt dieselbe Mic-Verarbeitung wie die App
 * (src/audio/mic.ts + src/audio/pitch.ts), damit der Korpus das abbildet, was
 * die App im Live-Betrieb tatsächlich „sieht“.
 */
import { Vex } from 'vexflow';
import { ALL_NOTES, germanName } from '../music/notes';
import { PATTERNS, patternDurationSec, computeOnsets, BEAT_SEC } from '../audio/rhythmScore';

// Build-Version (Git-SHA + Datum). Wird von Vite via `define` injiziert
// (vite.config.ts) – damit Tester und wir vom selben Build sprechen.
declare const __BUILD_VERSION__: string;

const TARGET_SR = 16000; // gleiches Ziel wie pitch.ts
const LEAD_SILENCE_SEC = 0.7; // bewusst erhalten: Harness misst hier False-Positives
const TRAIL_SILENCE_SEC = 0.3;
const MAX_LEN_SEC = 5;
const TRIM_GATE = 0.01; // RMS-Schwelle für „Signal beginnt/endet hier“

const PITCH_VARIANTS = ['forte_clean', 'piano_clean', 'child_sharp', 'child_flat'] as const;
const RHYTHM_VARIANTS = ['precise', 'early', 'late', 'child'] as const;

type Mode = 'pitch' | 'rhythm';

interface Recording {
  name: string;
  wav: Uint8Array;
}

const app = document.getElementById('app')!;
const recordings: Recording[] = [];

let mode: Mode = 'pitch';
let pitchIdx = 0;
let rhythmIdx = 0;
let variantIdx = 0;
let takeCounts: Record<string, number> = {};

let micStream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let recording = false;
let chunks: Float32Array[] = [];
let proc: ScriptProcessorNode | null = null;

// Frisch aufgenommener Take, der noch angehört und bestätigt/verworfen wird.
let pending: { wav: Uint8Array; key: string; url: string } | null = null;

function sanitize(id: string): string {
  return id.replace(/#/g, 's');
}

function currentKey(): string {
  return mode === 'pitch'
    ? `pitch__${sanitize(ALL_NOTES[pitchIdx].id)}__${PITCH_VARIANTS[variantIdx]}`
    : `rhythm__${rhythmIdx}__${RHYTHM_VARIANTS[variantIdx]}`;
}

// ---- Mic / Aufnahme ----------------------------------------------------------

async function ensureMic(): Promise<boolean> {
  if (micStream && ctx) return true;
  try {
    // Exakt dieselben Constraints wie src/audio/mic.ts – Korpus bildet das ab,
    // was die App im Live-Betrieb sieht. autoGainControl=true: iOS verstärkt
    // leises Cello-Spiel automatisch (wie professionelle Tuner-Apps).
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    return true;
  } catch (e) {
    alert('Mikrofon nicht verfügbar: ' + e);
    return false;
  }
}

// iOS Safari routet Output über den leisen Empfänger-Lautsprecher, solange ein
// aktiver Mic-Stream existiert (Play&Record-Audiosession). Wir geben das
// Mikrofon nach jedem Take frei, damit Playback und Metronom des nächsten Takes
// wieder über die lauten Hauptlautsprecher laufen. Nächste Aufnahme greift
// den Stream einfach neu (kein erneuter Permission-Prompt nach einmaliger
// Freigabe).
function releaseMic() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (ctx) {
    ctx.close().catch(() => {});
    ctx = null;
  }
}

function startRec() {
  if (!ctx || !micStream || recording) return;
  recording = true;
  chunks = [];
  const src = ctx.createMediaStreamSource(micStream);
  proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (ev) => {
    chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  render();
}

function stopRec() {
  if (!recording || !ctx) return;
  recording = false;
  proc?.disconnect();
  proc = null;

  const srcRate = ctx.sampleRate;
  let buf = flatten(chunks);
  // Rhythmus: kein Trim. Die Dauer ist durch den Metronom-Callback bereits
  // exakt begrenzt (4 × BEAT_SEC + Muster + 0,2 s Nachlauf). trimSilence
  // ist hier kontraproduktiv: Countdown-Klicks verschieben den erkannten
  // „first energetic frame", wodurch start in den Vorzähler rutscht und
  // die ersten Cello-Noten weggeschnitten werden; MAX_LEN_SEC kappte früher
  // zusätzlich die letzten Beats. Für Pitch bleibt der Trim erhalten
  // (Harness misst die Anlauf-Stille als False-Positive-Region).
  if (mode !== 'rhythm') {
    buf = trimSilence(buf, srcRate);
  }
  const ds = downsample(buf, srcRate, TARGET_SR);
  const wav = encodeWav16(ds, TARGET_SR);

  // Noch nicht speichern – erst anhören und bestätigen lassen.
  const blob = new Blob([wav as BlobPart], { type: 'audio/wav' });
  pending = { wav, key: currentKey(), url: URL.createObjectURL(blob) };
  // Mic & AudioContext freigeben, damit Playback (und ggf. der nächste
  // Metronom-Vorlauf) wieder über die lauten Lautsprecher laufen.
  releaseMic();
  render();
}

function savePending() {
  if (!pending) return;
  const { wav, key } = pending;
  takeCounts[key] = (takeCounts[key] ?? 0) + 1;
  const take = String(takeCounts[key]).padStart(2, '0');
  recordings.push({ name: `${key}__t${take}.wav`, wav });
  URL.revokeObjectURL(pending.url);
  pending = null;
  render();
}

function discardPending() {
  if (!pending) return;
  URL.revokeObjectURL(pending.url);
  pending = null;
  render();
}

// ---- DSP ---------------------------------------------------------------------

function flatten(parts: Float32Array[]): Float32Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Trimmt überschüssige Stille, lässt aber bewusst ~0.7 s Anlauf-Stille stehen –
 * darüber misst das Test-Harness die False-Positive-Rate.
 *
 * `maxLenSec` cap-t die Gesamtdauer – wichtig: für Rhythmus muss er
 * Vorzähler (4 s) + Pattern (bis 4 s) + Reserve abdecken, sonst werden die
 * letzten Beats abgeschnitten. Für einzelne Töne reicht der Standardwert.
 */
function trimSilence(
  buf: Float32Array,
  sr: number,
  maxLenSec: number = MAX_LEN_SEC,
  trailSec: number = TRAIL_SILENCE_SEC,
): Float32Array {
  const win = Math.floor(sr * 0.02);
  const energetic = (i: number) => {
    let s = 0;
    const end = Math.min(buf.length, i + win);
    for (let j = i; j < end; j++) s += buf[j] * buf[j];
    return Math.sqrt(s / Math.max(1, end - i)) > TRIM_GATE;
  };
  let first = 0;
  while (first < buf.length && !energetic(first)) first += win;
  let last = buf.length - win;
  while (last > first && !energetic(last)) last -= win;

  const start = Math.max(0, first - Math.floor(sr * LEAD_SILENCE_SEC));
  const end = Math.min(buf.length, last + win + Math.floor(sr * trailSec));
  const maxLen = Math.floor(sr * maxLenSec);
  const clipped = buf.subarray(start, Math.min(end, start + maxLen));
  return clipped.length ? new Float32Array(clipped) : buf;
}

/** Mittelwert-Decimator – identisch zur Methode in pitch.ts. */
function downsample(buf: Float32Array, srcRate: number, target: number): Float32Array {
  if (srcRate <= target) return buf;
  const factor = Math.floor(srcRate / target);
  const outLen = Math.floor(buf.length / factor);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let s = 0;
    for (let j = 0; j < factor; j++) s += buf[i * factor + j];
    out[i] = s / factor;
  }
  return out;
}

function encodeWav16(samples: Float32Array, sr: number): Uint8Array {
  const bytes = 44 + samples.length * 2;
  const dv = new DataView(new ArrayBuffer(bytes));
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(dv.buffer);
}

// ---- ZIP (store, ohne Kompression – WAV komprimiert ohnehin kaum) -----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(files: Recording[]): Blob {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.wav);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true); // store
    lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, f.wav.length, true);
    lh.setUint32(22, f.wav.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), nameBytes, f.wav);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, f.wav.length, true);
    ch.setUint32(24, f.wav.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), nameBytes);

    offset += 30 + nameBytes.length + f.wav.length;
  }

  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)] as BlobPart[];
  return new Blob(parts, { type: 'application/zip' });
}

function exportZip() {
  if (!recordings.length) return;
  const blob = buildZip(recordings);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const sha = __BUILD_VERSION__.split(' ')[0]; // "94d3909 (2026-05-20)" → "94d3909"
  a.download = `cello-takes-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}__build-${sha}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- VexFlow -----------------------------------------------------------------

function drawPitch(el: HTMLElement) {
  el.innerHTML = '';
  const { Renderer, Stave, StaveNote, Accidental, Voice, Formatter } = Vex.Flow;
  const W = el.clientWidth || 320;
  const r = new Renderer(el as HTMLDivElement, Renderer.Backends.SVG);
  r.resize(W, 140);
  const c = r.getContext();
  const stave = new Stave(10, 20, W - 20).addClef('bass');
  stave.setContext(c).draw();
  const note = ALL_NOTES[pitchIdx];
  const m = /^([a-g])(#|b)?\/(\d)/.exec(note.vex);
  const sn = new StaveNote({ clef: 'bass', keys: [note.vex], duration: 'w' });
  if (m && m[2]) sn.addModifier(new Accidental(m[2] === '#' ? '#' : 'b'), 0);
  const v = new Voice({ num_beats: 4, beat_value: 4 });
  v.setStrict(false); v.addTickables([sn]);
  new Formatter().joinVoices([v]).format([v], W - 80);
  v.draw(c, stave);
}

function drawRhythm(el: HTMLElement, hiIdx = -1) {
  el.innerHTML = '';
  const { Renderer, Stave, StaveNote, Voice, Formatter, Beam } = Vex.Flow;
  const W = el.clientWidth || 320;
  const r = new Renderer(el as HTMLDivElement, Renderer.Backends.SVG);
  r.resize(W, 120);
  const c = r.getContext();
  const stave = new Stave(10, 10, W - 20);
  stave.addClef('bass').addTimeSignature('4/4');
  stave.setContext(c).draw();
  const pat = PATTERNS[rhythmIdx];
  const sn = pat.notes.map((b, i) => {
    const note = new StaveNote({ clef: 'bass', keys: ['b/3'], duration: b.vex });
    if (i < hiIdx) note.setStyle({ fillStyle: '#34d399', strokeStyle: '#34d399' });
    else if (i === hiIdx) note.setStyle({ fillStyle: '#fde047', strokeStyle: '#fde047' });
    return note;
  });
  const v = new Voice({ num_beats: 4, beat_value: 4 });
  v.setStrict(false); v.addTickables(sn);
  const beams = Beam.generateBeams(sn.filter((n) => n.getDuration() === '8'));
  new Formatter().joinVoices([v]).format([v], W - 100);
  v.draw(c, stave);
  beams.forEach((bm) => bm.setContext(c).draw());
}

// ---- Metronom (60 BPM, gleich wie App) --------------------------------------

function playMetronome(onDone: () => void) {
  if (!ctx) return;
  const beat = BEAT_SEC;
  // Lauter, punchiger Klick: kurzer Rausch-Burst durch ein Bandpass bei freq
  // (perkussiver Anschlag) + Sinus-Schicht für klare Pitch-Erkennung von
  // Downbeat (1100 Hz) vs. Off-Beat (880 Hz). Auf iOS reicht ein leiser
  // Sinus-Klick nicht durch den Lautsprecher, sobald das Mic aktiv ist.
  const click = (t: number, freq: number) => {
    const sr = ctx!.sampleRate;
    const nLen = Math.floor(sr * 0.03);
    const nBuf = ctx!.createBuffer(1, nLen, sr);
    const nData = nBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nData[i] = Math.random() * 2 - 1;
    const ns = ctx!.createBufferSource();
    ns.buffer = nBuf;
    const bp = ctx!.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 4;
    const ng = ctx!.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.9, t + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    ns.connect(bp).connect(ng).connect(ctx!.destination);
    ns.start(t); ns.stop(t + 0.12);

    const o = ctx!.createOscillator();
    const g = ctx!.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    o.connect(g).connect(ctx!.destination);
    o.start(t); o.stop(t + 0.12);
  };
  const t0 = ctx.currentTime + 0.1;
  const msFromNow = (t: number) => Math.max(0, (t - ctx!.currentTime) * 1000);

  // Optische Signale: Countdown-Dots (1–4) und Pattern-Beat-Highlight im
  // Notensystem. Wichtig auf iPad/iPhone, weil das Metronom während der
  // Aufnahme durch das iOS-Routing leiser wird – visuell ist es immer da.
  const flashDot = (idx: number) => {
    const d = document.querySelector(`.cd-${idx}`);
    if (!d) return;
    d.classList.add('on');
    setTimeout(() => d.classList.remove('on'), 200);
  };
  const flashPulse = () => {
    const p = document.getElementById('beat-pulse');
    if (!p) return;
    p.classList.add('on');
    setTimeout(() => p.classList.remove('on'), 180);
  };
  const highlightNote = (idx: number) => {
    const vf = document.getElementById('vf');
    if (vf) drawRhythm(vf, idx);
  };

  // 4 Countdown-Klicks + leuchtende Dots
  for (let i = 0; i < 4; i++) {
    const t = t0 + i * beat;
    click(t, i === 0 ? 1100 : 880);
    setTimeout(() => flashDot(i), msFromNow(t));
  }

  // Pattern-Phase: Metronom-Klicks auf jeder Viertel + Puls; Noten-
  // Hervorhebung an den tatsächlichen Einsätzen des Patterns.
  const pat = PATTERNS[rhythmIdx];
  const onsets = computeOnsets(pat);
  const dur = patternDurationSec(pat);
  const tPatStart = t0 + 4 * beat;
  for (let i = 0; i < Math.ceil(dur / beat); i++) {
    const t = tPatStart + i * beat;
    click(t, 880);
    setTimeout(flashPulse, msFromNow(t));
  }
  onsets.forEach((sec, i) => {
    setTimeout(() => highlightNote(i), msFromNow(tPatStart + sec));
  });
  // Hervorhebung am Ende zurücksetzen.
  setTimeout(() => highlightNote(-1), (4 * beat + dur + 0.05) * 1000);

  setTimeout(onDone, (4 * beat + dur + 0.2) * 1000);
}

// ---- UI ----------------------------------------------------------------------

function render() {
  const variants = mode === 'pitch' ? PITCH_VARIANTS : RHYTHM_VARIANTS;
  if (variantIdx >= variants.length) variantIdx = 0;
  const total = mode === 'pitch' ? ALL_NOTES.length : PATTERNS.length;
  const idx = mode === 'pitch' ? pitchIdx : rhythmIdx;
  const title = mode === 'pitch'
    ? `${germanName(ALL_NOTES[pitchIdx].id)} (${ALL_NOTES[pitchIdx].id})`
    : PATTERNS[rhythmIdx].name;
  const done = takeCounts[currentKey()] ?? 0;

  if (pending) {
    app.innerHTML = `
      <div class="card">
        <div class="idx">${idx + 1} / ${total}</div>
        <div id="vf"></div>
        <div class="title">${title}</div>
        <p class="hint">Aufnahme anhören und entscheiden:</p>
        <audio id="review" src="${pending.url}" controls autoplay
               style="width:100%;margin:6px 0 14px"></audio>
        <div class="nav">
          <button id="discard" style="background:#dc2626">🗑 Verwerfen</button>
          <button id="save" style="background:#16a34a">✅ Speichern</button>
        </div>
        <p class="hint">Verworfene Aufnahmen verbrauchen keine Take-Nummer.</p>
        <div class="ver">Build ${__BUILD_VERSION__}</div>
      </div>`;
    const $p = (id: string) => document.getElementById(id)!;
    (mode === 'pitch' ? drawPitch : drawRhythm)(document.getElementById('vf')!);
    $p('discard').onclick = discardPending;
    $p('save').onclick = savePending;
    return;
  }

  app.innerHTML = `
    <div class="bar">
      <button class="seg ${mode === 'pitch' ? 'on' : ''}" id="m-pitch">🎵 Töne</button>
      <button class="seg ${mode === 'rhythm' ? 'on' : ''}" id="m-rhythm">🥁 Rhythmus</button>
      <span class="spacer"></span>
      <button id="export">⬇︎ ZIP (${recordings.length})</button>
    </div>
    <div class="ver">Build ${__BUILD_VERSION__}</div>
    <div class="card">
      <div class="idx">${idx + 1} / ${total}</div>
      <div id="vf"></div>
      <div class="title">${title}</div>
      <div class="variants">
        ${variants.map((v, i) => `<button class="vr ${i === variantIdx ? 'on' : ''}" data-v="${i}">${v}</button>`).join('')}
      </div>
      <div class="takes">Takes für diese Variante: <b>${done}</b></div>
      ${mode === 'rhythm' && recording ? `
        <div class="cd-row">
          <span class="cd cd-0">1</span>
          <span class="cd cd-1">2</span>
          <span class="cd cd-2">3</span>
          <span class="cd cd-3">4</span>
          <span class="cd-pulse" id="beat-pulse"></span>
        </div>` : ''}
      <button class="rec ${recording ? 'recording' : ''}" id="rec">
        ${recording ? '⏹ Stop' : (mode === 'pitch' ? '● Aufnehmen' : '● Mit Metronom aufnehmen')}
      </button>
      <div class="nav">
        <button id="prev">◀ Zurück</button>
        <button id="next">Weiter ▶</button>
      </div>
      <p class="hint">${mode === 'pitch'
        ? 'Kurz warten (Stille), dann den Ton anspielen und halten.'
        : 'Tippe Aufnehmen: 4 Vorzähler-Klicks, dann das Pattern mitspielen.'}</p>
    </div>`;

  const $ = (id: string) => document.getElementById(id)!;
  drawAndWire($);
}

function drawAndWire($: (id: string) => HTMLElement) {
  (mode === 'pitch' ? drawPitch : drawRhythm)(document.getElementById('vf')!);

  $('m-pitch').onclick = () => { mode = 'pitch'; variantIdx = 0; render(); };
  $('m-rhythm').onclick = () => { mode = 'rhythm'; variantIdx = 0; render(); };
  $('export').onclick = exportZip;

  document.querySelectorAll('.vr').forEach((b) =>
    ((b as HTMLElement).onclick = () => { variantIdx = Number((b as HTMLElement).dataset.v); render(); }));

  $('prev').onclick = () => { step(-1); };
  $('next').onclick = () => { step(1); };

  $('rec').onclick = async () => {
    if (!(await ensureMic())) return;
    if (ctx?.state === 'suspended') await ctx.resume();
    if (recording) { stopRec(); return; }
    if (mode === 'rhythm') {
      startRec();
      playMetronome(() => { if (recording) stopRec(); });
    } else {
      startRec();
    }
  };
}

function step(d: number) {
  if (mode === 'pitch') pitchIdx = (pitchIdx + d + ALL_NOTES.length) % ALL_NOTES.length;
  else rhythmIdx = (rhythmIdx + d + PATTERNS.length) % PATTERNS.length;
  render();
}

render();
