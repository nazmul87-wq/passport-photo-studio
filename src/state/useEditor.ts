/**
 * Editor state.
 *
 * A reducer rather than scattered useState calls, because almost every action
 * touches more than one field — changing the spec, for example, must also pull
 * the head and eye heights into the new spec's ranges.
 *
 * History treats a continuous gesture as one entry. Dragging a pin or sliding a
 * slider fires dozens of actions; the first of them stashes the pre-gesture
 * document in `gestureBase`, and `commitHistory` (called on pointer-up or blur)
 * pushes that single snapshot. Without this, one drag would bury the undo stack
 * under two hundred intermediate states.
 */

import { useEffect, useMemo, useReducer } from 'react'
import {
  clampPlacement,
  defaultPlacement,
  type Landmarks,
  type Placement,
} from '@/core/geometry'
import { DEFAULT_SPEC_ID, getSpec, type PhotoSpec } from '@/core/specs'
import {
  DEFAULT_PAPER_ID,
  DEFAULT_SHEET_OPTIONS,
  getPaper,
  type PaperSize,
  type SheetOptions,
} from '@/core/render'
import type { LoadedImage } from '@/lib/loadImage'
import { loadSettings, saveSettings } from '@/lib/persistSettings'

export type LandmarkKey = keyof Landmarks

/** The part of state that undo/redo restores. The image itself is not history. */
interface EditorDoc {
  specId: string
  paperId: string
  placement: Placement | null
  sheet: SheetOptions
}

interface EditorState {
  doc: EditorDoc
  image: LoadedImage | null
  past: EditorDoc[]
  future: EditorDoc[]
  /** Document as it was when the in-progress gesture started, or null if idle. */
  gestureBase: EditorDoc | null
}

type Action =
  | { type: 'setSpec'; specId: string }
  | { type: 'setPaper'; paperId: string }
  | { type: 'setImage'; image: LoadedImage | null }
  | { type: 'setLandmark'; key: LandmarkKey; x: number; y: number }
  | { type: 'nudgeLandmark'; key: LandmarkKey; dx: number; dy: number }
  | { type: 'setHeadHeight'; value: number }
  | { type: 'setEyeHeight'; value: number }
  | { type: 'setRoll'; value: number }
  | { type: 'setPlacement'; placement: Placement }
  | { type: 'setDetectedLandmarks'; landmarks: Landmarks }
  | { type: 'setSheet'; sheet: Partial<SheetOptions> }
  | { type: 'commit' }
  | { type: 'undo' }
  | { type: 'redo' }

const HISTORY_LIMIT = 60

/**
 * Restore the remembered country and paper. Ids are validated against the
 * registries because a saved id can disappear when the spec data changes, and
 * an unknown id would otherwise throw on first render.
 */
export function createInitialState(): EditorState {
  const saved = loadSettings()
  const specId = saved.specId && specExists(saved.specId) ? saved.specId : DEFAULT_SPEC_ID
  const paperId = saved.paperId && paperExists(saved.paperId) ? saved.paperId : DEFAULT_PAPER_ID

  return {
    doc: { specId, paperId, placement: null, sheet: DEFAULT_SHEET_OPTIONS },
    image: null,
    past: [],
    future: [],
    gestureBase: null,
  }
}

function specExists(id: string): boolean {
  try {
    getSpec(id)
    return true
  } catch {
    return false
  }
}

function paperExists(id: string): boolean {
  try {
    getPaper(id)
    return true
  } catch {
    return false
  }
}

/**
 * Record a discrete change immediately: one action, one undo entry.
 *
 * If a gesture is still open, its starting snapshot is what gets pushed — not
 * the current document. Pushing the current one would bury the pre-gesture
 * state and make the user's in-flight drag permanently un-undoable: change the
 * paper size mid-drag and the slider movement before it could never be
 * reversed. `transient` establishes that invariant; this has to honour it.
 */
function discrete(state: EditorState, doc: EditorDoc): EditorState {
  if (doc === state.doc) return state
  return {
    ...state,
    doc,
    past: [...state.past, state.gestureBase ?? state.doc].slice(-HISTORY_LIMIT),
    future: [],
    gestureBase: null,
  }
}

/**
 * Record a change that is part of a continuous gesture: the document updates
 * now, but the undo entry is deferred until `commit`.
 */
function transient(state: EditorState, doc: EditorDoc): EditorState {
  if (doc === state.doc) return state
  return { ...state, doc, gestureBase: state.gestureBase ?? state.doc }
}

function updatePlacement(
  state: EditorState,
  update: (placement: Placement, spec: PhotoSpec) => Placement,
): EditorState {
  if (!state.doc.placement) return state
  const spec = getSpec(state.doc.specId)
  const next = clampPlacement(spec, update(state.doc.placement, spec))
  return transient(state, { ...state.doc, placement: next })
}

/**
 * Exported for testing. The reducer is pure, so it is far better exercised
 * directly than through a rendered component and a simulated DOM.
 */
