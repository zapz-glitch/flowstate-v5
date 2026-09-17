import { ArrowRight } from 'lucide-react'

const INSIGHTS_BASE =
  process.env.NEXT_PUBLIC_INSIGHTS_URL ?? 'https://insights.flowstate.homes'

const SECTIONS = [
  {
    href: `${INSIGHTS_BASE}/insights`,
    label: 'Insights',
    title: 'Guides for sellers and operators',
    body: 'Practical answers on selling as-is, timelines, repairs, and cash offers — written from real deal flow.',
  },
  {
    href: `${INSIGHTS_BASE}/research`,
    label: 'Research',
    title: 'What the data says',
    body: 'Analysis of our own acquisitions and market data: cash share, days on market, repair economics.',
  },
  {
    href: `${INSIGHTS_BASE}/markets`,
    label: 'Markets',
    title: 'Where we buy',
    body: 'Local market snapshots — median days on market, cash share, and what we pay attention to in each.',
  },
]

export function Insights() {
  return (
    <section id="insights" className="bg-background border-b border-border scroll-mt-28 md:scroll-mt-24">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <div className="flex items-end justify-between mb-10 sm:mb-14">
          <div>
            <p className="mono-label mb-4">04 / Insights</p>
            <h2 className="text-3xl sm:text-4xl font-sans font-medium tracking-[-0.03em] text-foreground leading-tight max-w-2xl">
              Research and market notes.
            </h2>
          </div>
          <a
            href={INSIGHTS_BASE}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:block"
          >
            insights.flowstate.homes →
          </a>
        </div>

        <div className="grid sm:grid-cols-3 gap-px bg-border border border-border">
          {SECTIONS.map((s) => (
            <a
              key={s.href}
              href={s.href}
              className="group bg-background p-6 sm:p-8 hover:bg-secondary/40 transition-colors block"
            >
              <p className="mono-label !text-[10px] mb-4">{s.label}</p>
              <h3 className="text-lg font-medium text-foreground mb-2 group-hover:underline underline-offset-4 decoration-border">
                {s.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{s.body}</p>
              <p className="mono-label !text-[10px] mt-6 inline-flex items-center gap-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                Explore <ArrowRight className="h-3 w-3" />
              </p>
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}
