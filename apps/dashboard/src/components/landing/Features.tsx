'use client'

import {
  Zap,
  BarChart3,
  SlidersHorizontal,
  Wrench,
  Radio,
  ShieldCheck
} from 'lucide-react'

const features = [
  {
    icon: Zap,
    title: 'Instant Analysis',
    description: 'Get property valuations and ARV calculations in milliseconds, not minutes.',
  },
  {
    icon: BarChart3,
    title: 'Accurate Comparables',
    description: 'AI-powered comparable selection based on property characteristics and market data.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Custom Comp Filters',
    description: 'Filter by radius, age, square footage, pool, and more to refine your analysis.',
  },
  {
    icon: Wrench,
    title: 'Flexible Appraisal Rules',
    description: 'Set custom ARV multipliers, rehab costs, and investment criteria.',
  },
  {
    icon: Radio,
    title: 'Real-time Data',
    description: 'Access up-to-date property records, sales history, and market trends.',
  },
  {
    icon: ShieldCheck,
    title: 'Enterprise Ready',
    description: 'Secure API with rate limiting, usage analytics, and 99.9% uptime SLA.',
  },
]

export function Features() {
  return (
    <section id="features" className="py-20 sm:py-28 bg-background">
      <div className="max-w-6xl mx-auto px-6">
        {/* Header */}
        <div className="mb-14">
          <p className="mono-label mb-4">02 / Capabilities</p>
          <h2 className="text-3xl sm:text-4xl font-sans font-medium tracking-[-0.02em] text-foreground mb-4">
            Everything you need
          </h2>
          <p className="text-base text-muted-foreground max-w-xl leading-relaxed">
            Powerful property analysis tools built for real estate investors and developers.
          </p>
        </div>

        {/* Features Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border rounded-lg overflow-hidden">
          {features.map((feature, i) => (
            <div
              key={feature.title}
              className="group p-6 bg-background hover:bg-card transition-colors duration-200"
            >
              <div className="flex items-center justify-between mb-5">
                <div className="w-9 h-9 rounded-md border border-border flex items-center justify-center flex-shrink-0">
                  <feature.icon className="w-4 h-4 text-foreground" />
                </div>
                <span className="mono-label">{String(i + 1).padStart(2, '0')}</span>
              </div>
              <h3 className="text-base font-medium text-foreground mb-1.5">
                {feature.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