export function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'setSpec': {
      if (action.specId === state.doc.specId) return state
      const spec = getSpec(action.specId)
      const placement = state.doc.placement
        ? clampPlacement(spec, {
            ...state.doc.placement,
            // Head and eye heights are measurements in the spec's own unit, so
            // carrying the old numbers across a unit change would be
            // meaningless. Reset to the new spec's defaults.
            headHeight: spec.head.default,
            eyeHeight: spec.eye.default,
          })
        : null
      return discrete(state, { ...state.doc, specId: action.specId, placement })
    }

    case 'setPaper':
      if (action.paperId === state.doc.paperId) return state
      return discrete(state, { ...state.doc, paperId: action.paperId })

    case 'setImage': {
      if (!action.image) {
        return {
          doc: { ...state.doc, placement: null },
          image: null,
          past: [],
          future: [],
          gestureBase: null,
        }
      }
      const spec = getSpec(state.doc.specId)
      return {
        ...state,
        image: action.image,
        doc: {
          ...state.doc,
          placement: defaultPlacement(spec, action.image.width, action.image.height),
        },
        past: [],
        future: [],
        gestureBase: null,
      }
    }

    case 'setLandmark':
      return updatePlacement(state, (p) => ({
        ...p,
        landmarks: { ...p.landmarks, [action.key]: { x: action.x, y: action.y } },
      }))

    case 'nudgeLandmark':
      return updatePlacement(state, (p) => {
        const current = p.landmarks[action.key]
        return {
          ...p,
          landmarks: {
            ...p.landmarks,
            [action.key]: { x: current.x + action.dx, y: current.y + action.dy },
          },
        }
      })

    case 'setHeadHeight':
      return updatePlacement(state, (p) => ({ ...p, headHeight: action.value }))

    case 'setEyeHeight':
      return updatePlacement(state, (p) => ({ ...p, eyeHeight: action.value }))

    case 'setRoll':
      return updatePlacement(state, (p) => ({ ...p, rollAdjustDeg: action.value }))

    case 'setPlacement':
      return updatePlacement(state, () => action.placement)

    case 'setDetectedLandmarks':
      // Detection replaces the landmarks only. Head and eye heights are spec
      // requirements, not observations, so a detector must never overwrite
      // them — and the manual levelling offset stays at whatever the user set,
      // because the automatic component is derived from the new landmarks.
      return updatePlacement(state, (p) => ({ ...p, landmarks: action.landmarks }))

    case 'setSheet':
      return discrete(state, { ...state.doc, sheet: { ...state.doc.sheet, ...action.sheet } })

    case 'commit': {
      if (!state.gestureBase || state.gestureBase === state.doc) {
        return state.gestureBase ? { ...state, gestureBase: null } : state
      }
      return {
        ...state,
        past: [...state.past, state.gestureBase].slice(-HISTORY_LIMIT),
        future: [],
        gestureBase: null,
      }
    }

    case 'undo': {
      // An uncommitted gesture is the newest change, so undo must retire that
      // first — otherwise releasing the mouse and hitting undo would skip past
      // the drag the user just made.
      const base = state.gestureBase
      if (base) {
        return {
          ...state,
          doc: base,
          future: [state.doc, ...state.future],
          gestureBase: null,
        }
      }
      const previous = state.past[state.past.length - 1]
      if (!previous) return state
      return {
        ...state,
        doc: previous,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future],
      }
    }

    case 'redo': {
      const next = state.future[0]
      if (!next) return state
      return {
        ...state,
        doc: next,
        past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        gestureBase: null,
      }
    }
  }
}

export interface Editor {
  spec: PhotoSpec
  paper: PaperSize
  sheet: SheetOptions
  image: LoadedImage | null
  placement: Placement | null
  canUndo: boolean
  canRedo: boolean

  setSpec: (specId: string) => void
  setPaper: (paperId: string) => void
  setImage: (image: LoadedImage | null) => void
  setLandmark: (key: LandmarkKey, x: number, y: number) => void
  nudgeLandmark: (key: LandmarkKey, dx: number, dy: number) => void
  setHeadHeight: (value: number) => void
  setEyeHeight: (value: number) => void
  setRoll: (value: number) => void
  setPlacement: (placement: Placement) => void
  setDetectedLandmarks: (landmarks: Landmarks) => void
  setSheet: (sheet: Partial<SheetOptions>) => void
  /** End the current gesture, folding it into a single undo entry. */
  commitHistory: () => void
  undo: () => void
  redo: () => void
}

export function useEditor(): Editor {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState)

  // Only the choices are persisted, never the photo. See persistSettings.ts.
  useEffect(() => {
    saveSettings({ specId: state.doc.specId, paperId: state.doc.paperId })
  }, [state.doc.specId, state.doc.paperId])

  const spec = useMemo(() => getSpec(state.doc.specId), [state.doc.specId])
  const paper = useMemo(() => getPaper(state.doc.paperId), [state.doc.paperId])

  return {
    spec,
    paper,
    sheet: state.doc.sheet,
    image: state.image,
    placement: state.doc.placement,
    canUndo: state.past.length > 0 || state.gestureBase !== null,
    canRedo: state.future.length > 0,

    setSpec: (specId) => dispatch({ type: 'setSpec', specId }),
    setPaper: (paperId) => dispatch({ type: 'setPaper', paperId }),
    setImage: (image) => dispatch({ type: 'setImage', image }),
    setLandmark: (key, x, y) => dispatch({ type: 'setLandmark', key, x, y }),
    nudgeLandmark: (key, dx, dy) => dispatch({ type: 'nudgeLandmark', key, dx, dy }),
    setHeadHeight: (value) => dispatch({ type: 'setHeadHeight', value }),
    setEyeHeight: (value) => dispatch({ type: 'setEyeHeight', value }),
    setRoll: (value) => dispatch({ type: 'setRoll', value }),
    setPlacement: (placement) => dispatch({ type: 'setPlacement', placement }),
    setDetectedLandmarks: (landmarks) => dispatch({ type: 'setDetectedLandmarks', landmarks }),
    setSheet: (sheet) => dispatch({ type: 'setSheet', sheet }),
    commitHistory: () => dispatch({ type: 'commit' }),
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
  }
}
