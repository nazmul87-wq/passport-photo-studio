/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { VitePWA } from 'vite-plugin-pwa'
// @ts-expect-error -- plain JS plugin, no types needed for a build-time shim.
import { noTelemetry } from './scripts/vite-plugin-no-telemetry.mjs'

// `base` is '/' for local dev and previews. The GitHub Pages workflow sets
// VITE_BASE to '/<repo-name>/' so asset URLs resolve under the project subpath.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  // noTelemetry must run in dev as well as build: the beacon fires from `npm
  // run dev` too, and a developer testing the privacy claim locally should see
  // the same behaviour users get.
  plugins: [
    noTelemetry(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Passport Photo Studio',
        short_name: 'Photo Studio',
        description:
          'Make a compliant passport or visa photo sheet in your browser. Your photo never leaves your device.',
        theme_color: '#1b1f2a',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // The MediaPipe WASM runtime is ~11 MB and the face model ~3.6 MB, well
        // over Workbox's 2 MB default. Without raising this they are silently
        // dropped from the precache and the app "works offline" right up until
        // the user loads a photo, which is the worst possible time to discover
        // it. 40 MB covers the full model set with room to spare.
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,wasm,task,tflite}'],
        // Everything is same-origin and versioned by the build; there are no
        // runtime caching rules because there are no runtime network requests.
        navigateFallback: 'index.html',
      },
      devOptions: {
        // Keep the service worker out of dev. A stale SW caching module graphs
        // makes HMR behave in ways that waste hours to diagnose.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
