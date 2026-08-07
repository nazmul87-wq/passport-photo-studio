#!/usr/bin/env node
/**
 * Vendor the MediaPipe runtime into `public/models/`.
 *
 * The app's promise is that nothing leaves the user's device. That promise is
 * broken the moment the page fetches a model from a CDN at runtime: the request
 * itself leaks the fact that a passport photo is being edited, from an IP
 * address, to a third party. So every byte the vision tasks need is served from
 * our own origin.
 *
 * This script runs at BUILD time, on the developer's machine or in CI, where a
 * network fetch is unremarkable. It does two things:
 *
 *   1. Copies the WebAssembly runtime out of node_modules/@mediapipe/tasks-vision.
 *      These ship inside the npm package, so this is a plain file copy.
 *
 *   2. Downloads the .tflite/.task model weights, which are NOT in the npm
 *      package and have no npm distribution at all. Google publishes them on
 *      storage.googleapis.com; the exact URLs are listed in MODELS below, each
 *      pinned to an immutable version directory (`/1/`) rather than `/latest/`
 *      so a rebuild months from now produces the same bytes.
 *
 * It is idempotent: a file already present with the expected size is left alone,
 * so `npm run dev` after the first run does no network I/O at all.
 *
 * Usage:
 *   node scripts/vendor-models.mjs            # copy + download what's missing
 *   node scripts/vendor-models.mjs --force    # re-fetch everything
 *   node scripts/vendor-models.mjs --simd-only  # skip the non-SIMD wasm fallback
 *   node scripts/vendor-models.mjs --check    # verify only, exit 1 if incomplete
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'public', 'models')
const WASM_OUT_DIR = path.join(OUT_DIR, 'wasm')

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const SIMD_ONLY = args.has('--simd-only')
const CHECK_ONLY = args.has('--check')

/**
 * Model weights, pinned to immutable version directories.
 *
 * face_landmarker.task — 478-point face mesh with iris refinement (indices
 *   468-477). Iris centres are what give us a real pupil line; the 468-point
 *   variant only has eye contours.
 *   https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
 *
 * selfie_segmenter.tflite — 256x256 single-class person/background segmenter.
 *   Chosen over selfie_multiclass_256x256 (16 MB) because we only need
 *   "is this pixel the subject", and 250 KB vs 16 MB is the difference between
 *   a snappy first run and a progress bar.
 *   https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite
 *
 * INTEGRITY
 * `sha256` is the authority. `bytes` is only a cheap "is this already
 * vendored" test and is NEVER treated as verification — a length comparison
 * accepts any substituted payload of the same size, which is no protection at
 * all. These weights are re-fetched on every CI build and are not committed, so
 * the digest is the single thing standing between a compromised bucket and a
 * hostile model file parsed by the WASM runtime in every visitor's browser.
 *
 * If a digest ever fails: do NOT update the constant. The upstream file changed
 * under a supposedly immutable version path, which needs investigating.
 */
const MODELS = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    bytes: 3758596,
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  },
  {
    file: 'selfie_segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
    bytes: 249537,
    sha256: '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b',
  },
]

/**
 * WASM runtime files. The SIMD build is what every current browser gets; the
 * nosimd pair is the fallback FilesetResolver picks when SIMD is unavailable,
 * and omitting it turns an old browser from "slow" into "broken". The
 * `_module_` variants are only used when the fileset is created with
 * `useModule: true`, which we do not do, so they are skipped — that alone saves
 * about 12 MB of deploy weight.
 */
const WASM_FILES = [
  { file: 'vision_wasm_internal.js', simd: true },
  { file: 'vision_wasm_internal.wasm', simd: true },
  { file: 'vision_wasm_nosimd_internal.js', simd: false },
  { file: 'vision_wasm_nosimd_internal.wasm', simd: false },
]

async function sizeOf(file) {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() ? stat.size : -1
  } catch {
    return -1
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Resolve the installed @mediapipe/tasks-vision directory. */
function resolveTasksVisionDir() {
  // The package's "exports" map does not expose "./package.json", so resolve a
  // file it does export and walk up from there.
  const wasmEntry = require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.js')
  return path.dirname(path.dirname(wasmEntry)) // .../tasks-vision/wasm -> .../tasks-vision
}

/**
 * Write via a temporary file and rename. A build interrupted halfway through a
 * 12 MB copy must not leave a truncated .wasm behind that the next run then
 * happily accepts.
 */
async function writeAtomic(dest, data) {
  const tmp = `${dest}.part`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, dest)
}

