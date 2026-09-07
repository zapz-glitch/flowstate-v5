/**
 * FastAPI Bridge Configuration
 *
 * Configuration for the TypeScript bridge between dashboard and FastAPI evaluator.
 */

// The base URL of the FastAPI service (this would be overridden by environment)
export const FASTAPI_BASE_URL = process.env.NEXT_PUBLIC_FASTAPI_URL || 
  process.env.NEXT_PUBLIC_API_URL || 
  'http://localhost:8004';

// Default tenant and user for authentication
export const DEFAULT_TENANT_ID = process.env.NEXT_PUBLIC_DEFAULT_TENANT || 'default';
export const DEFAULT_USER_ID = process.env.NEXT_PUBLIC_DEFAULT_USER || 'service';

// Timeout settings for API calls
export const API_TIMEOUT_MS = 30000;
export const POLLING_INTERVAL_MS = 1000;

// Batch size limits 
export const MAX_BATCH_SIZE = 50;

// Authentication headers configuration  
export const AUTH_HEADER_NAME = 'Authorization';
export const IDEMPOTENCY_HEADER_NAME = 'Idempotency-Key';

// FastAPI endpoints
export const FASTAPI_ENDPOINTS = {
  SUBMIT_EVALUATION: '/v1/evaluations',
  GET_EVALUATION: '/v1/evaluations/{id}',
  GET_BATCH: '/v1/evaluation-batches/{batch_id}',
} as const;