/**
 * FastAPI Bridge Tests
 *
 * Test file demonstrating how the TypeScript bridge would work with 
 * the new FastAPI evaluator service.
 */

import { submitEvaluationBatch, getEvaluationStatus, getBatchDetails } from './fastapi-bridge';
import { FASTAPI_BASE_URL } from './fastapi-config';

// Mock test data
const mockSubmission = {
  property: {
    address: "123 Main St",
    city: "Anytown", 
    state: "CA",
    zip: "12345"
  }
};

const mockBatchId = "batch-123";
const mockEvaluationId = "eval-456";

describe('FastAPI Bridge', () => {
  
  beforeEach(() => {
    // Mock the global fetch function
    global.fetch = jest.fn();
  });

  afterEach(() => {
    // Clear mocks after each test
    jest.clearAllMocks();
  });

  it('should submit evaluation batch to FastAPI endpoint', async () => {
    const mockResponse = {
      batch_id: mockBatchId,
      status: 'PENDING',
      created_or_reused: 'created',
      evaluations: [
        {
          evaluation_id: mockEvaluationId,
          idempotency_key: 'key-789',
          status: 'PENDING', 
          created_or_reused: 'created'
        }
      ]
    };

    // Mock fetch response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
      status: 202
    });

    const result = await submitEvaluationBatch([mockSubmission], 'batch-key-123');
    
    expect(result.batch_id).toBe(mockBatchId);
    expect(result.status).toBe('PENDING');
    expect(global.fetch).toHaveBeenCalledWith(
      `${FASTAPI_BASE_URL}/v1/evaluations`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Authorization': expect.any(String), // Would contain actual token
          'Idempotency-Key': 'batch-key-123'
        })
      })
    );
  });

  it('should get evaluation status from FastAPI endpoint', async () => {
    const mockStatus = {
      id: mockEvaluationId,
      status: 'SUCCEEDED',
      result: { arv: 500000 }
    };

    // Mock fetch response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockStatus),
      status: 200
    });

    const result = await getEvaluationStatus(mockEvaluationId);
    
    expect(result.id).toBe(mockEvaluationId);
    expect(result.status).toBe('SUCCEEDED');
    
    expect(global.fetch).toHaveBeenCalledWith(
      `${FASTAPI_BASE_URL}/v1/evaluations/${mockEvaluationId}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'Authorization': expect.any(String)
        })
      })
    );
  });

  it('should get batch details from FastAPI endpoint', async () => {
    const mockBatch = {
      id: mockBatchId,
      status: 'COMPLETED',
      evaluations: []
    };

    // Mock fetch response
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockBatch),
      status: 200
    });

    const result = await getBatchDetails(mockBatchId);
    
    expect(result.id).toBe(mockBatchId);
    expect(result.status).toBe('COMPLETED');
    
    expect(global.fetch).toHaveBeenCalledWith(
      `${FASTAPI_BASE_URL}/v1/evaluation-batches/${mockBatchId}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'Authorization': expect.any(String)
        })
      })
    );
  });
});