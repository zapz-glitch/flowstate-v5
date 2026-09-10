import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core'

// ==========================================
// Better Auth Tables
// ==========================================

// Users table (Better Auth compatible)
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updatedAt').notNull().$defaultFn(() => new Date().toISOString()),
  // Custom fields
  plan: text('plan').notNull().default('free'),
  role: text('role').notNull().default('user'), // 'user' | 'admin'
})

// Alias for backwards compatibility
export const users = user

// Sessions table (Better Auth compatible)
export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: text('expiresAt').notNull(),
  token: text('token').notNull().unique(),
  createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updatedAt').notNull().$defaultFn(() => new Date().toISOString()),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }),
})

// Alias for backwards compatibility
export const sessions = session

// Account table (Better Auth compatible - for OAuth)
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: text('accessTokenExpiresAt'),
  refreshTokenExpiresAt: text('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: text('createdAt').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updatedAt').notNull().$defaultFn(() => new Date().toISOString()),
})

// Verification table (Better Auth compatible)
export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: text('expiresAt').notNull(),
  createdAt: text('createdAt').$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updatedAt').$defaultFn(() => new Date().toISOString()),
})

// ==========================================
// API Keys
// ==========================================

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(), // SHA-256 hash
    keyPrefix: text('key_prefix').notNull(), // First 8 chars for display
    // Quota (overrides plan default if set)
    monthlyQuota: integer('monthly_quota'),
    currentUsage: integer('current_usage').notNull().default(0),
    quotaResetAt: text('quota_reset_at').notNull().$defaultFn(() => {
      const now = new Date()
      return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
    }),
    // Status
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    // Timestamps
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_api_keys_user_id').on(table.userId),
    index('idx_api_keys_key_hash').on(table.keyHash),
  ]
)

// ==========================================
// API Usage Logs
// ==========================================

export const apiUsageLogs = sqliteTable(
  'api_usage_logs',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    apiKeyId: text('api_key_id').references(() => apiKeys.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Request details
    endpoint: text('endpoint').notNull(),
    method: text('method').notNull(),
    statusCode: integer('status_code').notNull(),
    responseTimeMs: integer('response_time_ms'),
    // Property info (for analytics)
    propertyAddress: text('property_address'),
    propertyCity: text('property_city'),
    propertyState: text('property_state'),
    // Request metadata
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    errorMessage: text('error_message'),
    // Request/Response bodies (for debugging and audit)
    requestBody: text('request_body'),
    responseBody: text('response_body'),
    requestHeaders: text('request_headers'),
    // Timestamp
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_api_usage_logs_api_key_id').on(table.apiKeyId),
    index('idx_api_usage_logs_user_id').on(table.userId),
    index('idx_api_usage_logs_created_at').on(table.createdAt),
    index('idx_api_usage_logs_endpoint').on(table.endpoint),
  ]
)

// ==========================================
// Saved Reports (property analysis history)
// ==========================================

export const savedReports = sqliteTable(
  'saved_reports',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    apiKeyId: text('api_key_id')
      .references(() => apiKeys.id, { onDelete: 'set null' }),
    // Property info
    propertyAddress: text('property_address').notNull(),
    propertyCity: text('property_city').notNull(),
    propertyState: text('property_state').notNull(),
    propertyZip: text('property_zip'),
    propertyClip: text('property_clip'),
    // Analysis results (JSON)
    propertyData: text('property_data'), // Full property response
    comparablesData: text('comparables_data'), // Comparables response
    valuationData: text('valuation_data'), // ARV, MAO, etc.
    fullResponseJson: text('full_response_json'), // Complete AnalysisResponse JSON
    // Key metrics for quick display
    arv: real('arv'),
    asIsValue: real('as_is_value'),
    maxAllowableOffer: real('max_allowable_offer'),
    estimatedRepairs: real('estimated_repairs'),
    // Workflow link
    jobId: text('job_id'), // Links to workflow job
    pdfKey: text('pdf_key'), // Reserved for future PDF support
    // Sharing
    isShared: integer('is_shared', { mode: 'boolean' }).notNull().default(false),
    sharePasswordHash: text('share_password_hash'), // format: "salt:sha256hex"
    // Timestamps
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_saved_reports_user_id').on(table.userId),
    index('idx_saved_reports_created_at').on(table.createdAt),
    index('idx_saved_reports_job_id').on(table.jobId),
    index('idx_saved_reports_address').on(table.userId, table.propertyAddress),
  ]
)

