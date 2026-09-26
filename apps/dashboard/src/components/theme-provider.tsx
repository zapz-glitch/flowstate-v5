'use client'

import { createContext, useContext, useEffect, useState } from 'react'

// Environment presets — palette tuned per lighting condition.
// night/dawn are dark palettes; outdoor/led are light palettes.
export type Theme = 'night' | 'dawn' | 'outdoor' | 'led'

const DARK_PRESETS: ReadonlySet<Theme> = new Set(['night', 'dawn'])

interface ThemeContextType {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

// Migrate legacy stored values
function normalizeTheme(stored: string | null): Theme | null {
  if (stored === 'dark') return 'night'
  if (stored === 'light') return 'led'
  if (stored === 'night' || stored === 'dawn' || stored === 'outdoor' || stored === 'led') return stored
  return null
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('night')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const stored = normalizeTheme(localStorage.getItem('fs-theme'))
    if (stored) {
      setThemeState(stored)
    }
  }, [])

  useEffect(() => {
    if (!mounted) return
    const root = document.documentElement
    const isDark = DARK_PRESETS.has(theme)
    root.classList.toggle('dark', isDark)
    root.classList.toggle('light', !isDark)
    root.dataset.preset = theme
    localStorage.setItem('fs-theme', theme)
  }, [theme, mounted])

  const setTheme = (next: Theme) => setThemeState(next)

  // Binary toggle for quick switches: any dark preset ↔ led
  const toggleTheme = () => {
    setThemeState(prev => (DARK_PRESETS.has(prev) ? 'led' : 'night'))
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
