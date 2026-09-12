const CRITERIA = [
  {
    index: '01',
    title: 'Original condition',
    body: 'Homes that have not been updated in decades. Dated kitchens and baths are exactly what we are looking for.',
  },
  {
    index: '02',
    title: 'As-is',
    body: 'No repairs, no clean-out, no contingencies. The seller walks away from the property exactly as it sits.',
  },
  {
    index: '03',
    title: 'Distressed',
    body: 'Deferred maintenance, code violations, failed systems, fire or water damage. Problems are priced in, not avoided.',
  },
  {
    index: '04',
    title: 'Non-financeable',
    body: 'Properties conventional lenders will not touch. Cash means the condition never kills the deal.',
  },
]

export function WhatWeBuy() {
  return (
    <section id="what-we-buy" className="bg-background border-b border-border">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <p className="mono-label mb-4">01 / What we buy</p>
        <h2 className="text-3xl sm:text-4xl font-sans font-medium tracking-[-0.03em] text-foreground leading-tight max-w-2xl mb-10 sm:mb-14">
          The harder the property, the better the fit.
        </h2>

        <div className="grid sm:grid-cols-2 border border-border rounded-lg overflow-hidden divide-y divide-border sm:divide-y-0">
          {CRITERIA.map((item, i) => (
            <div
              key={item.index}
              className={
                'p-6 sm:p-8 bg-background ' +
                (i % 2 === 0 ? 'sm:border-r ' : '') +
                (i < 2 ? 'sm:border-b ' : '') +
                'border-border'
              }
            >
              <p className="mono-label !text-[10px] mb-4">{item.index}</p>
              <h3 className="text-lg font-medium text-foreground mb-2">{item.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