// ==========================================
// Report History (modification tracking)
// ==========================================

export const reportHistory = sqliteTable(
  'report_history',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    reportId: text('report_id')
      .notNull()
      .references(() => savedReports.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Type of modification */
    action: text('action').notNull(), // 'created' | 'comp_selection' | 'settings_change' | 'ai_analysis' | 'reanalyzed'
    /** Human-readable description */
    description: text('description').notNull(),
    /** Snapshot of changes (JSON) — e.g. which comps changed, what settings updated */
    changesJson: text('changes_json'),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_report_history_report_id').on(table.reportId),
  ]
)

// ==========================================
// Subscriptions (for paid plans)
// ==========================================

export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Stripe
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    stripePriceId: text('stripe_price_id'),
    // Status
    status: text('status').notNull().default('active'), // active, canceled, past_due
    currentPeriodStart: text('current_period_start'),
    currentPeriodEnd: text('current_period_end'),
    cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).default(false),
    // Timestamps
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_subscriptions_user_id').on(table.userId),
    index('idx_subscriptions_stripe_customer_id').on(table.stripeCustomerId),
  ]
)

// ==========================================
// LLM Usage Logs (for token tracking and billing)
// ==========================================

export const llmUsageLogs = sqliteTable(
  'llm_usage_logs',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    apiKeyId: text('api_key_id').references(() => apiKeys.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),

    // Request context
    requestId: text('request_id').notNull(),
    endpoint: text('endpoint').notNull(),

    // Provider info
    provider: text('provider').notNull(), // gemini, claude, openai, grok
    model: text('model').notNull(),

    // Token usage
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),

    // Cost tracking
    estimatedCostUsd: real('estimated_cost_usd'),

    // Timing
    latencyMs: integer('latency_ms'),

    // Timestamp
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_llm_usage_logs_user_id').on(table.userId),
    index('idx_llm_usage_logs_api_key_id').on(table.apiKeyId),
    index('idx_llm_usage_logs_request_id').on(table.requestId),
    index('idx_llm_usage_logs_created_at').on(table.createdAt),
    index('idx_llm_usage_logs_provider').on(table.provider),
  ]
)

// ==========================================
// Appraisal Rule Presets
// ==========================================

export const appraisalRulePreset = sqliteTable(
  'appraisal_rule_preset',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_appraisal_rule_preset_user_id').on(table.userId)]
)

// Appraisal Rule Filter - auto-disable criteria (sale_age, sqft_diff, property_type, year_built_diff, etc.)
export const appraisalRuleFilter = sqliteTable(
  'appraisal_rule_filter',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    presetId: text('preset_id')
      .notNull()
      .references(() => appraisalRulePreset.id, { onDelete: 'cascade' }),
    filterType: text('filter_type').notNull(), // 'subdivision_match' | 'sale_age' | 'sqft_diff' | 'property_type' | 'year_built_diff' | 'distance'
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    value: real('value').notNull(), // threshold value (days, sqft, years, miles, or 1 for must-match)
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_appraisal_rule_filter_preset_id').on(table.presetId)]
)

// Appraisal Rule Adjustment - ARV modifiers (bedroom, bathroom, pool, etc.)
export const appraisalRuleAdjustment = sqliteTable(
  'appraisal_rule_adjustment',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    presetId: text('preset_id')
      .notNull()
      .references(() => appraisalRulePreset.id, { onDelete: 'cascade' }),
    adjustmentType: text('adjustment_type').notNull(), // 'old_comp_discount' | 'bedroom' | 'bathroom' | 'pool' | 'garage' | 'carport'
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    amount: integer('amount').notNull().default(0), // dollar amount for adjustments
    percentage: integer('percentage').notNull().default(0), // percentage for discounts (old_comp_discount)
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_appraisal_rule_adjustment_preset_id').on(table.presetId)]
)

