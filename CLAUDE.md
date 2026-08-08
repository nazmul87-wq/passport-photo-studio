# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # http://localhost:5173  (predev vendors models first)
npm run build        # tsc -b && vite build   (prebuild vendors models first)
npm run preview      # serve dist/ — the ONLY way to exercise the service worker
npm test             # vitest run
npm run test:watch
npm run typecheck    # tsc -b --noEmit
npm run lint         # oxlint
npm run vendor:models   # re-fetch MediaPipe wasm + weights into public/models/
```

Single file: `npx vitest run src/core/geometry.test.ts`
Single test: `npx vitest run -t "round-trips exactly"`

The `validate.fixes.test.ts` sweep takes ~10s and carries explicit 60s timeouts — it runs thousands of scenarios through the full validator. Don't "optimise" it by shrinking the sweep; it exists because two real bugs were invisible to single-example tests.

## What this app is

A static, client-side tool that turns a portrait into a print-ready sheet of compliant passport photos. Its entire value proposition is a privacy promise, and several design decisions only make sense in that light.

## Architecture

`src/core/` is framework-free TypeScript — no React, no DOM except where a canvas is unavoidable. All the hard logic lives there and is tested as pure arithmetic. React only renders it. Preserve that boundary.

The data flow: three landmarks (crown / chin / eyes) + two physical constraints from the spec (head height, eye height) → one affine transform → everything else.

**`geometry.ts`** is the file the whole app's correctness rests on. It owns the transform, its exact inverse, and — importantly — the *only* constrained search over `(headHeight, eyeHeight)`.

**`specs.ts` / `specs.data.ts`** are split so the registry is pure data. `specs.data.ts` imports only *types* from `specs.ts`, which are erased at compile time, so the apparent cycle doesn't exist at runtime. Don't turn that into a value import.

**`pipeline.ts`** is the single definition of "the finished photo". Preview, background sampling and export all call `renderFinalPhoto`. If you add a rendering path, route it through here — a preview that disagrees with the export is only discovered after someone pays to print.

## Invariants that were bugs before they were rules

Each of these was a real defect found in review. Re-introducing them is a regression.

**One solver, not three.** Every compliance fix action goes through `searchPlacement` / `solveFor` in `geometry.ts`. There were previously three independent searches over the same grid with different objectives; the result was a fix that failed to resolve its own finding 90% of the time, and two fixes that undid each other in a loop. `solveFor`'s fallback preserves every constraint that currently passes, which makes the ping-pong impossible by construction. If no candidate qualifies, offer **no fix** — a button that makes the photo worse is worse than no button.

**One definition of "in range".** `measureHeadroom` is shared by the solver and the compliance panel, and compares the *rounded, displayed* value. When they used separate comparisons they disagreed at boundaries, which surfaced as a fix appearing to break a passing check.

**Never trust a model's self-reported confidence.** The selfie segmenter returns `quality: 1.0` on images it doesn't understand, with a mask containing no subject — which composited to a blank white photo, silently. `isPlausiblePersonMask` measures what the mask actually contains. Both `detectFace` and the background compositing path must apply it.

**`requestAnimationFrame` does not fire in a hidden tab.** `nextFrame()` in `detect.ts` races rAF against a timeout. Without that, detection hangs forever the moment a user switches tabs while waiting — which is exactly what people do.

**Sheet packing maximises copy count first.** A US 2×2 tiles a 4×6 *exactly*; honouring even a 1mm margin ahead of the count drops the sheet from six photos to two. Requested gutters are taken from leftover slack only.

**Cut marks mark both edges of every cell.** Marking only the leading edge leaves the gutter attached, producing photos ~1mm too wide — which is what a template gauge at a passport office measures.

**Exports must carry DPI metadata.** `encode.ts` patches the PNG `pHYs` chunk / JPEG JFIF density. Canvas `toBlob` declares nothing, so print dialogs "fit to page" and silently rescale the sheet. This is the single most common real-world rejection cause.

**A bitmap's DPI stamp is advisory; a PDF page size is not.** `pdf.ts` wraps the sheet in a one-page PDF whose `/MediaBox` is its true physical size in points, which is why PDF is the default sheet format — Chrome's print preview and most lab kiosks ignore `pHYs` and scale to the paper anyway. The JPEG is embedded as a `/DCTDecode` XObject, meaning the bytes are stored **verbatim**: that module compresses and decodes nothing, so export quality is decided solely by the `canvasToBlob` quality argument in `App.tsx`. It writes no Info dictionary — a creation date in a file headed for a print shop is metadata this app has no reason to author. The payload has to be JPEG because PDF cannot carry PNG bytes directly (`FlateDecode` wants raw zlib over unfiltered samples; canvas emits colour-type-6 RGBA), so the PNG export stays for anyone wanting lossless.

## The privacy promise is enforced, not asserted

The UI tells users "nothing leaves your device". Two mechanisms back that up, and both must keep working:

1. **`connect-src 'self'`** in the CSP meta tag in `index.html`. Every directive there is load-bearing (`wasm-unsafe-eval` for Emscripten, `blob:` for camera and object URLs, `'unsafe-inline'` for the pre-paint theme script). Test before trimming.
2. **`scripts/vite-plugin-no-telemetry.mjs`** strips MediaPipe's built-in beacon at build time. `@mediapipe/tasks-vision` POSTs to `odml.pa.googleapis.com` every 60 seconds with no opt-out — this was measured firing, not assumed. The plugin **fails the build** if its patterns stop matching, because a silently broken strip would leave the promise on the page while the beacon resumed. CI also greps `dist/`.

Model weights and WASM are served same-origin from `public/models/` (gitignored, ~27MB, generated by `vendor-models.mjs` and verified by SHA-256 — not by byte length, which accepts any same-size payload). `resolveModelUrl` refuses absolute URLs in both the filename and the base path.

## UI constraints

**Never put glass, tint, blur or any overlay over the photo preview or the alignment stage image.** The app exists to judge whether a photo's colour and background are compliant, and the compliance panel samples background pixels from that same render. A translucent overlay would have both the user and the validator judging a colour the exported file doesn't have. Glass *frames* are fine.

**The digital-alteration warning in `BackgroundPanel.tsx` must stay loud.** It is exempt from the frosted treatment by design. Several authorities prohibit altered photos outright; softening it into a tasteful hint would lead someone to submit a rejected application.

`backdrop-filter` makes an element a containing block for `position: fixed` — it once silently un-pinned the mobile export bar. Blur is gated to `lg` partly for that reason.

Landmark placement has a numeric spinbutton alternative (`LandmarkFields.tsx`) because screen-reader users cannot drag a canvas. Keep it two-way.

## Spec data honesty

`src/core/specs.data.ts` feeds real government applications. Every entry requires a `sourceUrl` pointing at the issuing authority and a `lastVerified` date, both surfaced in the UI.

Do not invent measurements. Where an authority publishes no head or eye geometry, the entry follows the ICAO Doc 9303 convention and **says so in its `notes`**. Only the US publishes a pupil-line position; every other `eye` range is derived and disclosed as such. `headroom` appears only on specs whose authority actually publishes a crown margin (currently Japan and Russia) — an invented one is enforced as a hard FAIL, so it would reject photos the country accepts.

Tests must not be the reason a spec claims a rule. If a test needs a spec with a headroom band, point it at one that genuinely has one.

## Deployment

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on push to `main`. `VITE_BASE` is set to `/<repo>/` because a project site is served from a subpath. Workflow permissions are per-job: the build job holds only `contents: read`, since it runs `npm ci` and a network-fetching prebuild.

`vite.config.ts` raises Workbox's `maximumFileSizeToCacheInBytes` — the 2MB default silently drops the models from the precache, producing an app that appears to work offline right up until someone loads a photo.

---

Note: you have OpenAI Codex and Gemini CLI configs in your home directory. If you'd like to bring any of that across (MCP servers, slash commands, subagents, skills, instructions), reply `/import` to see what's importable, then `/import --yes=<digest>` to apply it.
