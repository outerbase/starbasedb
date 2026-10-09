import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRequest, formatResponse, handleError } from '../utils/helpers';

// Mock the db module
const mockPool = {
  prepare: vi.fn(),
  close: vi.fn(),
};

vi.mock('../db/connection', () => ({
  getDatabasePool: vi.fn(() => mockPool),
}));

describe('formatResponse', () => {
  it('should format a successful response with data', () => {
    const result = formatResponse([1, 2, 3]);
    expect(result).toEqual({
      success: true,
      data: [1, 2, 3],
    });
  });

  it('should format a successful response with null data', () => {
    const result = formatResponse(null);
    expect(result).toEqual({
      success: true,
      data: null,
    });
  });

  it('should format a successful response with empty array', () => {
    const result = formatResponse([]);
    expect(result).toEqual({
      success: true,
      data: [],
    });
  });
});

describe('handleError', () => {
  it('should handle error with message only', () => {
    const result = handleError('Something went wrong');
    expect(result).toEqual({
      success: false,
      error: 'Something went wrong',
    });
  });

  it('should handle error with message and status', () => {
    const result = handleError('Not found', 404);
    expect(result).toEqual({
      success: false,
      error: 'Not found',
      status: 404,
    });
  });

  it('should handle error with default status 500', () => {
    const result = handleError('Internal error');
    expect(result).toEqual({
      success: false,
      error: 'Internal error',
      status: 500,
    });
  });
});
