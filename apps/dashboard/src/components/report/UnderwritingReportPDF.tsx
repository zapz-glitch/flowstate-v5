import React from 'react'
import { formatRuleMatch, formatComparisonDetails } from '@/components/analysis/rule-match'
import { formatHeadlineMoney } from '@/components/analysis/headline-money'
import {
  Document,
  Image,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer'
import type {
  SubjectData,
  ValuationData,
  CompsData,
  CompItem,
  FloodZoneData,
  NeighbourhoodData,
} from '@/components/analysis/shared-types'

// ─── Props ───────────────────────────────────────────────────────────────────

export interface UnderwritingReportProps {
  address: string
  date: string
  reportId?: string
  subject?: SubjectData
  valuation?: ValuationData
  comps?: CompsData
  riskFlags?: string[] | null
  floodZone?: FloodZoneData | null
  neighbourhood?: NeighbourhoodData | null
  isRecalculated?: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n?: number | null): string {
  if (n == null || Number.isNaN(n)) return '-'
  return '$' + n.toLocaleString('en-US')
}

function fmtPct(n?: number | null, decimals = 1): string {
  if (n == null || Number.isNaN(n)) return '-'
  return n.toFixed(decimals) + '%'
}

function fmtDate(d?: string | null): string {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ─── Color palette ───────────────────────────────────────────────────────────

const C = {
  primary: '#1a56db',
  green: '#059669',
  red: '#dc2626',
  amber: '#d97706',
  dark: '#111827',
  medium: '#4b5563',
  muted: '#6b7280',
  light: '#9ca3af',
  border: '#e5e7eb',
  bgLight: '#f9fafb',
  bgAccent: '#eff6ff',
  white: '#ffffff',
}

// TODO: re-enable when neighbourhood data source is available
// /** Color-code a crime index value for the PDF */
// function pdfCrimeColor(value: number): string {
//   if (value <= 50) return C.green
//   if (value <= 100) return C.amber
//   if (value <= 200) return '#ea580c' // orange-600
//   return C.red
// }

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: C.dark,
    paddingTop: 40,
    paddingBottom: 56,
    paddingHorizontal: 40,
  },
  // Header
  headerBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    borderBottomWidth: 2,
    borderBottomColor: C.primary,
    paddingBottom: 8,
    marginBottom: 20,
  },
  headerTitle: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    color: C.primary,
    letterSpacing: 0.5,
  },
  headerMeta: {
    fontSize: 7.5,
    color: C.muted,
    textAlign: 'right' as const,
  },
  // Section titles
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: C.dark,
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  sectionMargin: {
    marginTop: 18,
  },
  // Valuation summary grid
  valGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    overflow: 'hidden',
  },
  valCell: {
    width: '33.33%',
    padding: 10,
    borderRightWidth: 1,
    borderRightColor: C.border,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  valCellLabel: {
    fontSize: 7,
    color: C.muted,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  valCellValue: {
    fontSize: 13,
    fontFamily: 'Helvetica-Bold',
  },
  valCellSub: {
    fontSize: 7,
    color: C.muted,
    marginTop: 2,
  },
  // Recommendation
  recBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    padding: 8,
    borderRadius: 4,
    gap: 8,
  },
  recBadge: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 3,
    color: C.white,
  },
  recReason: {
    fontSize: 8,
    color: C.medium,
    flex: 1,
  },
  // Property stats row
  statsRow: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    overflow: 'hidden',
  },
  statCell: {
    flex: 1,
    padding: 7,
    borderRightWidth: 1,
    borderRightColor: C.border,
    alignItems: 'center' as const,
  },
  statLabel: {
    fontSize: 6.5,
    color: C.muted,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  statValue: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
  },
  // Tables
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: C.dark,
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  tableHeaderCell: {
    fontSize: 6.5,
    fontFamily: 'Helvetica-Bold',
    color: C.white,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.3,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: C.border,
  },
  tableRowAlt: {
    backgroundColor: C.bgLight,
  },
  tableCell: {
    fontSize: 8,
  },
  tableCellBold: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
  },
  // Info row (key-value)
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    paddingHorizontal: 2,
    borderBottomWidth: 0.5,
    borderBottomColor: C.border,
  },
  infoLabel: {
    fontSize: 8,
    color: C.muted,
  },
  infoValue: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
  },
  // Footer
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 0.5,
    borderTopColor: C.border,
    paddingTop: 6,
  },
  footerText: {
    fontSize: 6.5,
    color: C.light,
  },
  // Misc
  badge: {
    fontSize: 7,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: 0.5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  gap4: { gap: 4 },
  gap8: { gap: 8 },
  mt4: { marginTop: 4 },
  mt8: { marginTop: 8 },
  mt12: { marginTop: 12 },
})

