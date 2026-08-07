/**
 * Strip MediaPipe's built-in telemetry beacon at build time.
 *
 * WHY THIS EXISTS
 * `@mediapipe/tasks-vision` unconditionally starts a 60-second timer when a
 * FaceLandmarker or ImageSegmenter is created, and POSTs usage statistics to
 * `https://odml.pa.googleapis.com/v1/log`. There is no opt-out flag. This was
 * verified firing at runtime, not inferred: instrumenting `window.fetch` and
 * idling for 107 seconds after one detection produced two POSTs to that host.
 *
 * The payload is not the photo — it is platform, library version, solution ID
 * and inference latency. But this app's entire promise is that nothing leaves
 * the user's device, and the beacon tells Google, from the user's IP address,
 * that this client just ran face landmarking. For someone whose passport
 * application is sensitive, that is exactly the signal the architecture exists
 * to suppress. Vendoring the models closed the asset-fetch channel and left
 * this one open.
 *
 * HOW
 * The `flush()` method short-circuits when it has nothing queued. Forcing its
 * guard to always take the early-return branch means the queue is never sent
 * and no request is ever constructed. The URL literal is also rewritten so the
 * host cannot appear in the shipped bundle at all, which lets CI grep for it.
 *
 * FAILING LOUDLY
 * If a future version renames these internals the patterns stop matching. A
 * strip that silently does nothing is far worse than no strip, because the
 * privacy claim would still be advertised while the beacon quietly resumed. So
 * a bundle that still contains the telemetry host after transformation FAILS
 * THE BUILD rather than shipping.
 */

const TELEMETRY_HOST = 'odml.pa.googleapis.com'
const TELEMETRY_URL = 'https://odml.pa.googleapis.com/v1/log'

/**
 * `flush(t,e){if(this.error) ...}` — forcing this guard true means the queued
 * events take the early-return branch and the send is never constructed.
 *
 * The pattern must survive two different formattings of the same code: the
 * minified npm bundle (`flush(t,e){if(this.error)`) and Vite's esbuild
 * pre-bundled copy, which pretty-prints it across lines with spaces. Argument
 * names are minified and may change, so they are captured rather than assumed,
 * and every gap is `\s*`.
 */
const FLUSH_GUARD = /flush\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\{\s*if\s*\(\s*this\.error\s*\)/

export function noTelemetry() {
  let patched = false

  return {
    name: 'strip-mediapipe-telemetry',
    enforce: 'pre',

    transform(code, id) {
      if (!id.includes('@mediapipe')) return null
      if (!code.includes(TELEMETRY_HOST)) return null

      if (!FLUSH_GUARD.test(code)) {
        throw new Error(
          `[no-telemetry] Found ${TELEMETRY_HOST} in ${id} but the flush() guard ` +
            'no longer matches, so the beacon could not be disabled. MediaPipe ' +
            'has probably changed its internals. Refusing to build: shipping ' +
            'this would silently break the "nothing leaves your device" promise. ' +
            'Re-derive the pattern in scripts/vite-plugin-no-telemetry.mjs.',
        )
      }

      const next = code
        .replace(FLUSH_GUARD, 'flush($1,$2){if(true)')
        .split(TELEMETRY_URL)
        .join('about:blank#telemetry-disabled')

      if (next.includes(TELEMETRY_HOST)) {
        throw new Error(
          `[no-telemetry] ${id} still references ${TELEMETRY_HOST} after rewriting. ` +
            'Refusing to serve a build that phones home.',
        )
      }

      patched = true
      return { code: next, map: null }
    },

    /**
     * Belt and braces: scan every emitted chunk. This catches the case where
     * the dependency is pre-bundled or inlined by a path that skipped
     * `transform` entirely.
     */
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        const contents = chunk.type === 'chunk' ? chunk.code : String(chunk.source ?? '')
        if (contents.includes(TELEMETRY_HOST)) {
          throw new Error(
            `[no-telemetry] ${fileName} still contains ${TELEMETRY_HOST} after ` +
              'bundling. Refusing to emit a build that phones home.',
          )
        }
      }
      if (!patched) {
        // Not fatal: a build with MediaPipe tree-shaken out is legitimate.
        this.warn('[no-telemetry] MediaPipe telemetry code was not seen in this build.')
      }
    },
  }
}
