import { DealForm } from './DealForm'

export function CtaSection() {
  return (
    <section id="contact" className="bg-background scroll-mt-28 md:scroll-mt-24 snap-start">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-20 sm:py-28">
        <div className="max-w-xl mx-auto">
          <p className="mono-label mb-6">04 / Contact</p>
          <h2 className="text-3xl sm:text-5xl font-sans font-medium tracking-[-0.03em] text-foreground leading-tight mb-5">
            Have a property that fits?
          </h2>
          <p className="text-base sm:text-lg text-muted-foreground leading-relaxed mb-8">
            Send the address and condition. You will hear back within 24 hours.
          </p>
          <DealForm />
        </div>
      </div>
    </section>
  )
}
