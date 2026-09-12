'use client'

import { Suspense, useEffect } from 'react'
import { SiteShell } from '@/components/landing/SiteShell'
import { Hero } from '@/components/landing/Hero'
import { WhatWeBuy } from '@/components/landing/WhatWeBuy'
import { Process } from '@/components/landing/Process'
import { WhoWeWorkWith } from '@/components/landing/WhoWeWorkWith'
import { CtaSection } from '@/components/landing/CtaSection'

export default function HomePage() {
  // Section-snap scrolling on the landing page only (proximity, not
  // mandatory, so short sections never trap the scroll)
  useEffect(() => {
    const el = document.documentElement
    el.classList.add('snap-y', 'snap-proximity')
    return () => el.classList.remove('snap-y', 'snap-proximity')
  }, [])

  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <SiteShell>
        <main>
          <Hero />
          <WhatWeBuy />
          <Process />
          <WhoWeWorkWith />
          <CtaSection />
        </main>
      </SiteShell>
    </Suspense>
  )
}
