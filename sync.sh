#!/usr/bin/env bash
# Spiegelt die Recorder-Dateien aus dem (privaten) pitchino-Hauptrepo hierher.
# Diese Dateien sind die Ground Truth, gegen die der Test-Korpus aufgenommen
# wird – nach Änderungen an notes.ts / rhythmScore.ts hier neu syncen.
#
# Nutzung:  ./sync.sh /pfad/zum/pitchino   (Default: ../pitchino)
set -euo pipefail
SRC="${1:-../pitchino}"

for f in src/music/notes.ts src/audio/rhythmScore.ts src/tools/recorder.ts; do
  cp "$SRC/$f" "$f"
  echo "synced $f"
done
cp "$SRC/recorder.html" index.html
echo "synced recorder.html -> index.html"
echo "Fertig. Prüfen, committen, pushen → Pages baut automatisch neu."
