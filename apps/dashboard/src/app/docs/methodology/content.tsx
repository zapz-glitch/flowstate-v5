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

        <h4 className="text-lg font-semibold text-foreground pt-2">Classification Methods (Priority Order)</h4>

        <p>
          The system uses a priority-based decision tree, starting with the most accurate method
          and falling back through progressively less reliable approaches.
        </p>

        <p>
          <strong className="text-foreground">1. Vision Analysis (Photos + LLM)</strong> — Preferred method.
          When property photos are available, we send up to 10 photos per property to a vision LLM
          (Gemini 2.0 Flash via OpenRouter). The model assesses condition score (0–100),
          renovation level (none / cosmetic / partial / full), and visual indicators. Returns a
          confidence score from 0–100%.
        </p>

        <p>
          <strong className="text-foreground">2. Description Keywords</strong> — Used when photos are
          unavailable or when vision confidence is low. Scans MLS listing descriptions for
          investment-related keywords (58 as-is keywords, 57 after-renovation keywords):
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2 text-sm">
          <li><Badge variant="outline" className="text-xs bg-orange-500/10 text-orange-600 border-orange-500/30">As-Is</Badge> &quot;investor special&quot;, &quot;handyman special&quot;, &quot;fixer upper&quot;, &quot;needs work&quot;, &quot;as-is&quot;, &quot;estate sale&quot;, &quot;distressed&quot;, &quot;diamond in the rough&quot;</li>
          <li><Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 border-emerald-500/30">After-Reno</Badge> &quot;move-in ready&quot;, &quot;fully renovated&quot;, &quot;turnkey&quot;, &quot;new kitchen&quot;, &quot;stainless steel&quot;, &quot;granite&quot;, &quot;open concept&quot;, &quot;like new&quot;</li>
        </ul>
        <p>
          Each keyword scores 15 base points, with strong indicators (e.g. &quot;investor special&quot;, &quot;turnkey&quot;)
          receiving a +20 bonus. Confidence is boosted +15 if 3+ keywords match (max 95%).
        </p>

        <p>
          <strong className="text-foreground">3. Price Analysis</strong> — Fallback when description is
          inconclusive (confidence &lt; 60%). Compares the property&apos;s price/sqft against the area average:
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2 text-sm">
          <li>Price/sqft ≤ 85% of area average → <strong className="text-foreground">As-Is</strong> (below market = distressed)</li>
          <li>Price/sqft ≥ 115% of area average → <strong className="text-foreground">After-Renovation</strong> (premium = renovated)</li>
          <li>Between 85–115% → defaults conservatively to As-Is (confidence 45%)</li>
        </ul>

        <p>
          <strong className="text-foreground">4. Combined Result</strong> — When multiple methods are
          available, they&apos;re weighted: primary source 70% + secondary source 30%. If both methods
          agree, confidence is boosted +10. If they disagree, confidence is reduced −15 (min 30%).
        </p>

        <p>
          <strong className="text-foreground">5. Default Fallback</strong> — When no data is available,
          the system conservatively defaults to <strong className="text-foreground">As-Is</strong> with 30% confidence.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Batch Classification</h4>
        <p>
          To optimize performance, subject + all comps are classified in 1–2 batched LLM calls
          (instead of 11 separate calls). Properties with photos are batched separately from
          text-only properties, with up to 6 properties per batch and 3 photos per property.
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
          valuation. All filters are configurable via appraisal presets.
        </p>

        <DataTable
          headers={['Filter', 'Default', 'Unit', 'Description']}
          rows={[
            ['Subdivision Match', 'Enabled', '—', 'Comp must be in the same subdivision as subject (normalized comparison; passes if either subdivision is missing)'],
            ['Sale Age', '30', 'days', 'Maximum days since the comparable sold (fails if sale date is missing)'],
            ['Sqft Difference', '250', 'sqft', 'Maximum absolute square footage difference from subject'],
            ['Year Built Diff', '10', 'years', 'Maximum year-built difference from subject (passes if either year is missing)'],
            ['Distance', '0.5', 'miles', 'Maximum distance from subject property (passes if distance is unavailable)'],
          ]}
        />

        <h4 className="text-lg font-semibold text-foreground pt-2">3-Step Fallback Strategy</h4>
        <p>
          If fewer than 3 comparables pass all filters, the system applies a progressive fallback
          to ensure a valuation is always produced:
        </p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li><strong className="text-foreground">Full filters</strong> — Try with all filters enabled including subdivision match</li>
          <li><strong className="text-foreground">Relax subdivision</strong> — If &lt; 3 comps pass, disable subdivision match and retry all comps</li>
          <li><strong className="text-foreground">Nearest comps</strong> — If still &lt; 3 comps pass, select the 5 nearest comps by distance regardless of other filter results</li>
        </ol>
        <p>
          The response always flags which fallback level was used: <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">none</code>,{' '}
          <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">no_subdivision</code>, or{' '}
          <code className="text-sm px-1.5 py-0.5 rounded bg-secondary text-foreground">nearest_comps</code>.
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
            ['Pool', '$10,000', 'No', 'Added if subject has a pool (based on poolType)'],
            ['Garage', '$10,000', 'No', 'Added if subject has a garage (based on garageType or garageSquareFeet)'],
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
    id: 'weighted-arv',
    title: 'Weighted ARV Calculation',
    content: (
      <SectionProse>
        <p>
          The Weighted After-Renovation Value (ARV) is the core output of the system. It uses an
          expert underwriter methodology where each comparable is assigned a weight based on how
          relevant it is to the subject property. Six multiplicative factors determine the weight —
          meaning a single low factor can dramatically reduce a comp&apos;s influence.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">2-Tier System</h4>
        <p>
          Comps are divided into two tiers based on how their classification matches the subject:
        </p>
        <DataTable
          headers={['Tier', 'Comp Type', 'Role']}
          rows={[
            ['Tier 1 (Primary)', 'Same classification as subject', 'Drives the ARV — heavily weighted'],
            ['Tier 2 (Support)', 'Opposite classification', 'Used for spread analysis and fallback'],
          ]}
        />

        <h4 className="text-lg font-semibold text-foreground pt-2">Weight Factors</h4>
        <p>Each comp&apos;s weight is the product of all six factors, then normalized so all weights sum to 1.</p>

        <DataTable
          headers={['Factor', 'Range', 'Logic']}
          rows={[
            ['Classification Match', '0.7 – 2.0', 'Same classification as subject = 2.0×; different = 0.7×. This is the most critical factor (2.9× difference).'],
            ['Distance', '0.3 – 2.0', '≤0.25mi = 2.0×, ≤0.5mi = 1.5×, ≤1mi = 1.0×, ≤2mi = 0.6×, >2mi = 0.3×'],
            ['Sqft Similarity', '0.5 – 1.5', '≤5% diff = 1.5×, ≤10% = 1.3×, ≤15% = 1.1×, ≤25% = 0.8×, >25% = 0.5×'],
            ['Recency', '0.6 – 1.4', '≤30d = 1.4×, ≤60d = 1.2×, ≤120d = 1.0×, ≤180d = 0.9×, ≤365d = 0.7×, >365d = 0.6×'],
            ['Filter Pass Rate', '0.5 – 1.5', 'Formula: 0.5 + (passedFilters / totalFilters). 100% pass = 1.5×, 0% = 0.5×'],
            ['Confidence', '0.8 – 1.2', 'Formula: 0.8 + (classificationConfidence / 100) × 0.4. Rewards higher-confidence classifications.'],
          ]}
        />

        <h4 className="text-lg font-semibold text-foreground pt-2">ARV Determination (Priority Order)</h4>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li><strong className="text-foreground">2+ Tier 1 comps:</strong> Weighted average of Tier 1 comps only</li>
          <li><strong className="text-foreground">1 Tier 1 + Tier 2 comps:</strong> 70% Tier 1 price + 30% Tier 2 average (blended)</li>
          <li><strong className="text-foreground">Only Tier 2 comps (2+):</strong> Weighted average of all Tier 2</li>
          <li><strong className="text-foreground">Any comps available:</strong> Weighted average of all available comps</li>
          <li><strong className="text-foreground">No valid comps:</strong> Fallback to after-renovation value, then as-is value</li>
        </ol>

        <h4 className="text-lg font-semibold text-foreground pt-2">Group-Level Values</h4>
        <p>
          In addition to the final ARV, the system calculates separate weighted averages for each classification group:
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2">
          <li><strong className="text-foreground">As-Is Value</strong> — Weighted average of as-is classified comps (current market value)</li>
          <li><strong className="text-foreground">After-Renovation Value</strong> — Weighted average of after-renovation classified comps</li>
          <li><strong className="text-foreground">Spread</strong> — After-Renovation Value − As-Is Value (profit potential)</li>
        </ul>

        <CodeBlock>{`Weight(comp) = classMatch × distance × sqft × recency × filterPass × confidence

Normalized Weight = Weight(comp) / Sum(all weights)

ARV = Σ( NormalizedWeight(i) × AdjustedPrice(i) )  for enabled comps`}</CodeBlock>
      </SectionProse>
    ),
  },
  {
    id: 'investment-scenarios',
    title: 'Investment Scenarios',
    content: (
      <SectionProse>
        <p>
          Three investment scenarios are generated from the weighted ARV results, each targeting
          a different investor strategy. Scenarios are only generated when the required comp data
          is available.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">1. Flip Scenario</h4>
        <p>
          Requires both as-is and after-renovation comp groups. The target ARV is the after-renovation
          value — representing the property&apos;s value after a full renovation.
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2">
          <li><strong className="text-foreground">Target ARV:</strong> After-renovation weighted value</li>
          <li><strong className="text-foreground">Confidence:</strong> min(95%, 50% + afterRenoCompCount × 15%)</li>
          <li>Includes spread analysis showing potential profit (after-reno value − as-is value)</li>
        </ul>

        <h4 className="text-lg font-semibold text-foreground pt-2">2. Wholesale Scenario</h4>
        <p>
          Requires as-is comps. Represents current market value for assignment-fee deals.
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2">
          <li><strong className="text-foreground">Target ARV:</strong> As-is weighted value (current market)</li>
          <li><strong className="text-foreground">Confidence:</strong> min(90%, 50% + asIsCompCount × 15%)</li>
        </ul>

        <h4 className="text-lg font-semibold text-foreground pt-2">3. Rental Scenario</h4>
        <p>
          Always generated when data exists. Assumes only cosmetic updates — not a full renovation.
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2">
          <li><strong className="text-foreground">Target ARV:</strong> As-Is Value + 40% of spread</li>
          <li><strong className="text-foreground">Confidence:</strong> Fixed at 70%</li>
          <li>Uses as-is comps + up to 2 after-renovation comps for reference</li>
        </ul>

        <CodeBlock>{`Flip ARV     = afterRenovationValue
Wholesale    = asIsValue
Rental ARV   = asIsValue + (afterRenovationValue − asIsValue) × 0.4`}</CodeBlock>
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
          projected profit, and a recommendation score.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Rehab Cost Estimation</h4>
        <p>
          Rehab costs are tiered by ARV range, with 7 levels from lipstick cosmetic to down-to-stud
          renovation. Costs scale with market value — higher ARV properties use higher per-sqft rates.
        </p>
        <DataTable
          headers={['ARV Tier', 'Per-Sqft Range', 'Min Profit Target']}
          rows={[
            ['Under $501k', '$25 – $60/sqft', '$30k – $50k'],
            ['$501k – $999k', '$30 – $75/sqft', '$50k – $70k'],
            ['$1M – $3M', '$60 – $100/sqft', '$100k'],
            ['Over $3M', '$80 – $120/sqft', '$150k'],
          ]}
        />

        <p>
          Additional major items are estimated separately based on property age and condition:
          roof ($10k), HVAC ($8k), water heater ($2.5k), electrical panel ($3.5k), re-plumb ($8k),
          re-wire ($8k), foundation ($12k), sinkhole ($15k), septic ($5–15k), pool ($5–15k),
          and more (17 items total).
        </p>

        <CodeBlock>{`Total Rehab = (sqft × perSqft rate) + Σ(major items) + addition play`}</CodeBlock>

        <h4 className="text-lg font-semibold text-foreground pt-2">Investment Metrics</h4>
        <CodeBlock>{`Buy Price        = ARV − Rehab − Closing Costs (10%) − Carrying Costs (5%) − Profit Target
Wholesale Price  = Buy Price − Wholesale Fee ($10,000)
Total Investment = Buy Price + Rehab Cost
Projected Profit = ARV − Total Investment − Closing − Carrying
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
    id: 'analysis-flow',
    title: 'End-to-End Analysis Flow',
    content: (
      <SectionProse>
        <p>
          The complete analysis pipeline processes a property address through multiple stages
          using Cloudflare Workflows for orchestration and Durable Objects for job state management
          and WebSocket streaming.
        </p>

        <div className="rounded-xl border border-border bg-secondary/30 p-6 space-y-4 font-mono text-sm text-foreground-secondary">
          <div className="flex items-center gap-3">
            <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">1</span>
            <span><strong className="text-foreground font-sans">Input</strong> — POST /v1/analyze with property address + optional appraisal preset</span>
          </div>
          <div className="border-l-2 border-border ml-3.5 pl-6 space-y-4">
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">2</span>
              <span><strong className="text-foreground font-sans">Property Bundle</strong> — Fetch subject + 10 comps + enrichment from CoreLogic API (2–10s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">3</span>
              <span><strong className="text-foreground font-sans">Appraisal Rules</strong> — Evaluate filters + adjustments on all comps, apply 3-step fallback (&lt;1s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">4</span>
              <span><strong className="text-foreground font-sans">Photo Fetch</strong> — Scrape Zillow photos via Firecrawl for subject + comps, merge missing data (2–5s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">5</span>
              <span><strong className="text-foreground font-sans">Batch Classification</strong> — Classify subject + all comps via vision LLM in 1–2 batched calls (1–3s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">6</span>
              <span><strong className="text-foreground font-sans">Weighted ARV</strong> — Calculate 6-factor weights, normalize, compute tier-based weighted average (&lt;1s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">7</span>
              <span><strong className="text-foreground font-sans">Investment Scenarios</strong> — Generate flip, wholesale, and rental strategies with confidence scores (&lt;1s)</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-md bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">8</span>
              <span><strong className="text-foreground font-sans">Valuation</strong> — Estimate rehab costs, buy price, profit, ROI, and recommendation (&lt;1s)</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-7 h-7 rounded-md bg-emerald-500/20 text-emerald-500 flex items-center justify-center text-xs font-bold flex-shrink-0">9</span>
            <span><strong className="text-foreground font-sans">Output</strong> — Subject details, ARV, comp quality scores, investment scenarios, risk flags (~10–15s total)</span>
          </div>
        </div>

        <h4 className="text-lg font-semibold text-foreground pt-2">Async Processing &amp; Real-Time Updates</h4>
        <p>
          Analysis runs asynchronously via Cloudflare Workflows with automatic retries (3 attempts,
          exponential backoff). The client receives a job ID and can track progress via:
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2">
          <li><strong className="text-foreground">WebSocket</strong> — Real-time step progress via Durable Object (hibernation API for cost efficiency)</li>
          <li><strong className="text-foreground">HTTP Polling</strong> — GET /v1/analyze/jobs/:jobId for current state</li>
        </ul>
        <p>
          Each workflow step emits progress events (step_started, step_completed, cache_hit),
          allowing the dashboard to show a live progress stepper during analysis.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Data Supplementation</h4>
        <p>
          When CoreLogic data has gaps (missing beds, baths, sqft, etc.), the system supplements
          with Zillow-scraped data. The response tracks every supplemented field with its source
          for full transparency.
        </p>

        <h4 className="text-lg font-semibold text-foreground pt-2">Comp Quality Scoring</h4>
        <p>
          Each comp receives a 0–100 quality score based on two components:
        </p>
        <ul className="list-disc list-inside space-y-1.5 ml-2">
          <li><strong className="text-foreground">Filter Pass Rate (0–50 pts)</strong> — Primary factor: percentage of appraisal filters passed × 50</li>
          <li><strong className="text-foreground">Data Similarity (0–50 pts)</strong> — Distance penalty (0–15), sqft penalty (0–12), recency bonus (0–12), year built penalty (0–11)</li>
        </ul>
      </SectionProse>
    ),
  },
]
