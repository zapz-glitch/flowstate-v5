import { SiteShell } from '@/components/landing/SiteShell'
import { Hero } from '@/components/landing/Hero'
import { WhatWeBuy } from '@/components/landing/WhatWeBuy'
import { Process } from '@/components/landing/Process'
import { WhoWeWorkWith } from '@/components/landing/WhoWeWorkWith'
import { CtaSection } from '@/components/landing/CtaSection'

export default function HomePage() {
  return (
    <SiteShell>
      <main>
        <Hero />
        <WhatWeBuy />
        <Process />
        <WhoWeWorkWith />
        <CtaSection />
      </main>
    </SiteShell>
  )
}
