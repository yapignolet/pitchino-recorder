import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// Kompakte Build-Version (Git-SHA + Datum) – wird im Recorder angezeigt,
// damit Tester und wir vom selben Build sprechen.
function buildVersion(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    const date = new Date().toISOString().slice(0, 10);
    return `${sha} (${date})`;
  } catch {
    return 'dev';
  }
}

// base wird vom Pages-Workflow auf /<repo>/ gesetzt, lokal '/'.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion()),
  },
});
