import { describe, it, expect } from 'vitest';
import { formatResponse, handleError, isValidId } from './helpers';

describe('formatResponse', () => {
  it('should format a successful response', () => {
    const result = formatResponse({ data: [1, 2, 3] });
    expect(result).toEqual({
      success: true,
      data: [1, 2, 3],
    });
  });

  it('should format an empty response', () => {
    const result = formatResponse(null);
    expect(result).toEqual({
      success: true,
      data: null,
    });
  });

  it('should format response with empty array', () => {
    const result = formatResponse([]);
    expect(result).toEqual({
      success: true,
      data: [],
    });
  });
});

describe('handleError', () => {
  it('should handle error messages', () => {
    const result = handleError('Something went wrong');
    expect(result).toEqual({
      success: false,
      error: 'Something went wrong',
      status: 500,
    });
  });

  it('should handle errors with custom status codes', () => {
    const result = handleError('Not found', 404);
    expect(result).toEqual({
      success: false,
      error: 'Not found',
      status: 404,
    });
  });

  it('should handle null/undefined errors gracefully', () => {
    const result = handleError(undefined as any);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('isValidId', () => {
  it('should return true for valid numeric IDs', () => {
    expect(isValidId('123')).toBe(true);
    expect(isValidId('0')).toBe(true);
    expect(isValidId('999999')).toBe(true);
  });

  it('should return false for invalid IDs', () => {
    expect(isValidId('abc')).toBe(false);
    expect(isValidId('')).toBe(false);
    expect(isValidId('-1')).toBe(false);
    expect(isValidId(null as any)).toBe(false);
    expect(isValidId(undefined as any)).toBe(false);
  });
});
