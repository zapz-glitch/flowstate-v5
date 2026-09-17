'use client'

import { Suspense } from 'react'
import { SiteShell } from '@/components/landing/SiteShell'
import { Hero } from '@/components/landing/Hero'
import { WhatWeBuy } from '@/components/landing/WhatWeBuy'
import { Process } from '@/components/landing/Process'
import { WhoWeWorkWith } from '@/components/landing/WhoWeWorkWith'
import { Insights } from '@/components/landing/Insights'
import { CtaSection } from '@/components/landing/CtaSection'

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <SiteShell>
        <main>
          <Hero />
          <WhatWeBuy />
          <Process />
          <WhoWeWorkWith />
          <Insights />
          <CtaSection />
        </main>
      </SiteShell>
    </Suspense>
  )
}
