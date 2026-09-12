import { cn } from '@/lib/utils'

const AUDIENCES = [
  {
    index: '01',
    title: 'Realtors',
    body: 'Bring us the listings retail buyers pass on. Your seller gets a certain close, you keep your full commission, and you look like the agent who had an answer.',
  },
  {
    index: '02',
    title: 'Wholesalers',
    body: 'A dependable end buyer for your deals. Fast decisions, quick closes, and a number that does not move once we sign.',
  },
  {
    index: '03',
    title: 'Investors',
    body: 'We acquire for our own portfolio and for a network that underwrites with speed and accuracy. Buy-and-hold, fix-and-flip, and wholesale exits.',
  },
]

// Flush hairlines: stack on mobile, 3 columns at sm and up
const CELL_BORDERS = [
  'border-b sm:border-b-0 sm:border-r',
  'border-b sm:border-b-0 sm:border-r',
  '',
]

export function WhoWeWorkWith() {
  return (
    <section id="network" className="bg-background border-b border-border scroll-mt-20 snap-start">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <p className="mono-label mb-4">03 / Who we work with</p>
        <h2 className="text-3xl sm:text-4xl font-sans font-medium tracking-[-0.03em] text-foreground leading-tight max-w-2xl mb-10 sm:mb-14">
          Built for the people who find the deals.
        </h2>

        <div className="grid sm:grid-cols-3 border border-border">
          {AUDIENCES.map((audience, i) => (
            <div key={audience.index} className={cn('p-6 sm:p-8 border-border', CELL_BORDERS[i])}>
              <p className="mono-label !text-[10px] mb-4">{audience.index}</p>
              <h3 className="text-lg font-medium text-foreground mb-2">{audience.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{audience.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
