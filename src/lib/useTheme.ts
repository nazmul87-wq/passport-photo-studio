import { useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'pps.theme'

/**
 * Storage access is wrapped because it can *throw*, not just return null:
 * `localStorage` raises SecurityError when storage is disabled by policy, in
 * some WebView contexts, and under strict third-party-storage blocking inside
 * an iframe. This runs during the first render, so an unguarded read takes the
 * whole app down before it mounts — a total failure caused by a colour
 * preference. The value is also validated against the two legal literals, so a
 * poisoned key falls back to the system preference instead of being trusted.
 */
function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // Storage unavailable — fall through to the system preference.
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // Not being able to remember the theme must never break the editor.
    }
  }, [theme])

  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))]
}
