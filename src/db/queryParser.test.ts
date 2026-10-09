import { describe, it, expect } from 'vitest';
import { parseQueryParams, validateTableName, sanitizeColumn } from './queryParser';

describe('parseQueryParams', () => {
  it('should parse query params from URL string', () => {
    const result = parseQueryParams('table=users&page=1&limit=10');
    expect(result).toEqual({
      table: 'users',
      page: '1',
      limit: '10',
    });
  });

  it('should return empty object for empty query string', () => {
    const result = parseQueryParams('');
    expect(result).toEqual({});
  });

  it('should handle missing values', () => {
    const result = parseQueryParams('table=users&nocache');
    expect(result).toHaveProperty('table', 'users');
    expect(result).toHaveProperty('nocache', '');
  });

  it('should handle URL-encoded characters', () => {
    const result = parseQueryParams('table=user%20data&page=1');
    expect(result).toEqual({
      table: 'user data',
      page: '1',
    });
  });
});

describe('validateTableName', () => {
  it('should accept valid table names', () => {
    expect(validateTableName('users')).toBe(true);
    expect(validateTableName('user_data')).toBe(true);
    expect(validateTableName('User123')).toBe(true);
    expect(validateTableName('users123')).toBe(true);
  });

  it('should reject invalid table names', () => {
    expect(validateTableName('')).toBe(false);
    expect(validateTableName('table; DROP TABLE users')).toBe(false);
    expect(validateTableName('schema.users')).toBe(false);
    expect(validateTableName('user names')).toBe(false);
    expect(validateTableName('users,admin')).toBe(false);
    expect(validateTableName('--comment')).toBe(false);
  });

  it('should reject null or undefined', () => {
    expect(validateTableName(null as any)).toBe(false);
    expect(validateTableName(undefined as any)).toBe(false);
  });

  it('should reject table names with SQL injection attempts', () => {
    expect(validateTableName('users; DELETE FROM users')).toBe(false);
    expect(validateTableName('users UNION SELECT * FROM secrets')).toBe(false);
    expect(validateTableName('users' + String.fromCharCode(0) + 'admin')).toBe(false);
  });
});

describe('sanitizeColumn', () => {
  it('should sanitize valid column names', () => {
    expect(sanitizeColumn('username')).toBe('username');
    expect(sanitizeColumn('user_name')).toBe('user_name');
    expect(sanitizeColumn('User123')).toBe('User123');
    expect(sanitizeColumn('createdAt')).toBe('createdAt');
  });

  it('should reject invalid column names', () => {
    expect(sanitizeColumn('')).toBe('');
    expect(sanitizeColumn('column; DROP TABLE')).toBe('');
    expect(sanitizeColumn('col name')).toBe('');
    expect(sanitizeColumn('col;name')).toBe('');
  });
});
