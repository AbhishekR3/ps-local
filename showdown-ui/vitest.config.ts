import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Renderer unit tests run under jsdom (UpdateScreen.tsx is React + window.psUI). This reuses the same
// @vitejs/plugin-react the app build uses so JSX/TSX resolve identically. Scope to *.test.ts(x) under
// src/ and electron/ so the suite never picks up the helper's node:test files at the repo root.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'electron/**/*.test.ts'],
    globals: true,
  },
})
