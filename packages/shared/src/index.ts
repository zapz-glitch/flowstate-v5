// Valuation
export {
  REHAB_LEVELS,
  MAJOR_ITEMS,
  DEFAULT_REHAB_TABLE,
  DEFAULT_TIER_RANGES,
  getArvTier,
  getRehabEstimate,
  calculateValuation,
  calculateAllRehabLevelEstimates,
} from './valuation/index'

export type {
  ArvTier,
  RehabLevel,
  RehabEstimate,
  RehabTable,
  TierRangeDefinition,
  MajorItemId,
  MajorItem,
  ValuationParams,
  ValuationResult,
  RehabLevelEstimate,
} from './valuation/index'

// Appraisal
export {
  evaluateFilter,
  calculateAdjustment,
  evaluateComparable,
  calculateARV,
  pickBestComps,
  getCompAvgSqft,
  scoreComp,
  passesHardFilters,
  isHardFilter,
  HARD_FILTER_TYPES,
  SOFT_FILTER_SCORES,
  subdivisionBase,
  subdivisionsMatch,
  foundationFamily,
} from './appraisal/index'

export type {
  FilterType,
  FilterPriority,
  AdjustmentType,
  AppraisalFilter,
  AppraisalAdjustment,
  FilterResult,
  AdjustmentResult,
  PropertyLike,
  CompLike,
  ComparableEvaluation,
  FilterLabel,
  AdjustmentLabel,
  ArvCompLike,
} from './appraisal/index'
