/**
 * Remembers the user's *choices* between visits — never their photo.
 *
 * The original plan was to persist the whole session to IndexedDB so a refresh
 * would not lose work. That is the wrong trade here. The app tells users their
 * photo "is never uploaded, stored, or sent anywhere", and writing a picture of
 * someone's face to disk would make that sentence false. A passport photo is
 * about as sensitive as a personal image gets, and leaving copies in browser
 * storage on a shared or borrowed machine is a real hazard, not a theoretical
 * one.
 *
 * So only the settings are kept: which country, which paper. Those are useful
 * to remember, carry no personal data, and losing the photo on refresh is a
 * mild inconvenience by comparison.
 */

const STORAGE_KEY = 'pps.settings'

export interface PersistedSettings {
  specId?: string
  paperId?: string
}

export function loadSettings(): PersistedSettings {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const { specId, paperId } = parsed as PersistedSettings
    return {
      specId: typeof specId === 'string' ? specId : undefined,
      paperId: typeof paperId === 'string' ? paperId : undefined,
    }
  } catch {
    // Private browsing, disabled storage, or corrupt JSON — defaults are fine.
    return {}
  }
}

export function saveSettings(settings: PersistedSettings): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Storage being unavailable must never break the editor.
  }
}