async function copyWasm() {
  const pkgDir = resolveTasksVisionDir()
  const srcDir = path.join(pkgDir, 'wasm')
  const wanted = SIMD_ONLY ? WASM_FILES.filter((f) => f.simd) : WASM_FILES
  const report = []

  for (const { file } of wanted) {
    const src = path.join(srcDir, file)
    const dest = path.join(WASM_OUT_DIR, file)
    const srcSize = await sizeOf(src)
    if (srcSize < 0) {
      throw new Error(
        `Missing ${src}. Is @mediapipe/tasks-vision installed? Run npm install first.`,
      )
    }
    const destSize = await sizeOf(dest)
    if (!FORCE && destSize === srcSize) {
      report.push({ file, bytes: destSize, action: 'up to date' })
      continue
    }
    if (CHECK_ONLY) {
      report.push({ file, bytes: srcSize, action: 'MISSING' })
      continue
    }
    await writeAtomic(dest, await fs.readFile(src))
    report.push({ file, bytes: srcSize, action: destSize < 0 ? 'copied' : 're-copied' })
  }
  return report
}

async function downloadModels() {
  const report = []
  for (const model of MODELS) {
    const dest = path.join(OUT_DIR, model.file)
    const have = await sizeOf(dest)
    if (!FORCE && have === model.bytes) {
      report.push({ file: model.file, bytes: have, action: 'up to date' })
      continue
    }
    if (have > 0 && have !== model.bytes && !FORCE) {
      console.warn(
        `  ! ${model.file} is ${formatBytes(have)}, expected ${formatBytes(model.bytes)} — re-downloading.`,
      )
    }
    if (CHECK_ONLY) {
      report.push({ file: model.file, bytes: model.bytes, action: 'MISSING' })
      continue
    }

    const response = await fetch(model.url)
    if (!response.ok) {
      throw new Error(`GET ${model.url} failed: ${response.status} ${response.statusText}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())

    // The digest is the actual verification. A length check accepts any
    // substituted payload of the same size, so it is only a fast pre-filter.
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== model.sha256) {
      throw new Error(
        `${model.file}: SHA-256 mismatch. Refusing to vendor this file.\n` +
          `  expected ${model.sha256}\n` +
          `  received ${digest}\n` +
          `  from     ${model.url}\n` +
          `This URL is pinned to an immutable version directory, so its contents ` +
          `should never change. Do NOT "fix" this by updating the constant — a ` +
          `changed digest means either upstream re-published a pinned path or the ` +
          `download was tampered with, and this file is parsed by the WASM runtime ` +
          `in every user's browser. Investigate before proceeding.`,
      )
    }
    if (buffer.byteLength !== model.bytes) {
      console.warn(
        `  ! ${model.file} digest matched but the recorded byte count is stale ` +
          `(${model.bytes} -> ${buffer.byteLength}); update it for a faster skip check.`,
      )
    }
    await writeAtomic(dest, buffer)
    report.push({ file: model.file, bytes: buffer.byteLength, action: 'downloaded' })
  }
  return report
}

async function main() {
  await fs.mkdir(WASM_OUT_DIR, { recursive: true })

  const wasm = await copyWasm()
  const models = await downloadModels()
  const all = [...wasm, ...models]

  const total = all.reduce((sum, r) => sum + r.bytes, 0)
  const missing = all.filter((r) => r.action === 'MISSING')

  console.log(`\nMediaPipe assets in public/models (${formatBytes(total)} total):`)
  for (const r of all) {
    console.log(`  ${r.action.padEnd(11)} ${formatBytes(r.bytes).padStart(9)}  ${r.file}`)
  }

  if (missing.length > 0) {
    console.error(
      `\n${missing.length} asset(s) missing. Run \`node scripts/vendor-models.mjs\` before building.`,
    )
    process.exit(1)
  }
  console.log('')
}

main().catch((error) => {
  console.error(`\nvendor-models failed: ${error.message}`)
  process.exit(1)
})
