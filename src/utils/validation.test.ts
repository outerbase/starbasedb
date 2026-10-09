import { describe, it, expect } from 'vitest';
import { validateRequest, validateTableParam, validatePageParams } from './validation';

describe('validateRequest', () => {
  it('should validate a proper request object', () => {
    const result = validateRequest({ table: 'users' });
    expect(result.valid).toBe(true);
  });

  it('should reject request without table', () => {
    const result = validateRequest({});
    expect(result.valid).toBe(false);
  });

  it('should reject request with invalid table name', () => {
    const result = validateRequest({ table: 'bad;table' });
    expect(result.valid).toBe(false);
  });
});

describe('validateTableParam', () => {
  it('should accept valid table parameter', () => {
    expect(validateTableParam('users')).toBe(true);
    expect(validateTableParam('order_items')).toBe(true);
  });

  it('should reject SQL injection attempts', () => {
    expect(validateTableParam('users; DROP TABLE')).toBe(false);
    expect(validateTableParam('users UNION SELECT')).toBe(false);
    expect(validateTableParam('-- comment')).toBe(false);
  });
});

describe('validatePageParams', () => {
  it('should validate valid page numbers', () => {
    const result = validatePageParams('1');
    expect(result).toEqual({ page: 1, limit: 10 });
  });

  it('should handle missing page parameter', () => {
    const result = validatePageParams(undefined);
    expect(result.page).toBe(1);
  });

  it('should reject negative page numbers', () => {
    const result = validatePageParams('-1');
    expect(result.page).toBeGreaterThan(0);
  });
});
