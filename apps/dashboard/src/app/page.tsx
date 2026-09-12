'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession } from '@/lib/auth-client'
import { useTheme } from '@/components/theme-provider'
import { AuthModals } from '@/components/auth/AuthModals'
import { SiteHeader } from '@/components/landing/SiteHeader'
import { Hero } from '@/components/landing/Hero'
import { WhatWeBuy } from '@/components/landing/WhatWeBuy'
import { Process } from '@/components/landing/Process'
import { WhoWeWorkWith } from '@/components/landing/WhoWeWorkWith'
import { CtaSection } from '@/components/landing/CtaSection'
import { SiteFooter } from '@/components/landing/SiteFooter'

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <HomePageContent />
    </Suspense>
  )
}

function HomePageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const session = useSession()
  const { theme, setTheme } = useTheme()
  const [isSignInOpen, setIsSignInOpen] = useState(false)
  const [isSignUpOpen, setIsSignUpOpen] = useState(false)

  const isSignedIn = !session.isPending && !!session.data?.user

  // Public site offers just night (dark) and led (bright indoor); normalize
  // any dashboard-only stored preset on entry
  useEffect(() => {
    if (theme === 'dawn') setTheme('night')
    else if (theme === 'outdoor') setTheme('led')
    document.documentElement.classList.add('scroll-smooth')
    return () => document.documentElement.classList.remove('scroll-smooth')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-open sign-in modal when redirected with ?signin=true
  useEffect(() => {
    if (searchParams.get('signin') === 'true' && !isSignedIn) {
      setIsSignInOpen(true)
    }
  }, [searchParams, isSignedIn])

  const openPortal = useCallback(() => {
    if (isSignedIn) {
      router.push('/dashboard')
    } else {
      setIsSignInOpen(true)
    }
  }, [isSignedIn, router])

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader onPortalClick={openPortal} isSignedIn={isSignedIn} />

      <main>
        <Hero />
        <WhatWeBuy />
        <Process />
        <WhoWeWorkWith />
        <CtaSection />
      </main>

      <SiteFooter />

      <AuthModals
        isSignInOpen={isSignInOpen}
        isSignUpOpen={isSignUpOpen}
        onSignInOpenChange={setIsSignInOpen}
        onSignUpOpenChange={setIsSignUpOpen}
      />
    </div>
  )
}
