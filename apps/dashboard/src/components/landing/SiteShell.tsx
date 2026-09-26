'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from '@/lib/auth-client'
import { useTheme } from '@/components/theme-provider'
import { Sun, Moon } from 'lucide-react'
import { AuthModals } from '@/components/auth/AuthModals'
import { SiteHeader } from '@/components/landing/SiteHeader'
import { SiteFooter } from '@/components/landing/SiteFooter'

// Reads ?signin=true in its own Suspense island so the page content can
// prerender — useSearchParams in an unsuspended boundary forces the whole
// page to bail out to client-side rendering.
function SigninParamEffect({ onSignin }: { onSignin: () => void }) {
  const searchParams = useSearchParams()
  useEffect(() => {
    if (searchParams.get('signin') === 'true') onSignin()
  }, [searchParams, onSignin])
  return null
}

export function SiteShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const session = useSession()
  const { theme, setTheme, toggleTheme } = useTheme()
  const isDark = theme === 'night' || theme === 'dawn'
  const [isSignInOpen, setIsSignInOpen] = useState(false)

  const isSignedIn = !session.isPending && !!session.data?.user

  // Public site offers just night (dark) and led (bright indoor); normalize
  // any dashboard-only stored preset on entry. First-time visitors default to
  // night (dark); the theme toggle stays available.
  useEffect(() => {
    if (!localStorage.getItem('fs-theme')) setTheme('night')
    else if (theme === 'dawn') setTheme('night')
    else if (theme === 'outdoor') setTheme('led')
    document.documentElement.classList.add('scroll-smooth')
    return () => document.documentElement.classList.remove('scroll-smooth')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-open sign-in modal when redirected with ?signin=true
  const requestSignin = useCallback(() => {
    if (!isSignedIn) setIsSignInOpen(true)
  }, [isSignedIn])

  const openPortal = useCallback(() => {
    if (isSignedIn) {
      router.push('/dashboard/analyze')
    } else {
      setIsSignInOpen(true)
    }
  }, [isSignedIn, router])

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      {children}
      <SiteFooter onAdminClick={openPortal} />
      <button
        onClick={toggleTheme}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        className="fixed bottom-5 right-5 z-[80] p-3 rounded-full border border-border bg-background/80 backdrop-blur-xl text-muted-foreground hover:text-foreground hover:border-foreground/30 active:scale-90 transition-all duration-150"
      >
        {isDark ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
      </button>
      <AuthModals
        isSignInOpen={isSignInOpen}
        onSignInOpenChange={setIsSignInOpen}
      />
      <Suspense fallback={null}>
        <SigninParamEffect onSignin={requestSignin} />
      </Suspense>
    </div>
  )
}
