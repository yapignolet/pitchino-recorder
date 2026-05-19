import { defineConfig } from 'vite';

// base wird vom Pages-Workflow auf /<repo>/ gesetzt, lokal '/'.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
});
