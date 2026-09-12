import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SiteShell } from '@/components/landing/SiteShell'

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms that govern use of the Flowstate website.',
}

const SECTIONS = [
  {
    title: 'The site',
    body: [
      'This website is operated by Flowstate, a private real estate investment company. It provides general information about who we are, what we buy, and how to reach us. By using this site you accept these terms.',
    ],
  },
  {
    title: 'No brokerage, no advice',
    body: [
      'Flowstate is not a licensed real estate broker or agent and does not represent buyers or sellers in any transaction. Nothing on this site is legal, tax, financial, or investment advice. Consult your own licensed professionals.',
    ],
  },
  {
    title: 'No offer or obligation',
    body: [
      'Submitting a property through this site does not create an offer, an acceptance, or any obligation on either side. Any transaction occurs only under a written agreement executed by the parties. We may decline any submission for any reason.',
    ],
  },
  {
    title: 'Acceptable use',
    body: [
      'Do not submit false or misleading information, property you have no right to discuss, or anything unlawful. Do not attempt to disrupt or probe the site or its infrastructure.',
    ],
  },
  {
    title: 'Intellectual property',
    body: [
      'The site, its design, and its content are the property of Flowstate. You may view and share links; you may not copy, reproduce, or reuse the design or content for commercial purposes without written permission.',
    ],
  },
  {
    title: 'Disclaimers and liability',
    body: [
      'The site is provided as is, without warranties of any kind. To the maximum extent permitted by law, Flowstate is not liable for indirect, incidental, or consequential damages arising from use of the site, and our total liability for any claim related to the site is limited to one hundred dollars.',
    ],
  },
  {
    title: 'Changes and contact',
    body: [
      'We may update these terms from time to time. The current version is always posted on this page with its effective date. Continued use of the site after a change constitutes acceptance.',
      'Questions: hello@flowstate.homes.',
    ],
  },
]

export default function TermsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <SiteShell>
        <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-32 sm:pt-40 pb-20">
          <div className="max-w-2xl">
            <p className="mono-label mb-6">Legal / Terms</p>
            <h1 className="text-3xl sm:text-5xl font-sans font-medium tracking-[-0.03em] text-foreground leading-tight">
              Terms of Service
            </h1>
            <p className="mt-4 text-sm text-muted-foreground">
              Effective September 11, 2026
            </p>

            <div className="mt-12 space-y-10">
              {SECTIONS.map((section, i) => (
                <section key={section.title}>
                  <p className="mono-label !text-[10px] mb-3">
                    {String(i + 1).padStart(2, '0')}
                  </p>
                  <h2 className="text-lg font-medium text-foreground mb-2">{section.title}</h2>
                  {section.body.map((paragraph, j) => (
                    <p key={j} className="text-sm text-muted-foreground leading-relaxed mt-2">
                      {paragraph}
                    </p>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </main>
      </SiteShell>
    </Suspense>
  )
}
