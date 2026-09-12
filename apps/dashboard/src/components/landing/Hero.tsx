import { ArrowRight } from 'lucide-react'

const STATS = [
  { value: '21 days', label: 'or less to close' },
  { value: '100%', label: 'as-is purchases' },
  { value: 'Cash', label: 'every offer' },
]

export function Hero() {
  return (
    <section className="relative pt-32 sm:pt-44 pb-16 sm:pb-24 bg-background border-b border-border snap-start">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <p className="mono-label mb-6 sm:mb-8">Flowstate | Private real estate investment</p>

        <h1 className="text-4xl sm:text-6xl lg:text-7xl font-sans font-medium tracking-[-0.03em] text-foreground leading-[1.02] max-w-4xl">
          We buy houses as-is.
          <br />
          <span className="text-[#4C8DFF]">Cash. Closed in 21 days.</span>
        </h1>

        <p className="mt-6 sm:mt-8 text-base sm:text-lg text-muted-foreground max-w-xl leading-relaxed">
          Flowstate acquires original condition, distressed, and non-financeable
          properties. We work with realtors, wholesalers, and investors who need
          a certain close, not a maybe.
        </p>

        <div className="mt-8 sm:mt-10 flex flex-col sm:flex-row gap-3 sm:items-center">
          <a
            href="#contact"
            className="inline-flex items-center justify-center gap-2 py-3 px-6 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 active:scale-[0.98] transition-all duration-150"
          >
            <span>Submit a deal</span>
            <ArrowRight className="h-4 w-4" />
          </a>
          <a
            href="#process"
            className="inline-flex items-center justify-center gap-2 py-3 px-6 border border-border text-foreground font-medium rounded-full hover:bg-secondary/60 active:scale-[0.98] transition-all duration-150"
          >
            <span>How we work</span>
          </a>
        </div>

        <div className="mt-14 sm:mt-20 grid grid-cols-3 border border-border divide-x divide-border">
          {STATS.map((stat) => (
            <div key={stat.label} className="px-3 py-5 sm:px-6 sm:py-7 text-center sm:text-left">
              <p className="text-xl sm:text-3xl font-medium tracking-tight text-foreground">
                {stat.value}
              </p>
              <p className="mono-label !text-[10px] mt-1.5">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
