/**
 * FastAPI Integration Example
 *
 * Example showing how the bridge would be integrated with existing dashboard components.
 */

import { 
  submitEvaluationBatch, 
  getEvaluationStatus,
  pollEvaluation 
} from './fastapi-bridge';
import { EvaluationSubmission } from './fastapi-bridge';

/**
 * Example usage for batch evaluation submission in dashboard
 */
export async function handleBatchSubmission(
  propertyList: Array<{address: string, city: string, state: string, zip: string}>
): Promise<string> {
  
  try {
    // Convert property data to FastAPI format 
    const submissions: EvaluationSubmission[] = propertyList.map(property => ({
      property: {
        address: property.address,
        city: property.city,
        state: property.state,
        zip: property.zip
      }
    }));

    // Submit batch using the bridge
    const response = await submitEvaluationBatch(
      submissions, 
      `batch-${Date.now()}`
    );
    
    console.log('Batch submitted successfully:', response.batch_id);
    
    return response.batch_id;
  } catch (error) {
    console.error('Failed to submit evaluation batch:', error);
    throw error;
  }
}

/**
 * Example usage for polling evaluation results
 */
export async function waitForEvaluationCompletion(
  evaluationId: string,
  timeoutMs = 30000
): Promise<any> {
  
  try {
    // Poll for completion using the bridge 
    const result = await pollEvaluation(evaluationId, timeoutMs);
    
    console.log('Evaluation completed:', result.status);
    return result;
  } catch (error) {
    console.error('Evaluation polling failed:', error);
    throw error;
  }
}

/**
 * Integration point example - how this would be used in a dashboard component
 */
export async function processPropertyEvaluation(
  propertyData: {address: string, city: string, state: string, zip: string}
): Promise<any> {
  
  try {
    // Create submission 
    const submission = {
      property: propertyData
    };
    
    // Submit single evaluation
    const response = await submitEvaluationBatch([submission], `single-${Date.now()}`);
    
    if (response.evaluations.length > 0) {
      const evalId = response.evaluations[0].evaluation_id;
      
      // Wait for completion 
      return await waitForEvaluationCompletion(evalId);
    }
    
    throw new Error('No evaluation created');
  } catch (error) {
    console.error('Property evaluation failed:', error);
    throw error;
  }
}