import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SiteShell } from '@/components/landing/SiteShell'

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How Flowstate collects, uses, and protects information submitted through this site.',
}

const SECTIONS = [
  {
    title: 'Overview',
    body: [
      'Flowstate is a private real estate investment company. This Privacy Policy explains what information we collect through this website, how we use it, and the choices you have. By using this site or submitting a form, you agree to this policy.',
    ],
  },
  {
    title: 'Information we collect',
    body: [
      'Information you give us: when you submit the deal form or contact us, we collect your name, email address, the property address you submit, and anything you include in the notes field.',
      'Information collected automatically: like most websites, our hosting infrastructure may log technical data such as your IP address, browser type, and pages visited. We store a theme preference in your browser local storage; it never leaves your device.',
    ],
  },
  {
    title: 'How we use information',
    body: [
      'We use submitted information to evaluate the property you sent us, to respond to you, and to communicate about a potential transaction. We may also use it to operate, secure, and improve this site.',
    ],
  },
  {
    title: 'Email and SMS communications',
    body: [
      'By submitting a form with your email address, you consent to receive email from us about your submission and related opportunities. Where you provide a phone number and consent, we may contact you by SMS. Marketing messages are sent only with your consent.',
      'You can opt out at any time: use the unsubscribe link in any email or reply STOP to any SMS. Opting out does not affect communications about a transaction already in progress.',
    ],
  },
  {
    title: 'We do not sell your information',
    body: [
      'We do not sell, rent, or trade your personal information to anyone, for money or otherwise. We do not share personal information with third parties for their own marketing purposes.',
      'We share information only with service providers who help us operate (for example, hosting and email delivery), who may use it only to provide those services, or when required by law.',
    ],
  },
  {
    title: 'Retention, security, and your rights',
    body: [
      'We keep submission data only as long as needed to evaluate the opportunity and maintain our records, and we apply reasonable technical and organizational safeguards. No method of transmission over the internet is perfectly secure.',
      'You may request access to, correction of, or deletion of your personal information at any time by emailing hello@flowstate.homes. We will respond within a reasonable period.',
    ],
  },
  {
    title: 'Changes and contact',
    body: [
      'We may update this policy from time to time. The current version is always posted on this page with its effective date.',
      'Questions or requests: hello@flowstate.homes.',
    ],
  },
]

export default function PrivacyPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <SiteShell>
        <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-32 sm:pt-40 pb-20">
          <div className="max-w-2xl">
            <p className="mono-label mb-6">Legal / Privacy</p>
            <h1 className="text-3xl sm:text-5xl font-sans font-medium tracking-[-0.03em] text-foreground leading-tight">
              Privacy Policy
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
