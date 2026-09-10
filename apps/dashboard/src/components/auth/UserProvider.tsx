'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from '@/lib/auth-client'
import { Loader2 } from 'lucide-react'
import { getImpersonatedUserId } from './ImpersonationProvider'

export interface User {
  id: string
  name: string
  email: string
  emailVerified: boolean
  role?: string // 'user' | 'admin'
  plan?: string
  createdAt: Date
  updatedAt: Date
}

interface UserContextValue {
  user: User | null
  isLoading: boolean
}

const UserContext = createContext<UserContextValue>({
  user: null,
  isLoading: true,
})

export function useUser() {
  const context = useContext(UserContext)
  if (!context) {
    throw new Error('useUser must be used within a UserProvider')
  }
  return context
}

interface UserProviderProps {
  children: React.ReactNode
  requireAuth?: boolean
}

const API_URL = process.env.NEXT_PUBLIC_API_URL!

export function UserProvider({ children, requireAuth = true }: UserProviderProps) {
  const router = useRouter()
  const session = useSession()
  const [isChecking, setIsChecking] = useState(true)
  const [enrichedUser, setEnrichedUser] = useState<User | null>(null)

  useEffect(() => {
    // Wait for session to load
    if (session.isPending) return

    setIsChecking(false)

    // If auth required and no session, redirect to home (sign in)
    if (requireAuth && !session.data?.user) {
      router.replace('/')
    }
  }, [session.isPending, session.data, router, requireAuth])

  // Fetch full user profile (includes role) once session is available
  useEffect(() => {
    if (!session.data?.user) {
      setEnrichedUser(null)
      return
    }

    const sessionUser = session.data.user as User
    // Set session user immediately so UI isn't blocked
    setEnrichedUser(sessionUser)

    // Fetch full profile with role (include impersonation header if active)
    const impersonateId = getImpersonatedUserId()
    const headers: Record<string, string> = impersonateId
      ? { 'X-Impersonate-User-Id': impersonateId }
      : {}

    fetch(`${API_URL}/user`, { credentials: 'include', headers })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setEnrichedUser({ ...sessionUser, ...data })
        }
      })
      .catch(() => {
        // Keep session user on failure
      })
  }, [session.data?.user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Show loading while checking
  if (isChecking || session.isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-foreground" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  // If auth required and no user after check, show nothing (redirect will happen)
  if (requireAuth && !session.data?.user) {
    return null
  }

  return (
    <UserContext.Provider value={{ user: enrichedUser, isLoading: false }}>
      {children}
    </UserContext.Provider>
  )
}
