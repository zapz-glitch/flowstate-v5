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
    // Key metrics for quick display
    arv: real('arv'),
    asIsValue: real('as_is_value'),
    maxAllowableOffer: real('max_allowable_offer'),
    estimatedRepairs: real('estimated_repairs'),
    // Timestamps
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_saved_reports_user_id').on(table.userId),
    index('idx_saved_reports_created_at').on(table.createdAt),
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
