'use client'

import { Suspense, useEffect } from 'react'
import { SiteShell } from '@/components/landing/SiteShell'
import { Hero } from '@/components/landing/Hero'
import { WhatWeBuy } from '@/components/landing/WhatWeBuy'
import { Process } from '@/components/landing/Process'
import { WhoWeWorkWith } from '@/components/landing/WhoWeWorkWith'
import { CtaSection } from '@/components/landing/CtaSection'

export default function HomePage() {
  // Section-jump scrolling on the landing page only: one wheel flick moves
  // exactly one section (scrollIntoView honors snap-start + scroll-mt);
  // snap proximity keeps touch/trackpad scrolling honest.
  useEffect(() => {
    const el = document.documentElement
    el.classList.add('snap-y', 'snap-proximity')

    const sections = Array.from(
      document.querySelectorAll('main > section')
    ) as HTMLElement[]
    if (sections.length === 0) {
      return () => el.classList.remove('snap-y', 'snap-proximity')
    }

    let locked = false
    const onWheel = (e: WheelEvent) => {
      if (locked) {
        e.preventDefault()
        return
      }
      const dir = e.deltaY > 0 ? 1 : -1
      const current = sections.reduce(
        (acc, s, i) => (s.offsetTop <= window.scrollY + 8 ? i : acc),
        0
      )
      const next = Math.min(Math.max(current + dir, 0), sections.length - 1)
      // Past the last section: free scroll into the footer
      if (next === current) return
      e.preventDefault()
      locked = true
      sections[next].scrollIntoView({ behavior: 'smooth', block: 'start' })
      window.setTimeout(() => { locked = false }, 700)
    }

    window.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.classList.remove('snap-y', 'snap-proximity')
      window.removeEventListener('wheel', onWheel)
    }
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
