/**
 * FastAPI Bridge for Dashboard
 *
 * This module provides a bridge between the existing Next.js dashboard
 * and the new FastAPI evaluator service, handling authentication 
 * translation while preserving all UI components.
 */

import { getImpersonatedUserId } from '@/components/auth/ImpersonationProvider'

// API URL - inlined at build time via next.config.js  
const API_URL = process.env.NEXT_PUBLIC_API_URL!

/**
 * Interface for FastAPI evaluation submission
 */
export interface EvaluationSubmission {
  property: {
    address: string;
    city: string;
    state: string;
    zip: string;
    // Additional property fields as needed
  };
  presetId?: string;
  // Other evaluation parameters
}

/**
 * Response from FastAPI evaluation endpoint
 */
export interface EvaluationResponse {
  batch_id: string;
  status: string;
  created_or_reused: string;
  evaluations: Array<{
    evaluation_id: string;
    idempotency_key: string;
    status: string;
    created_or_reused: string;
  }>;
}

/**
 * Authentication context for FastAPI service
 */
interface AuthContext {
  tenantId: string;
  userId: string;
  token: string; // Bearer token in the format "Bearer <token>"
}

/**
 * Get authentication information from session storage or environment
 * Note: In a real implementation, this would be replaced with actual auth fetching logic
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  try {
    // This is a placeholder - in reality, this would need to be implemented 
    // to handle token management for FastAPI authentication
    const tenantId = process.env.NEXT_PUBLIC_DEFAULT_TENANT || 'default';
    const userId = process.env.NEXT_PUBLIC_DEFAULT_USER || 'service';
    
    // In practice, we'd fetch a real token from somewhere accessible to the client
    // This is just a placeholder showing what information would be needed
    return {
      tenantId,
      userId,
      token: '' // Would contain actual Bearer token 
    };
  } catch (error) {
    console.error('Failed to get authentication context:', error);
    return null;
  }
}

/**
 * Submit evaluation batch using FastAPI endpoint with proper authentication
 */
export async function submitEvaluationBatch(
  submissions: EvaluationSubmission[],
  idempotencyKey?: string
): Promise<EvaluationResponse> {
  // Get auth information 
  const authContext = await getAuthContext();
  if (!authContext) {
    throw new Error('Authentication context not available');
  }

  try {
    // Inject impersonation header if admin is impersonating a user  
    const impersonateId = getImpersonatedUserId();
    const impersonateHeaders: Record<string, string> = impersonateId
      ? { 'X-Impersonate-User-Id': impersonateId }
      : {};

    const requestBody = {
      evaluations: submissions
    };

    // Prepare the request with FastAPI authentication headers  
    const response = await fetch(`${API_URL}/v1/evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authContext.token,
        'Idempotency-Key': idempotencyKey || `batch-${Date.now()}`,
        ...impersonateHeaders
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error((errorData as { error?: string }).error || `API error: ${response.status}`);
    }

    return response.json();
  } catch (error) {
    console.error('Failed to submit evaluation batch:', error);
    throw error;
  }
}

/**
 * Get evaluation status from FastAPI service
 */
export async function getEvaluationStatus(
  evaluationId: string
): Promise<any> {
  const authContext = await getAuthContext();
  if (!authContext) {
    throw new Error('Authentication context not available');
  }

  try {
    const response = await fetch(`${API_URL}/v1/evaluations/${evaluationId}`, {
      method: 'GET',
      headers: {
        'Authorization': authContext.token,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error((errorData as { error?: string }).error || `API error: ${response.status}`);
    }

    return response.json();
  } catch (error) {
    console.error('Failed to get evaluation status:', error);
    throw error;
  }
}

/**
 * Get batch details from FastAPI service
 */
export async function getBatchDetails(
  batchId: string
): Promise<any> {
  const authContext = await getAuthContext();
  if (!authContext) {
    throw new Error('Authentication context not available');
  }

  try {
    const response = await fetch(`${API_URL}/v1/evaluation-batches/${batchId}`, {
      method: 'GET',
      headers: {
        'Authorization': authContext.token,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error((errorData as { error?: string }).error || `API error: ${response.status}`);
    }

    return response.json();
  } catch (error) {
    console.error('Failed to get batch details:', error);
    throw error;
  }
}

/**
 * Poll for evaluation completion
 */
export async function pollEvaluation(
  evaluationId: string,
  timeoutMs = 30000,
  intervalMs = 1000
): Promise<any> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await getEvaluationStatus(evaluationId);
      
      // If completed, return result 
      if (status.status === 'SUCCEEDED' || status.status === 'FAILED') {
        return status;
      }
      
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    } catch (error) {
      console.error('Polling error:', error);
      throw error; 
    }
  }
  
  throw new Error('Evaluation timeout exceeded');
}