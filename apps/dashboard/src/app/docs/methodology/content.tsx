import { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'

export interface MethodologySection {
  id: string
  title: string
  content: ReactNode
}

function SectionProse({ children }: { children: ReactNode }) {
  return <div className="space-y-5 text-base text-foreground-secondary leading-relaxed">{children}</div>
}

function DataTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-secondary/50">
            {headers.map((h, i) => (
              <th key={i} className="text-left px-4 py-3 text-xs font-semibold text-foreground-tertiary uppercase tracking-wider">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 text-sm text-foreground-secondary">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="rounded-xl border border-border bg-secondary/50 p-5 overflow-x-auto text-sm font-mono text-foreground-secondary leading-relaxed">
      {children}
    </pre>
  )
}

export const METHODOLOGY_SECTIONS: MethodologySection[] = [
  {
    id: 'property-classification',
    title: 'Property Classification',
    content: (
      <SectionProse>
        <p>
          Every property analyzed is classified into one of two categories. This classification
          drives the entire valuation strategy — determining which comps are weighted most heavily
          and which investment scenarios are generated.
        </p>

        <DataTable
          headers={['Classification', 'Description', 'Use Case']}
          rows={[
            ['As-Is', 'Distressed property needing work — outdated fixtures, visible damage, deferred maintenance', 'Current market value / wholesale'],
            ['After-Renovation', 'Recently renovated, turnkey condition — modern finishes, updated systems', 'Target ARV for flips'],
          ]}
        />

        <h4 className="text-lg font-semibold text-foreground pt-2">Classification Method</h4>

        <p>
          Classification is determined by scanning the MLS listing description for
          investment-related keywords (58 as-is keywords, 57 after-renovation keywords):
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2 text-sm">
          <li><Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-600 border-orange-500/30">As-Is</Badge> &quot;investor special&quot;, &quot;handyman special&quot;, &quot;fixer upper&quot;, &quot;needs work&quot;, &quot;as-is&quot;, &quot;estate sale&quot;, &quot;distressed&quot;, &quot;diamond in the rough&quot;</li>
          <li><Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 border-emerald-500/30">After-Reno</Badge> &quot;move-in ready&quot;, &quot;fully renovated&quot;, &quot;turnkey&quot;, &quot;new kitchen&quot;, &quot;stainless steel&quot;, &quot;granite&quot;, &quot;open concept&quot;, &quot;like new&quot;</li>
        </ul>
        <p>
          Keywords are grouped into <strong className="text-foreground">strong</strong> and <strong className="text-foreground">supporting</strong> tiers.
          A strong match on one side with no opposing strong signals yields <strong className="text-foreground">high</strong> confidence.
          Supporting-only matches yield <strong className="text-foreground">medium</strong> confidence. No matches yields <strong className="text-foreground">low</strong> confidence (neutral).
        </p>

      </SectionProse>
    ),
  },
  {
    id: 'appraisal-filters',
    title: 'Appraisal Filters',
    content: (
      <SectionProse>
        <p>
          Filters determine which comparable sales &quot;pass&quot; the appraisal criteria. A comp that
          fails <strong className="text-foreground">any</strong> enabled filter is disabled from the
          valuation. All filters are fully configurable via <strong className="text-foreground">Appraisal Presets</strong> in
          Evaluation Settings, and different presets can be assigned per market using Location Overrides.
        </p>

        <DataTable
          headers={['Filter', 'Default', 'Unit', 'Description']}
          rows={[
            ['Subdivision Match', 'Enabled', '—', 'Comp must be in the same subdivision as subject (normalized comparison; passes if either subdivision is missing)'],
            ['Sale Age', '30', 'days', 'Maximum days since the comparable sold (fails if sale date is missing)'],
            ['Sqft Difference', '250', 'sqft', 'Maximum absolute square footage difference from subject (passes if subject sqft is missing; fails if comp sqft is missing)'],
            ['Year Built Diff', '10', 'years', 'Maximum year-built difference from subject (passes if either year is missing)'],
            ['Distance', '0.5', 'miles', 'Maximum distance from subject property (passes if distance is unavailable)'],
          ]}
        />

        <h4 className="text-lg font-semibold text-foreground pt-2">Three-Pass Evaluation</h4>
        <p>
          Comps are evaluated in three passes from strictest to most relaxed. The system stops at
          the first pass that yields at least one comp and selects the best 3 from that pass for ARV.
        </p>

        <h4 className="text-base font-semibold text-foreground pt-3">Pass 1 — Full Filters (subdivision + all rules)</h4>
        <ul className="list-disc list-inside space-y-1.5 ml-2 text-sm">
          <li>All enabled filters apply including subdivision match.</li>
          <li>If <strong className="text-foreground">1 or more</strong> comps pass, the best 3 are selected (subdivision match first, then highest filter-pass rate, then closest distance).</li>
          <li>Confidence: <strong className="text-foreground">3+ comps → 90</strong>, 2 comps → 70, 1 comp → 55.</li>
          <li><code className="text-xs px-1 py-0.5 rounded bg-secondary text-foreground">fallbackUsed: &quot;none&quot;</code></li>
        </ul>

        <h4 className="text-base font-semibold text-foreground pt-3">Pass 2 — Relax Subdivision</h4>
        <p>
          If Pass 1 yields zero comps, subdivision match is disabled. All other filters remain active.
          Best 3 comps selected by most non-subdivision rules passed, then closest distance.
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2 text-sm">
          <li>Confidence: <strong className="text-foreground">3+ comps → 65</strong>, 2 comps → 50, 1 comp → 40.</li>
          <li><code className="text-xs px-1 py-0.5 rounded bg-secondary text-foreground">fallbackUsed: &quot;no_subdivision&quot;</code></li>
        </ul>

        <h4 className="text-base font-semibold text-foreground pt-3">Pass 3 — Relaxed Thresholds</h4>
        <p>
          If Pass 2 yields zero comps, all numeric filter thresholds are tripled (sale age, sqft diff,
          year built diff, distance) and subdivision match remains disabled. Best 3 selected by same rule-match scoring.
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2 text-sm">
          <li>Confidence: <strong className="text-foreground">3+ comps → 35</strong>, 2 comps → 25, 1 comp → 20.</li>
          <li><code className="text-xs px-1 py-0.5 rounded bg-secondary text-foreground">fallbackUsed: &quot;relaxed_filters&quot;</code></li>
        </ul>

        <h4 className="text-base font-semibold text-foreground pt-3">No Comps</h4>
        <p>
          If all three passes return zero comps, confidence is 0 and manual review is required.{' '}
          <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">fallbackUsed: &quot;no_comps&quot;</code>
        </p>
      </SectionProse>
    ),
  },
  {
    id: 'price-adjustments',
    title: 'Price Adjustments',
    content: (
      <SectionProse>
        <p>
          After filtering, each comparable&apos;s sale price is adjusted to account for differences
          from the subject property. Adjustments are applied to all comps (including disabled ones
          for reference). The adjusted price better represents what the subject would sell for
          based on that comp.
        </p>

        <DataTable
          headers={['Adjustment', 'Default', 'Enabled', 'Formula']}
          rows={[
            ['Old Comp Discount', '15% max', 'Yes', 'Only applied if sale >90 days old. Scales linearly: discount% = min(15%, 15% × monthsOld / 12)'],
            ['Bedroom', '$15,000/bed', 'Yes', '(subject beds − comp beds) × $15,000'],
            ['Bathroom', '$10,000/bath', 'Yes', '(subject baths − comp baths) × $10,000'],
            ['Pool', '$10,000', 'No (disabled)', 'Added if subject has a pool (based on poolType)'],
            ['Garage', '$10,000', 'No (disabled)', 'Added if subject has a garage (based on garageType or garageSquareFeet)'],
          ]}
        />

        <h4 className="text-lg font-semibold text-foreground pt-2">Calculation</h4>
        <CodeBlock>{`Adjusted Price = Original Sale Price + Sum(All Applied Adjustments)

Example:
  Comp sold for $300,000, 6 months ago (180 days)
  Subject has 1 more bedroom than comp: +$15,000
  Old comp discount: min(15%, 15% × 6/12) = 7.5% → −$22,500
  Adjusted Price = $300,000 + $15,000 − $22,500 = $292,500`}</CodeBlock>

        <p>
          If a comp&apos;s sale price is unavailable, it is calculated from{' '}
          <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">pricePerSqft × squareFeet</code> as a fallback.
        </p>
      </SectionProse>
    ),
  },
  {
    id: 'arv-calculation',
    title: 'ARV Calculation',
    content: (
      <SectionProse>
        <p>
          The After-Repair Value (ARV) is calculated from up to 3 selected comparables. Each comp
          contributes an adjusted price-per-sqft value; those are averaged and multiplied by the
          subject property&apos;s square footage.
        </p>

        <CodeBlock>{`Per-comp ARV = (adjustedPrice / compSqft) × subjectSqft
ARV          = avg(per-comp ARV) across up to 3 selected comps`}</CodeBlock>

        <p>
          If a comp&apos;s adjusted price is not available, the original sale price is used.
          If subject sqft is missing, each comp&apos;s own sqft is used as the multiplier instead.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Best Comp Selection</h4>
        <p>
          From the comps that pass the active filter pass, up to 3 are selected using this priority order:
        </p>
        <ol className="list-decimal list-inside space-y-1.5 ml-2 text-sm">
          <li><strong className="text-foreground">Subdivision match</strong> — comps in the same subdivision are always preferred</li>
          <li><strong className="text-foreground">Filter pass rate</strong> — comp that satisfies more active filter rules ranks higher</li>
          <li><strong className="text-foreground">Distance</strong> — among ties, the closest comp wins</li>
        </ol>
        <p className="text-sm">
          In fallback passes (Pass 2 and 3), subdivision match is excluded from scoring and only
          the non-subdivision rules are counted for the filter pass rate.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Classification Group Averages</h4>
        <p>
          After ARV is calculated, all enabled comps are grouped by classification for display
          purposes. These group averages are informational only — they do not affect the ARV itself.
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2">
          <li><strong className="text-foreground">As-Is Value</strong> — Simple average adjusted price of as-is comps (current market value)</li>
          <li><strong className="text-foreground">After-Renovation Value</strong> — Simple average adjusted price of after-renovation comps</li>
          <li><strong className="text-foreground">Spread</strong> — After-Renovation Value − As-Is Value (potential upside)</li>
        </ul>
      </SectionProse>
    ),
  },
  {
    id: 'valuation-recommendations',
    title: 'Valuation & Recommendations',
    content: (
      <SectionProse>
        <p>
          The final valuation calculates concrete investment metrics — rehab costs, buy price,
          projected profit, and a recommendation score — using your configured deal parameters
          and rehab pricing.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Rehab Level Selection</h4>
        <p>
          There are 7 rehab levels covering the full spectrum from light cosmetic touch-ups to complete
          gut renovations. Select the level that matches the subject property&apos;s condition. Per-sqft
          rates and minimum profit targets are fully configurable in{' '}
          <strong className="text-foreground">Evaluation Settings → Renovation Levels</strong>.
        </p>
        <DataTable
          headers={['Index', 'Level', '≤$501k', '$501k–$999k', '$1M–$3M', '>$3M']}
          rows={[
            ['0', 'Lipstick', '$25/sqft, $30k min', '$30/sqft, $50k min', '$60/sqft, $100k min', '$80/sqft, $150k min'],
            ['1', 'Light Cosmetic', '$30/sqft, $40k min', '$40/sqft, $60k min', '$65/sqft, $100k min', '$90/sqft, $150k min'],
            ['2', 'Full Cosmetic', '$35/sqft, $40k min', '$45/sqft, $60k min', '$70/sqft, $100k min', '$100/sqft, $150k min'],
            ['3', 'Heavy Rehab', '$45/sqft, $50k min', '$55/sqft, $70k min', '$80/sqft, $100k min', '$110/sqft, $150k min'],
            ['4', 'Down to Stud', '$60/sqft, $50k min', '$75/sqft, $70k min', '$100/sqft, $100k min', '$120/sqft, $150k min'],
            ['5', 'Low Cost Market', '$40/sqft, $30k min', '$50/sqft, $60k min', '$75/sqft, $100k min', '$105/sqft, $150k min'],
            ['6', 'High Cost Market', '$50/sqft, $40k min', '$60/sqft, $70k min', '$85/sqft, $100k min', '$115/sqft, $150k min'],
          ]}
        />

        <h4 className="text-lg font-semibold text-foreground pt-2">Major Item Costs</h4>
        <p>
          In addition to the per-sqft rehab estimate, major system replacements are flagged and
          costed separately based on property age. Items are triggered when the property&apos;s age
          meets or exceeds the item&apos;s age threshold. All 17 items have configurable costs in{' '}
          <strong className="text-foreground">Evaluation Settings → Major Items</strong>.
        </p>
        <DataTable
          headers={['Item', 'Default Cost', 'Age Trigger', 'Notes']}
          rows={[
            ['Roof', '$10,000', '20 yrs', 'Triggered by property age'],
            ['HVAC', '$8,000', '15 yrs', 'Triggered by property age'],
            ['Water Heater', '$2,500', '10 yrs', 'Triggered by property age'],
            ['Electric Panel', '$3,500', '30 yrs', 'Triggered by property age'],
            ['Re-Plumb', '$8,000', '40 yrs', 'Triggered by property age'],
            ['Re-Wire', '$8,000', '40 yrs', 'Triggered by property age'],
            ['Foundation', '$12,000', '—', 'Manual flag only'],
            ['Sinkhole', '$15,000', '—', 'Manual flag only'],
            ['Septic Repair', '$5,000', '25 yrs', 'Triggered by property age'],
            ['New Septic', '$15,000', '—', 'Manual flag only'],
            ['Pool Redone', '$15,000', '—', 'Manual flag only'],
            ['Pool Plaster', '$5,000', '10 yrs', 'Triggered by property age'],
            ['Termite', '$3,000', '—', 'Manual flag only'],
            ['Mold', '$5,000', '—', 'Manual flag only'],
            ['Asbestos', '$10,000', '—', 'Manual flag only'],
            ['Replace Vinyl', '$5,000', '20 yrs', 'Triggered by property age'],
            ['Well Pump', '$4,000', '15 yrs', 'Triggered by property age'],
          ]}
        />

        <CodeBlock>{`Total Rehab = (subjectSqft × perSqft rate) + Σ(triggered major items) + additionPlay`}</CodeBlock>

        <h4 className="text-lg font-semibold text-foreground pt-2">Deal Parameters</h4>
        <p>
          Investment metrics are calculated using your deal parameters, configurable in{' '}
          <strong className="text-foreground">Evaluation Settings → Deal Parameters</strong>.
          System defaults are:
        </p>
        <DataTable
          headers={['Parameter', 'Default', 'Description']}
          rows={[
            ['Closing Costs', '10%', 'Percentage of ARV for transaction costs (agent fees, title, taxes)'],
            ['Carrying Costs', '5%', 'Percentage of ARV for holding costs during renovation (insurance, utilities, loan interest)'],
            ['Wholesale Fee', '$10,000', 'Deducted from buy price to calculate the assignable wholesale price'],
            ['Min Profit Override', 'Tier default', 'Override the minimum profit target from the rehab tier table; blank uses tier default'],
          ]}
        />

        <h4 className="text-lg font-semibold text-foreground pt-2">Investment Metrics</h4>
        <CodeBlock>{`Buy Price        = ARV − Rehab − (ARV × Closing%) − (ARV × Carrying%) − Profit Target
Wholesale Price  = Buy Price − Wholesale Fee
Total Investment = Buy Price + Total Rehab Cost
Projected Profit = ARV − Total Investment − (ARV × Closing%) − (ARV × Carrying%)
ROI              = (Projected Profit / Total Investment) × 100`}</CodeBlock>

        <h4 className="text-lg font-semibold text-foreground pt-2">Recommendation Thresholds</h4>
        <DataTable
          headers={['Recommendation', 'ROI', 'Buy Price % of ARV', 'Interpretation']}
          rows={[
            ['Strong Buy', '> 25%', '< 65%', 'Excellent deal — both conditions must be met'],
            ['Buy', '> 15%', '< 75%', 'Good deal — both conditions must be met'],
            ['Hold', '> 8% or', '< 80%', 'Moderate — either condition qualifies; consider negotiating'],
            ['Pass', '≤ 8%', '≥ 80%', 'Low ROI or high buy price — neither threshold met'],
          ]}
        />
      </SectionProse>
    ),
  },
  {
    id: 'evaluation-settings',
    title: 'Evaluation Settings',
    content: (
      <SectionProse>
        <p>
          Every component of the analysis pipeline is fully configurable per user. Settings are
          applied in a strict priority order — the most specific setting wins. Configure everything
          in the <strong className="text-foreground">Evaluation Settings</strong> dashboard.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Appraisal Rule Presets</h4>
        <p>
          Create named presets with custom filter thresholds and adjustment amounts. Mark one preset
          as your account default, or assign different presets to specific markets via Location
          Overrides. Each preset independently configures all five filters and all five adjustments.
          Presets are shared across all analyses unless overridden at the request or location level.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Renovation Levels</h4>
        <p>
          The rehab pricing table has 7 levels × 4 ARV tiers = 28 cells. Each cell stores a
          per-sqft cost and a minimum profit target. Customize every cell to match your market&apos;s
          actual labor and material costs. Changes take effect on the next analysis. Reset to system
          defaults at any time without affecting other settings.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Deal Parameters</h4>
        <p>
          Set your default closing cost %, carrying cost %, wholesale fee, and optional minimum
          profit override. These feed directly into every buy price and ROI calculation. Explicit
          values passed in the API request body always take precedence over account defaults.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Major Items</h4>
        <p>
          Override the repair cost for any of the 17 tracked major systems. Set a custom dollar
          amount per item; blank entries use the system default. Costs are applied when the system
          is flagged as aging (property age ≥ age threshold) or manually flagged via the API.
          Per-market overrides are also supported via Location Overrides.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Location Overrides</h4>
        <p>
          Override any combination of appraisal preset, rehab pricing, deal parameters, and major
          item costs for a specific market. When a property address matches a location override,
          that market&apos;s settings take precedence over your account defaults.
        </p>
        <p>
          Override granularity follows a strict priority chain — the most specific match always wins:
        </p>
        <div className="flex items-center gap-2 flex-wrap text-sm font-medium">
          {(['Zip Code', 'City + State', 'State', 'Account Defaults', 'System Defaults'] as const).map((label, i, arr) => (
            <span key={label} className="flex items-center gap-2">
              <span className={`px-2.5 py-1 rounded-md font-semibold text-xs ${i < arr.length - 2 ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>
                {label}
              </span>
              {i < arr.length - 1 && <span className="text-muted-foreground/50">›</span>}
            </span>
          ))}
        </div>
        <p className="text-sm">
          Each setting is resolved independently — a zip override can set only deal parameters while
          inheriting rehab pricing from a state override, which in turn inherits the appraisal preset
          from your account default. Unset fields at any level simply fall through to the next level.
        </p>
        <DataTable
          headers={['Scope', 'Example', 'When to use']}
          rows={[
            ['State', 'FL', 'Broad market adjustments — different cost-of-living, state-specific fees'],
            ['City + State', 'Miami, FL', 'City-level markets with distinct labor costs or deal dynamics'],
            ['Zip Code', '33101', 'Hyper-local overrides — premium neighborhoods, rural markets, flood zones'],
          ]}
        />

        <p className="text-sm">
          City matching is case-insensitive (stored lowercase). State matching uses 2-letter uppercase codes.
          Both city and state must match simultaneously for a city-level override to apply.
        </p>
      </SectionProse>
    ),
  },
  {
    id: 'analysis-flow',
    title: 'End-to-End Analysis Flow',
    content: (
      <SectionProse>
        <p>
          The complete analysis pipeline processes a property address through multiple stages
          using Cloudflare Workflows for durable orchestration and Durable Objects for job state
          management and SSE streaming.
        </p>

        <div className="rounded-xl border border-border bg-secondary/30 p-6 space-y-4 font-mono text-sm text-foreground-secondary">
          <div className="flex items-center gap-3">
            <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">1</span>
            <span><strong className="text-foreground font-sans">Input</strong> — POST /v1/analyze with property address + optional appraisal preset / buybox overrides</span>
          </div>
          <div className="border-l-2 border-border ml-3.5 pl-6 space-y-4">
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">2</span>
              <span><strong className="text-foreground font-sans">Settings Resolution</strong> — Load user&apos;s appraisal preset, rehab table, deal params, major item costs; apply location override if address matches (zip › city+state › state)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">3</span>
              <span><strong className="text-foreground font-sans">Property Bundle</strong> — Fetch subject + up to 10 comps + enrichment data from CoreLogic API (2–10s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">4</span>
              <span><strong className="text-foreground font-sans">Appraisal Rules</strong> — Evaluate filters + adjustments using 3-pass fallback; select best 3 by subdivision match → filter pass rate → distance (&lt;1s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">5</span>
              <span><strong className="text-foreground font-sans">Photo &amp; Data Fetch</strong> — Scrape Zillow via Firecrawl for subject + enabled comps (up to 10); supplement missing CoreLogic fields (beds, baths, sqft, year built) (2–5s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">6</span>
              <span><strong className="text-foreground font-sans">Classification</strong> — Classify subject + all comps via MLS keyword analysis in parallel (&lt;1s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">7</span>
              <span><strong className="text-foreground font-sans">ARV</strong> — avg(adjusted price/sqft of top 3 comps) × subject sqft; group by classification (&lt;1s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">8</span>
              <span><strong className="text-foreground font-sans">Investment Scenarios</strong> — Generate flip, wholesale, and rental strategies with confidence scores (&lt;1s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">9</span>
              <span><strong className="text-foreground font-sans">Valuation</strong> — Estimate rehab costs (sqft rate + major items), compute buy price, profit, ROI using resolved deal params (&lt;1s)</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-7 h-7 rounded-md bg-emerald-500/20 text-emerald-500 flex items-center justify-center text-xs font-bold flex-shrink-0">10</span>
            <span><strong className="text-foreground font-sans">Output</strong> — Subject details, ARV, comp quality scores, investment scenarios, risk flags (~10–15s total)</span>
          </div>
        </div>

        <h4 className="text-lg font-semibold text-foreground pt-2">Settings Resolution Order</h4>
        <p>
          Before analysis begins, the system resolves which settings to use by walking the priority chain.
          Each of the four setting categories (appraisal preset, rehab table, deal params, major item costs)
          is resolved independently:
        </p>
        <CodeBlock>{`request body buybox fields             ← highest priority, always wins
  └─ location override (zip match)
       └─ location override (city+state match)
            └─ location override (state match)
                 └─ user account defaults
                      └─ system defaults   ← lowest priority

Applied independently per setting type:
  appraisal preset  → first non-null value in chain
  rehab table       → first non-null value in chain
  deal params       → merged (lower priority fills missing fields)
  major item costs  → merged (lower priority fills missing items)`}</CodeBlock>

        <h4 className="text-lg font-semibold text-foreground pt-2">Async Processing &amp; Real-Time Updates</h4>
        <p>
          Analysis runs asynchronously via Cloudflare Workflows with automatic retries (3 attempts,
          exponential backoff). The client receives a job ID immediately and tracks progress via:
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2">
          <li><strong className="text-foreground">Server-Sent Events (SSE)</strong> — Real-time step progress via Durable Object. Requires a short-lived signed token from <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">POST /v1/analyze/stream-token</code>.</li>
          <li><strong className="text-foreground">HTTP Polling</strong> — <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">GET /v1/analyze/jobs/:jobId?propertyKey=...</code> returns current state and result when complete.</li>
        </ul>
        <p>
          Each workflow step emits progress events (<code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">step_started</code>, <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">step_completed</code>, <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">cache_hit</code>),
          allowing the dashboard to show a live progress stepper during analysis.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Zillow Data Fetch &amp; Supplementation</h4>
        <p>
          After appraisal filtering, Zillow is scraped via Firecrawl for the subject property and
          up to 10 enabled comps (disabled comps are skipped). Zillow data is used to fill in any
          CoreLogic gaps — bedrooms, bathrooms, sqft, year built, last sale date/price, and
          foundation type. The response&apos;s <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">dataSupplemented</code> field
          tracks every field that was filled from Zillow with its source for full transparency.
          Zillow responses are cached for 24 hours per property to minimize Firecrawl API usage.
        </p>
      </SectionProse>
    ),
  },
]
