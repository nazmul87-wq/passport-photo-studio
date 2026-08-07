# Passport Photo Studio

Make a compliant passport or visa photo sheet in your browser. Print six to eight
regulation photos on one 4×6 print for about a dollar, instead of paying a shop.

**Your photo never leaves your device.** No uploads, no analytics, no cookies, no
network requests after the page loads. See [Verifying the privacy claim](#verifying-the-privacy-claim)
— it is checkable, not just asserted.

## What it does

- Detects the face and places the three landmarks automatically; you nudge if needed
- Derives the crop from official head-height and eye-height rules for ~30 countries
- Tells you *why* a photo fails, and fixes what can be fixed mechanically
- Corrects a colour-cast background, the most common avoidable failure
- Exports a print-ready sheet **stamped with its real physical resolution**

### Why the DPI stamp matters

A canvas exports pixel dimensions but says nothing about how large those pixels are
meant to be. Print dialogs then fall back to "fit to paper" and silently rescale the
sheet — and a 2×2 in photo printed at 1.9 in fails every check at the passport office.
Exports here carry a PNG `pHYs` chunk / JPEG JFIF density declaring 300 DPI, so the
print lands at true size.

**Print at 100% scale.** If your print dialog offers "fit to page", turn it off.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # unit tests
npm run typecheck
npm run build    # static output in dist/
```

## How the crop is derived

Everything comes from three landmarks — **crown** (top of hair), **chin**, **eyes**
(pupil midpoint) — plus two physical constraints from the spec: head height
(chin→crown) and eye height (pupil line above the bottom edge).

Those two constraints fix the scale and vertical position; the crown→chin axis fixes
the rotation. The result is one affine transform from source-image space to
output-photo space:

```
d      = |chin − crown|                       # head length in source pixels
scale  = (headHeight × dpi) / d
anchor = (outWidth / 2, outHeight − eyeHeight × dpi)
out    = anchor + R(θ) · scale · (p − eyes)
```

`src/core/geometry.ts` is the whole of it, and is the most heavily tested file in the
project — including a randomised round-trip proving `outToImg(imgToOut(p)) == p`.

## Architecture

```
src/core/      pure TypeScript, no React, no DOM — unit tested as arithmetic
  geometry.ts    landmarks → affine transform, crop bounds, headroom solving
  specs.ts       PhotoSpec types + helpers
  specs.data.ts  the country registry (data only)
  validate.ts    spec + crop → findings, each with an optional mechanical fix
  render.ts      photo rasterisation and sheet packing
  enhance.ts     tone curve, saturation, auto white balance
  encode.ts      PNG pHYs / JPEG JFIF density stamping
  pipeline.ts    the single definition of "the finished photo"
src/components/  UI
src/state/       editor reducer with gesture-aware undo/redo
```

Domain logic is deliberately free of React so the hard parts are testable without a
DOM and portable if the UI is ever rewritten.

## About the country data

Every entry in `src/core/specs.data.ts` carries a `sourceUrl` pointing at the issuing
authority and a `lastVerified` date, and **both are shown in the app**.

Official requirements change. This tool is not affiliated with any government and
cannot guarantee acceptance — always confirm against the official page before you
submit. Where a country's numbers follow the ICAO Doc 9303 convention rather than a
country-specific published rule, the entry says so in its notes.

Found a stale or wrong spec? Open an issue with a link to the authority's page.

## A note on background cleanup

**Shoot against a plain wall. Do not edit the background if you can avoid it.**

This tool can replace the background, and it works — on a real test photo it took
a busy office wall from a failing compliance check to a passing one in a single
toggle. It is still the second-best option, for three reasons:

1. **Some authorities prohibit digitally altered photographs outright**, the US
   State Department among them. A photo that passes every measurement in this app
   can still be rejected at the counter for having been edited. No amount of
   image processing fixes that, because it is a rule about provenance, not pixels.
2. **The matte is never quite invisible.** Segmentation is good at torsos and
   poor at fine hair. Look closely at a cleaned photo and you will usually find a
   soft halo where the edge feathered out, or a few strands eaten away. A person
   examining it at arm's length may well notice.
3. **A plain wall costs nothing.** A bedsheet, a door, a blank stretch of wall in
   even indirect daylight. Two minutes of effort removes the entire problem
   class, and the result is a photograph rather than a composite.

So background cleanup is **off by default**, sits behind an explicit toggle, and
carries the same warning in the app itself. Use it when retaking the photo is
genuinely not an option — not as a shortcut past finding a better wall.

The same logic applies to the adjustment sliders: they change colour and
brightness only. Never use anything that reshapes or retouches facial features.
Every authority rejects an altered face.

## Verifying the privacy claim

1. Open DevTools → Network, hard-reload, then use the whole app
2. After the initial page and model load, there are **zero** cross-origin requests.
   Leave the tab open for a few minutes and check again — see the note below for
   why that wait matters
3. Go offline in DevTools and reload — it still works

Face detection and segmentation run on models served from this app's own origin,
never a CDN, so the claim holds literally rather than approximately.

Two mechanisms enforce this rather than merely asserting it:

- **`connect-src 'self'`** in the CSP (`index.html`). The browser refuses any
  cross-origin request from this page, whatever the code attempts.
- **A build-time strip** of MediaPipe's telemetry beacon
  (`scripts/vite-plugin-no-telemetry.mjs`), which **fails the build** if it can
  no longer find the code it is meant to disable. A strip that silently stopped
  working would be worse than none, because the promise would still be on the
  page.

### Why the beacon strip exists

`@mediapipe/tasks-vision` starts a 60-second timer when a FaceLandmarker or
ImageSegmenter is created and POSTs usage statistics to
`odml.pa.googleapis.com`. There is no opt-out flag. This was measured, not
assumed: instrumenting `window.fetch` and idling 107 seconds after one detection
produced two POSTs to that host. After the strip, the same test over two full
intervals produces none.

The payload was never the photo — platform, library version, solution ID,
inference latency. But it told Google, from the user's IP address, that this
client had just run face landmarking. Vendoring the models closed the
asset-fetch channel and left that one open, which is precisely the leak this
architecture exists to prevent.

CI additionally greps `dist/` for the telemetry host, because this class of
regression is invisible to a code review of `src/`.

## Offline

The production build registers a service worker that precaches everything,
including the ~27 MB MediaPipe runtime and model weights. Once you have loaded
the app one time, it works with no network at all — and you can install it from
your browser's address bar to run it as a standalone app.

This was verified by killing the server outright rather than by trusting the
config: with nothing listening on the port, the app reloaded from cache, both
model files served (3.7 MB and 11.7 MB), and a real MediaPipe FaceLandmarker
initialised in 79 ms.

Worth knowing if you touch the PWA config: Workbox silently refuses to precache
files over 2 MB by default. Leaving that default would produce an app that
appears to work offline right up until you load a photo and face detection
cannot find its model — the worst possible moment to discover it.
`maximumFileSizeToCacheInBytes` in `vite.config.ts` is what prevents that.

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. The workflow sets `VITE_BASE` to the repository name
because a project site is served from `/<repo>/`.

The build output is plain static files, so any static host works.

## Licence

MIT