// ==========================================
// Process Documentation Comments
// ==========================================

export const processDocComments = sqliteTable(
  'process_doc_comments',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sectionId: text('section_id').notNull(),
    parentId: text('parent_id'), // null = top-level, set = reply (1 level deep)
    content: text('content').notNull(),
    isDeleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_pdc_section').on(table.sectionId),
    index('idx_pdc_user').on(table.userId),
    index('idx_pdc_parent').on(table.parentId),
  ]
)

// ==========================================
// Rehab Config (per-user renovation level pricing)
// ==========================================

export const rehabConfig = sqliteTable(
  'rehab_config',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Rehab pricing table stored as JSON
    // Shape: Record<string, Array<{ perSqft: number; minProfit: number }>>
    configJson: text('config_json').notNull(),
    // Custom tier range definitions stored as JSON (null = use defaults)
    // Shape: Array<{ key: string; label: string; minValue: number | null; maxValue: number | null }>
    tierRangesJson: text('tier_ranges_json'),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_rehab_config_user_id').on(table.userId)]
)

// ==========================================
// Deal Params (per-user valuation defaults)
// ==========================================

export const dealParams = sqliteTable(
  'deal_params',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Closing costs as a percentage of buy price (default: 8) */
    closingCostsPercent: real('closing_costs_percent').notNull().default(8),
    /** Carrying costs as a percentage of buy price (default: 2) */
    carryingCostsPercent: real('carrying_costs_percent').notNull().default(2),
    /** Wholesale fee in dollars (default: 10000) */
    wholesaleFee: real('wholesale_fee').notNull().default(10000),
    /** As-is threshold as a percentage of ARV (default: 70) — comps below this are classified as-is */
    asIsThresholdPercent: real('as_is_threshold_percent').notNull().default(70),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_deal_params_user_id').on(table.userId)]
)

// ==========================================
// ARV Threshold (per-user ARV comp threshold)
// ==========================================

export const arvThreshold = sqliteTable(
  'arv_threshold',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Top % of comps by sale price used for ARV calculation (default: 10) */
    percent: real('percent').notNull().default(10),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_arv_threshold_user_id').on(table.userId)]
)

// ==========================================
// Proximity Adjustments (traffic/commercial deductions)
// ==========================================

export const proximityConfig = sqliteTable(
  'proximity_config',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** JSON: ProximityConfig — siding/backing/fronting amounts + ARV threshold */
    configJson: text('config_json').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_proximity_config_user_id').on(table.userId)]
)

// ==========================================
// Location Settings (per-location overrides)
// ==========================================

export const locationSettings = sqliteTable(
  'location_settings',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Which setting type this row belongs to: 'appraisal' | 'rehab' | 'deal' | 'major'
    settingType: text('setting_type').notNull().default('appraisal'),
    // Exactly one of these is non-null (enforced at app level)
    state: text('state'),        // "FL" uppercase 2-letter
    city: text('city'),          // normalized to lowercase for matching
    zipCode: text('zip_code'),   // "33101"
    // Whether this override is active (false = saved but disabled, true = applied during analysis)
    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
    // Overrides — all optional (null = don't override this setting)
    appraisalPresetId: text('appraisal_preset_id')
      .references(() => appraisalRulePreset.id, { onDelete: 'set null' }),
    rehabConfigJson: text('rehab_config_json'),       // same shape as rehab_config.config_json
    tierRangesJson: text('tier_ranges_json'),         // custom tier range definitions (null = inherit from user global)
    dealParamsJson: text('deal_params_json'),         // JSON of DealParamsConfig fields
    majorItemCostsJson: text('major_item_costs_json'), // JSON of Record<MajorItemId, number>
    arvThresholdJson: text('arv_threshold_json'),     // JSON of { percent: number, asIsThresholdPercent?: number }
    proximityConfigJson: text('proximity_config_json'), // JSON of ProximityConfig
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_location_settings_user_id').on(table.userId),
    index('idx_location_settings_zip').on(table.userId, table.zipCode),
    index('idx_location_settings_city').on(table.userId, table.city),
    index('idx_location_settings_state').on(table.userId, table.state),
  ]
)

