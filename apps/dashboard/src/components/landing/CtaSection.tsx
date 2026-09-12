import { ArrowRight } from 'lucide-react'

export function CtaSection() {
  return (
    <section id="contact" className="bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-20 sm:py-28 text-center">
        <p className="mono-label mb-6">04 / Contact</p>
        <h2 className="text-3xl sm:text-5xl font-sans font-medium tracking-[-0.03em] text-foreground leading-tight max-w-3xl mx-auto">
          Have a property that fits?
        </h2>
        <p className="mt-5 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
          Send the address and condition. You will hear back within 48 hours.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href="mailto:hello@flowstate.homes?subject=Deal%20submission"
            className="inline-flex items-center justify-center gap-2 py-3 px-6 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 transition-colors"
          >
            <span>Submit a deal</span>
            <ArrowRight className="h-4 w-4" />
          </a>
          <a
            href="mailto:hello@flowstate.homes"
            className="inline-flex items-center justify-center gap-2 py-3 px-6 border border-border text-foreground font-medium rounded-full hover:bg-secondary/60 transition-colors"
          >
            <span>hello@flowstate.homes</span>
          </a>
        </div>
      </div>
    </section>
  )
}