// ─── Sub-components ──────────────────────────────────────────────────────────

function PageFooter({ date }: { date: string }) {
  return (
    <View style={s.footer} fixed>
      <Text style={s.footerText}>Confidential — Prepared by Flowstate Underwriting</Text>
      <Text style={s.footerText}>{date}</Text>
    </View>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={s.sectionTitle}>{children}</Text>
}

function ValuationCell({
  label,
  value,
  sub,
  color,
  wide,
}: {
  label: string
  value: string
  sub?: string
  color?: string
  wide?: boolean
}) {
  return (
    <View style={[s.valCell, wide ? { width: '50%' } : {}]}>
      <Text style={s.valCellLabel}>{label}</Text>
      <Text style={[s.valCellValue, color ? { color } : {}]}>{value}</Text>
      {sub && <Text style={s.valCellSub}>{sub}</Text>}
    </View>
  )
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={s.statCell}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue}>{String(value)}</Text>
    </View>
  )
}

// ─── Document ────────────────────────────────────────────────────────────────

export function UnderwritingReportPDF({
  address,
  date,
  reportId,
  subject,
  valuation,
  comps,
  riskFlags,
  floodZone,
  neighbourhood,
  isRecalculated,
}: UnderwritingReportProps) {
  const formattedDate = fmtDate(date)
  const enabledComps = comps?.items?.filter((c) => c.isEnabled !== false) ?? []
  const excludedComps = comps?.items?.filter((c) => c.isEnabled === false) ?? []
  const profitColor = (valuation?.projectedProfit ?? 0) > 0 ? C.green : C.red

  const recBgColor = (() => {
    const rec = valuation?.recommendation?.toUpperCase() ?? ''
    if (rec.includes('PURSUE') || rec.includes('BUY')) return C.green
    if (rec.includes('PASS') || rec.includes('AVOID')) return C.red
    if (rec.includes('REVIEW') || rec.includes('CAUTION')) return C.amber
    return C.medium
  })()

  return (
    <Document title={`Underwriting Report — ${address}`} author="Flowstate">
      {/* ═══ PAGE 1: Property + Valuation ═══ */}
      <Page size="LETTER" style={s.page}>
        <PageFooter date={formattedDate} />

        {/* Header */}
        <View style={s.headerBar}>
          <View>
            <Text style={s.headerTitle}>PROPERTY UNDERWRITING REPORT</Text>
            <Text style={{ fontSize: 8, color: C.muted, marginTop: 2 }}>Flowstate Investment Analysis</Text>
          </View>
          <View>
            <Text style={s.headerMeta}>{formattedDate}</Text>
            {reportId && <Text style={s.headerMeta}>ID: {reportId}</Text>}
            {isRecalculated && <Text style={[s.headerMeta, { color: C.amber }]}>Recalculated</Text>}
          </View>
        </View>

        {/* ── Subject Property ─────────────────────────────── */}
        <SectionTitle>Subject Property</SectionTitle>
        {subject?.photos?.[0]?.startsWith('data:image/') && <Image src={subject.photos[0]} style={{ width: 180, height: 110, objectFit: 'contain', marginBottom: 8 }} />}

        <Text style={{ fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>
          {address}
        </Text>

        {(subject?.subdivision || subject?.county) && (
          <View style={[s.row, s.gap8, { marginBottom: 6 }]}>
            {subject.subdivision && (
              <Text style={{ fontSize: 8, color: C.muted }}>
                Subdivision: <Text style={{ fontFamily: 'Helvetica-Bold', color: C.dark }}>{subject.subdivision}</Text>
              </Text>
            )}
            {subject.county && (
              <Text style={{ fontSize: 8, color: C.muted }}>
                County: <Text style={{ fontFamily: 'Helvetica-Bold', color: C.dark }}>{subject.county}</Text>
              </Text>
            )}
          </View>
        )}

        <View style={s.statsRow}>
          <StatBox label="Beds" value={subject?.bedrooms ?? '-'} />
          <StatBox label="Baths" value={subject?.bathrooms ?? '-'} />
          <StatBox label="Sq Ft" value={subject?.squareFeet?.toLocaleString() ?? '-'} />
          <StatBox label="Year Built" value={subject?.yearBuilt ?? '-'} />
          <StatBox label="Lot" value={subject?.lotSizeAcres ? `${Number(subject.lotSizeAcres).toFixed(3)} ac` : '-'} />
          <StatBox label="Foundation" value={subject?.foundationType ?? '-'} />
        </View>

        {subject?.lastSale?.price && (
          <View style={[s.infoRow, s.mt8]}>
            <Text style={s.infoLabel}>Last Sale</Text>
            <Text style={s.infoValue}>
              {fmt(subject.lastSale.price)}
              {subject.lastSale.date ? `  (${fmtDate(subject.lastSale.date)})` : ''}
            </Text>
          </View>
        )}

        {subject?.classification && (
          <View style={[s.infoRow]}>
            <Text style={s.infoLabel}>Classification</Text>
            <Text style={s.infoValue}>
              {subject.classification.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
              {' '}({subject.classification.confidence}% confidence)
            </Text>
          </View>
        )}

        {/* ── Valuation Summary ────────────────────────────── */}
        <View style={s.sectionMargin}>
          <SectionTitle>Valuation Summary</SectionTitle>
          {!valuation && <Text style={s.tableCell}>Valuation unavailable. Review the report limitations before using these comparables.</Text>}
        </View>

        <View style={s.valGrid}>
          <ValuationCell
            label="After Repair Value (ARV)"
            value={`$${formatHeadlineMoney(valuation?.arv, valuation?.displayedArv, valuation?.displayRounding)}`}
            sub={valuation?.arvPerSqft != null ? `${fmt(valuation.arvPerSqft)}/sqft` : undefined}
            color={C.primary}
          />
          <ValuationCell
            label="Max Buy Price"
            value={`$${formatHeadlineMoney(valuation?.buyPrice, valuation?.displayedBuyPrice, valuation?.displayRounding)}`}
            sub={valuation?.buyPricePercent ? `${valuation.buyPricePercent}% of ARV` : undefined}
          />
          <ValuationCell
            label="Rehab Cost"
            value={fmt(valuation?.rehabCost)}
            sub={valuation?.rehabLevel ?? undefined}
          />
          <ValuationCell
            label="Total Costs"
            value={fmt(valuation?.totalCosts)}
            sub="Closing + Carrying"
          />
          <ValuationCell
            label="Total Investment"
            value={fmt(valuation?.totalInvestment)}
            sub="Buy Price + Rehab"
          />
          <ValuationCell
            label="Projected Profit"
            value={fmt(valuation?.projectedProfit)}
            sub={valuation?.projectedROI != null ? `${fmtPct(valuation.projectedROI)} ROI` : undefined}
            color={profitColor}
          />
        </View>

        {valuation?.wholesalePrice != null && (
          <View style={[s.infoRow, s.mt8]}>
            <Text style={s.infoLabel}>Wholesale Price</Text>
            <Text style={s.infoValue}>${formatHeadlineMoney(valuation.wholesalePrice, valuation.displayedWholesalePrice, valuation.displayRounding)}</Text>
          </View>
        )}

        {valuation?.recommendation && (
          <View style={[s.recBox, { backgroundColor: recBgColor + '12' }]}>
            <Text style={[s.recBadge, { backgroundColor: recBgColor }]}>
              {valuation.recommendation}
            </Text>
            {valuation.recommendationReason && (
              <Text style={s.recReason}>{valuation.recommendationReason}</Text>
            )}
          </View>
        )}

        {/* ── Rehab Level Estimates ────────────────────────── */}
        {valuation?.rehabLevelEstimates && valuation.rehabLevelEstimates.length > 0 && (
          <View style={s.sectionMargin}>
            <SectionTitle>Rehab Level Estimates</SectionTitle>
            <View style={s.tableHeader}>
              <Text style={[s.tableHeaderCell, { width: '22%' }]}>Level</Text>
              <Text style={[s.tableHeaderCell, { width: '13%', textAlign: 'right' }]}>$/SqFt</Text>
              <Text style={[s.tableHeaderCell, { width: '17%', textAlign: 'right' }]}>Rehab Cost</Text>
              <Text style={[s.tableHeaderCell, { width: '17%', textAlign: 'right' }]}>Buy Price</Text>
              <Text style={[s.tableHeaderCell, { width: '17%', textAlign: 'right' }]}>Profit</Text>
              <Text style={[s.tableHeaderCell, { width: '14%', textAlign: 'right' }]}>ROI</Text>
            </View>
            {valuation.rehabLevelEstimates.map((est, i) => (
              <View
                key={i}
                style={[
                  s.tableRow,
                  i % 2 === 1 ? s.tableRowAlt : {},
                  est.isSelected ? { backgroundColor: C.bgAccent } : {},
                ]}
              >
                <Text style={[est.isSelected ? s.tableCellBold : s.tableCell, { width: '22%' }]}>
                  {est.isSelected ? '● ' : '  '}{est.name}
                </Text>
                <Text style={[s.tableCell, { width: '13%', textAlign: 'right' }]}>${est.perSqft}</Text>
                <Text style={[s.tableCell, { width: '17%', textAlign: 'right' }]}>{fmt(est.estimatedCost)}</Text>
                <Text style={[s.tableCell, { width: '17%', textAlign: 'right' }]}>{fmt(est.buyPrice)}</Text>
                <Text style={[s.tableCell, { width: '17%', textAlign: 'right', color: est.projectedProfit > 0 ? C.green : C.red }]}>
                  {fmt(est.projectedProfit)}
                </Text>
                <Text style={[s.tableCell, { width: '14%', textAlign: 'right' }]}>{fmtPct(est.projectedROI)}</Text>
              </View>
            ))}
          </View>
        )}

        {valuation?.investorAnalysis && (
          <View style={s.sectionMargin}>
            <SectionTitle>As-is / investor analysis</SectionTitle>
            <Text style={s.tableCell}>{valuation.investorAnalysis.methodLabel}</Text>
            <Text style={s.tableCell}>
              {valuation.investorAnalysis.value != null && Number.isFinite(valuation.investorAnalysis.value)
                ? `${fmt(valuation.investorAnalysis.value)} estimated as-is value`
                : 'As-is value not available'}
            </Text>
            <Text style={s.tableCell}>{valuation.investorAnalysis.status.replaceAll('_', ' ')} · {valuation.investorAnalysis.sampleCount} investor cohort comparables</Text>
            {valuation.investorAnalysis.limitations.map((limitation, index) => <Text key={index} style={s.tableCell}>{limitation}</Text>)}
          </View>
        )}

        {/* ── Risk & Flood ─────────────────────────────────── */}
        {(floodZone || (riskFlags && riskFlags.length > 0)) && (
          <View style={s.sectionMargin}>
            <SectionTitle>Risk Assessment</SectionTitle>

            {floodZone && (
              <View style={[s.row, s.gap8, s.mt4]}>
                <Text style={{ fontSize: 8, color: C.muted }}>Flood Zone:</Text>
                <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold' }}>{floodZone.zone ?? 'N/A'}</Text>
                <Text style={{ fontSize: 8, color: floodZone.inFloodZone ? C.red : C.green, fontFamily: 'Helvetica-Bold' }}>
                  {floodZone.inFloodZone ? 'IN FLOOD ZONE' : 'Not in Flood Zone'}
                </Text>
              </View>
            )}
            {floodZone?.description && (
              <Text style={{ fontSize: 7.5, color: C.muted, marginTop: 2 }}>{floodZone.description}</Text>
            )}

            {riskFlags && riskFlags.length > 0 && (
              <View style={s.mt8}>
                <Text style={{ fontSize: 8, color: C.amber, fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>Risk Flags</Text>
                <View style={[s.row, { flexWrap: 'wrap', gap: 4 }]}>
                  {riskFlags.map((flag, i) => (
                    <Text key={i} style={[s.badge, { borderColor: C.amber, color: C.amber, backgroundColor: '#fef3c7' }]}>
                      {flag}
                    </Text>
                  ))}
                </View>
              </View>
            )}
          </View>
        )}

        {/* TODO: re-enable when neighbourhood data source is available */}
        {/* Neighbourhood Analysis section commented out — requires ATTOM data */}
      </Page>

      {/* ═══ PAGE 2: Comparable Sales ═══ */}
      {comps?.items && comps.items.length > 0 && (
        <Page size="LETTER" style={s.page}>
          <PageFooter date={formattedDate} />

          <SectionTitle>Comparable Sales — Selected for ARV ({enabledComps.length})</SectionTitle>

          {/* Summary stats */}
          <View style={[s.row, s.gap8, { marginBottom: 8 }]}>
            {comps.avgPricePerSqft != null && (
              <Text style={{ fontSize: 8, color: C.muted }}>
                Avg $/SqFt: <Text style={{ fontFamily: 'Helvetica-Bold', color: C.dark }}>${comps.avgPricePerSqft}</Text>
              </Text>
            )}
            {comps.medianPrice != null && (
              <Text style={{ fontSize: 8, color: C.muted }}>
                Median Price: <Text style={{ fontFamily: 'Helvetica-Bold', color: C.dark }}>{fmt(comps.medianPrice)}</Text>
              </Text>
            )}
          </View>

          {/* Enabled comps table */}
          <View style={s.tableHeader}>
            <Text style={[s.tableHeaderCell, { width: '4%' }]}>#</Text>
            <Text style={[s.tableHeaderCell, { width: '26%' }]}>Address</Text>
            <Text style={[s.tableHeaderCell, { width: '12%', textAlign: 'right' }]}>Sale Price</Text>
            <Text style={[s.tableHeaderCell, { width: '12%', textAlign: 'right' }]}>Adj. Price</Text>
            <Text style={[s.tableHeaderCell, { width: '9%', textAlign: 'right' }]}>SqFt</Text>
            <Text style={[s.tableHeaderCell, { width: '9%', textAlign: 'right' }]}>$/SqFt</Text>
            <Text style={[s.tableHeaderCell, { width: '8%', textAlign: 'center' }]}>Bd/Ba</Text>
            <Text style={[s.tableHeaderCell, { width: '7%', textAlign: 'right' }]}>Year</Text>
            <Text style={[s.tableHeaderCell, { width: '6%', textAlign: 'right' }]}>Dist</Text>
            <Text style={[s.tableHeaderCell, { width: '7%', textAlign: 'right' }]}>Sold</Text>
          </View>
          {enabledComps.map((comp, i) => (
            <View key={i} style={[s.tableRow, i % 2 === 1 ? s.tableRowAlt : {}]} wrap={false}>
              <Text style={[s.tableCell, { width: '4%', color: C.muted }]}>{i + 1}</Text>
              <Text style={[s.tableCellBold, { width: '26%' }]}>
                {comp.address ?? '-'}
                {formatRuleMatch(comp) ? `\n${formatRuleMatch(comp)}` : ''}
                {comp.priorityRank != null ? `\nMatch rank #${comp.priorityRank}` : ''}
                {formatComparisonDetails(comp).map(detail => `\n${detail}`).join('')}
              </Text>
              <Text style={[s.tableCell, { width: '12%', textAlign: 'right' }]}>{fmt(comp.salePrice)}</Text>
              <Text style={[s.tableCell, { width: '12%', textAlign: 'right', color: C.green }]}>
                {comp.adjustedPrice ? fmt(comp.adjustedPrice) : '-'}
              </Text>
              <Text style={[s.tableCell, { width: '9%', textAlign: 'right' }]}>
                {comp.squareFeet?.toLocaleString() ?? '-'}
              </Text>
              <Text style={[s.tableCell, { width: '9%', textAlign: 'right' }]}>
                {comp.pricePerSqft ? `$${comp.pricePerSqft.toFixed(0)}` : '-'}
              </Text>
              <Text style={[s.tableCell, { width: '8%', textAlign: 'center' }]}>
                {comp.bedrooms ?? '-'}/{comp.bathrooms ?? '-'}
              </Text>
              <Text style={[s.tableCell, { width: '7%', textAlign: 'right' }]}>{comp.yearBuilt ?? '-'}</Text>
              <Text style={[s.tableCell, { width: '6%', textAlign: 'right' }]}>
                {comp.distanceMiles != null ? `${comp.distanceMiles.toFixed(1)}mi` : '-'}
              </Text>
              <Text style={[s.tableCell, { width: '7%', textAlign: 'right' }]}>
                {comp.saleDate ? new Date(comp.saleDate).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : '-'}
              </Text>
            </View>
          ))}

          {enabledComps.filter(comp => comp.photos?.[0]?.startsWith('data:image/')).map((comp, index) => (
            <View key={`photo-${index}`} style={{ marginTop: 8 }} wrap={false}>
              <Text style={s.tableCell}>{comp.address}</Text>
              <Image src={comp.photos![0]} style={{ width: 180, height: 110, objectFit: 'contain' }} />
            </View>
          ))}

          {/* Excluded comps */}
          {excludedComps.length > 0 && (
            <View style={s.sectionMargin}>
              <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: C.muted, marginBottom: 6 }}>
                Excluded Comparables ({excludedComps.length})
              </Text>
              {excludedComps.map((comp, i) => (
                <View key={i} style={[s.tableRow, i % 2 === 1 ? s.tableRowAlt : {}]} wrap={false}>
                  <Text style={[s.tableCell, { width: '40%', color: C.muted }]}>
                    {comp.address ?? '-'}
                    {formatRuleMatch(comp) ? `\n${formatRuleMatch(comp)}` : ''}
                    {comp.priorityRank != null ? `\nMatch rank #${comp.priorityRank}` : ''}
                    {formatComparisonDetails(comp).map(detail => `\n${detail}`).join('')}
                  </Text>
                  <Text style={[s.tableCell, { width: '20%', textAlign: 'right', color: C.muted }]}>{fmt(comp.salePrice)}</Text>
                  <Text style={[s.tableCell, { width: '40%', color: C.light }]}>
                    {comp.disableReasons?.join(', ') || 'Excluded'}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </Page>
      )}
    </Document>
  )
}