// ==========================================
// Major Item Costs (per-user repair cost defaults)
// ==========================================

export const majorItemCosts = sqliteTable(
  'major_item_costs',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    // JSON: Record<MajorItemId, number> — only overridden items need to be stored
    // e.g. { "roof": 12000, "hvac": 9500 }
    costsJson: text('costs_json').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_major_item_costs_user_id').on(table.userId)]
)

// ==========================================
// Major Item Settings (per-user permit-age rules: enabled + cost + age threshold)
// ==========================================

export const majorItemSetting = sqliteTable(
  'major_item_setting',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(), // 'roof' | 'hvac' | 'water_heater' | 'electric_panel' | 'replumb' | 'rewire' | ...
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    cost: integer('cost').notNull(), // configured replacement cost
    ageThreshold: integer('age_threshold'), // years — evidence at-or-past this triggers replacement; null = no age rule
    updatedAt: text('updated_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_major_item_setting_user_id').on(table.userId),
    index('idx_major_item_setting_user_item').on(table.userId, table.itemId),
  ]
)

// ==========================================
// GHL Integration Settings (per-user GoHighLevel CRM config)
// ==========================================

export const ghlSettings = sqliteTable(
  'ghl_settings',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** GHL Private Integration API token */
    apiToken: text('api_token').notNull(),
    /** GHL Location ID (for webhook payload validation) */
    locationId: text('location_id').notNull(),
    /** Whether the integration is active */
    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
    /** Auto-generated secret for webhook URL authentication */
    webhookSecret: text('webhook_secret').notNull().$defaultFn(() => crypto.randomUUID()),
    /**
     * Custom field mappings: JSON of Record<AnalysisFieldKey, string>
     * Maps analysis fields (arv, buyPrice, etc.) to GHL custom field IDs
     */
    fieldMappings: text('field_mappings'),
    /** Which analysis field to use for opportunity monetaryValue (default: 'arv') */
    monetaryValueField: text('monetary_value_field').default('arv'),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_ghl_settings_user_id').on(table.userId),
    index('idx_ghl_settings_webhook_secret').on(table.webhookSecret),
  ]
)

// ==========================================
// Waitlist
// ==========================================

export const waitlist = sqliteTable(
  'waitlist',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    email: text('email').notNull().unique(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_waitlist_email').on(table.email),
  ]
)

// ==========================================
// Plan Limits
// ==========================================

export const PLAN_LIMITS = {
  free: {
    monthlyRequests: 100,
    maxApiKeys: 1,
    features: ['property-search', 'comparables'],
  },
  pro: {
    monthlyRequests: 5000,
    maxApiKeys: 5,
    features: ['property-search', 'comparables', 'valuation', 'underwriting', 'reports'],
  },
  enterprise: {
    monthlyRequests: -1, // unlimited
    maxApiKeys: -1,
    features: ['property-search', 'comparables', 'valuation', 'underwriting', 'reports', 'bulk'],
  },
} as const

export type Plan = keyof typeof PLAN_LIMITS

// ==========================================
// Batch Jobs (CSV mass import)
// ==========================================

export const batchJobs = sqliteTable(
  'batch_jobs',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'), // pending | processing | completed | failed
    totalAddresses: integer('total_addresses').notNull(),
    completedCount: integer('completed_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    // JSON arrays
    addressesJson: text('addresses_json').notNull(), // string[] of input addresses
    resultsJson: text('results_json'), // Array<{ address, jobId?, status, error?, arv?, buyPrice? }>
    // Timestamps
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_batch_jobs_user_id').on(table.userId),
    index('idx_batch_jobs_created_at').on(table.createdAt),
  ]
)
