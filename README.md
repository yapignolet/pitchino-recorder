# pitchino-recorder

Öffentliches Cello-Aufnahme-Tool für den Test-Korpus der (privaten) Pitchino-App.
Pierre öffnet die GitHub-Pages-URL auf dem iPhone, spielt die vorgegebenen Töne
bzw. Rhythmen ein und exportiert am Ende **ein ZIP** mit allen Takes.

Bewusst getrennt vom Hauptrepo: nur das Tooling ist öffentlich, die Kinder-App
bleibt privat / nur auf dem Internet Computer.

## Quelle / Drift

Diese Dateien sind aus dem Hauptrepo gespiegelt und dort die Ground Truth, gegen
die der Test-Korpus ausgewertet wird:

- `src/music/notes.ts` – die 22 Töne + deutsche Namen
- `src/audio/rhythmScore.ts` – Patterns + Timing
- `src/tools/recorder.ts`, `index.html` – das Tool selbst

Nach Änderungen an diesen Dateien im Hauptrepo hier neu syncen:

```sh
./sync.sh /pfad/zum/pitchino   # Default: ../pitchino
git add -A && git commit -m "sync" && git push
```

Push auf `main` baut die Pages-Seite automatisch neu.

## Lokal

```sh
npm ci && npm run dev   # http://localhost:5173/
```
