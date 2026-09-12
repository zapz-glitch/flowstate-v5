import { cn } from '@/lib/utils'

const STEPS = [
  {
    index: '01',
    title: 'Submit',
    body: 'Send the address and a honest read on condition. Two minutes, no package required.',
  },
  {
    index: '02',
    title: 'Evaluate',
    body: 'We pull comps and run our own underwriting. Most decisions come back within 24 hours.',
  },
  {
    index: '03',
    title: 'Offer',
    body: 'A firm cash number in writing. No obligation, no games, no retrade at the closing table.',
  },
  {
    index: '04',
    title: 'Close',
    body: '21 days or less, and the seller picks the date. We cover standard closing costs.',
  },
]

// Flush hairlines: stack on mobile (bottom borders), 2x2 at sm, 1x4 at lg
const CELL_BORDERS = [
  'border-b sm:border-r lg:border-b-0',
  'border-b lg:border-b-0 lg:border-r',
  'border-b sm:border-b-0 sm:border-r',
  '',
]

export function Process() {
  return (
    <section id="process" className="bg-background border-b border-border scroll-mt-28 md:scroll-mt-24 snap-start">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <p className="mono-label mb-4">02 / Process</p>
        <h2 className="text-3xl sm:text-4xl font-sans font-medium tracking-[-0.03em] text-foreground leading-tight max-w-2xl mb-10 sm:mb-14">
          From address to answer in 24 hours.
        </h2>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 border border-border">
          {STEPS.map((step, i) => (
            <div key={step.index} className={cn('p-6 sm:p-8 border-border', CELL_BORDERS[i])}>
              <p className="mono-label !text-[10px] mb-4">{step.index}</p>
              <h3 className="text-lg font-medium text-foreground mb-2">{step.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
