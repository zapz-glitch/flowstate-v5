'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { X, Eye } from 'lucide-react'

const STORAGE_KEY = 'flowstate_impersonation'

export interface ImpersonationTarget {
  id: string
  name: string
  email: string
  plan: string
}

export interface ImpersonationAdmin {
  id: string
  name: string
  email: string
}

interface ImpersonationState {
  target: ImpersonationTarget
  admin: ImpersonationAdmin
}

interface ImpersonationContextValue {
  /** The user being impersonated, or null if not impersonating */
  impersonating: ImpersonationTarget | null
  /** The admin who initiated impersonation */
  admin: ImpersonationAdmin | null
  /** Whether impersonation is active */
  isImpersonating: boolean
  /** Start impersonating a user */
  startImpersonating: (target: ImpersonationTarget, admin: ImpersonationAdmin) => void
  /** Stop impersonating and return to admin session */
  stopImpersonating: () => void
}

const ImpersonationContext = createContext<ImpersonationContextValue>({
  impersonating: null,
  admin: null,
  isImpersonating: false,
  startImpersonating: () => {},
  stopImpersonating: () => {},
})

export function useImpersonation() {
  return useContext(ImpersonationContext)
}

/**
 * Returns the impersonated user ID if active, for use in API headers.
 * Can be called outside React (reads localStorage directly).
 */
export function getImpersonatedUserId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const state: ImpersonationState = JSON.parse(raw)
    return state.target?.id ?? null
  } catch {
    return null
  }
}

interface ImpersonationProviderProps {
  children: React.ReactNode
}

export function ImpersonationProvider({ children }: ImpersonationProviderProps) {
  const [state, setState] = useState<ImpersonationState | null>(null)

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        setState(JSON.parse(raw))
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
  }, [])

  const startImpersonating = useCallback((target: ImpersonationTarget, admin: ImpersonationAdmin) => {
    const newState: ImpersonationState = { target, admin }
    setState(newState)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newState))
    // Reload to re-fetch all data as the impersonated user
    window.location.href = '/dashboard'
  }, [])

  const stopImpersonating = useCallback(() => {
    setState(null)
    localStorage.removeItem(STORAGE_KEY)
    // Reload to restore admin's own session data
    window.location.href = '/dashboard/admin/users'
  }, [])

  return (
    <ImpersonationContext.Provider
      value={{
        impersonating: state?.target ?? null,
        admin: state?.admin ?? null,
        isImpersonating: !!state,
        startImpersonating,
        stopImpersonating,
      }}
    >
      {state && <ImpersonationBanner target={state.target} onStop={stopImpersonating} />}
      {children}
    </ImpersonationContext.Provider>
  )
}

function ImpersonationBanner({ target, onStop }: { target: ImpersonationTarget; onStop: () => void }) {
  return (
    <div className="fixed top-0 left-0 right-0 z-[100] bg-amber-500 text-black px-4 py-2 flex items-center justify-center gap-3 text-body-sm font-medium shadow-lg pt-[calc(0.5rem+var(--sat))]">
      <Eye className="w-4 h-4 shrink-0" />
      <span>
        Impersonating <strong>{target.name}</strong> ({target.email}) — {target.plan} plan
      </span>
      <button
        onClick={onStop}
        className="ml-2 flex items-center gap-1 px-3 py-1 rounded-md bg-black/20 hover:bg-black/30 transition-colors text-caption font-semibold"
      >
        <X className="w-3 h-3" />
        Stop
      </button>
    </div>
  )
}
