'use client'

import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'

const plans = [
  {
    name: 'Free',
    price: '$0',
    period: '/month',
    description: 'Perfect for getting started',
    features: [
      '100 API requests/month',
      '1 API key',
      'Comparables & ARV calculations',
      'Default appraisal rules',
    ],
    cta: 'Get Started',
    popular: false,
  },
  {
    name: 'Pro',
    price: '$99',
    period: '/month',
    description: 'For serious investors',
    features: [
      '5,000 API requests/month',
      '5 API keys',
      'Comparables & ARV calculations',
      'Custom appraisal rules',
      'Custom comp filters',
    ],
    cta: 'Start Free Trial',
    popular: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'For teams & high volume',
    features: [
      'Unlimited API requests',
      'Unlimited API keys',
      'Custom appraisal rules',
      'Custom comp filters',
      'Custom integrations',
      'SLA guarantee',
    ],
    cta: 'Contact Sales',
    popular: false,
  },
]

// Get the maximum number of features across all plans for consistent height
const maxFeatures = Math.max(...plans.map(p => p.features.length))

interface PricingProps {
  onSignUpClick: () => void
}

export function Pricing({ onSignUpClick }: PricingProps) {
  return (
    <section id="pricing" className="py-16 bg-background">
      <div className="max-w-5xl mx-auto px-6">
        {/* Header */}
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl font-sans font-medium tracking-[-0.02em] text-foreground mb-4">
            Simple, transparent pricing
          </h2>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Start free and scale as you grow. No hidden fees.
          </p>
        </div>

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-3 gap-6">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-lg p-8 flex flex-col ${
                plan.popular
                  ? 'bg-card border border-foreground/30'
                  : 'bg-card border border-border'
              }`}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="bg-foreground text-background mono-label px-3 py-1.5 rounded-full">
                    Most Popular
                  </span>
                </div>
              )}

              {/* Plan header - fixed height */}
              <div className="mb-6">
                <h3 className="text-xl font-semibold text-foreground mb-1">{plan.name}</h3>
                <p className="text-muted-foreground text-sm h-5">{plan.description}</p>
              </div>

              {/* Price - fixed height */}
              <div className="mb-6 h-12 flex items-baseline">
                <span className="text-4xl font-semibold text-foreground">{plan.price}</span>
                <span className="text-muted-foreground ml-1">{plan.period}</span>
              </div>

              {/* Features list - flex-grow to push button to bottom */}
              <ul className="space-y-3 flex-grow">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm text-card-foreground">
                    <Check className="h-4 w-4 text-foreground-secondary flex-shrink-0 mt-0.5" />
                    <span>{feature}</span>
                  </li>
                ))}
                {/* Invisible spacers to maintain consistent height */}
                {Array.from({ length: maxFeatures - plan.features.length }).map((_, i) => (
                  <li key={`spacer-${i}`} className="h-5" aria-hidden="true" />
                ))}
              </ul>

              {/* Button - always at bottom */}
              <div className="mt-8">
                <Button
                  onClick={onSignUpClick}
                  variant={plan.popular ? 'default' : 'outline'}
                  className={`w-full ${
                    plan.popular
                      ? 'bg-foreground text-background hover:bg-foreground/90'
                      : 'border-border text-foreground hover:bg-secondary'
                  }`}
                >
                  {plan.cta}
                </Button>
              </div>
            </div>
          ))}
        </div>

        {/* Bottom note */}
        <p className="text-center text-sm text-muted-foreground mt-12">
          All plans include SSL encryption, 99.9% uptime SLA, and GDPR compliance.
        </p>
      </div>
    </section>
  )
}
