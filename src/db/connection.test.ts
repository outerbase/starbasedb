import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock better-sqlite3 before importing connection
const mockDb = {
  close: vi.fn(),
  prepare: vi.fn(),
  exec: vi.fn(),
  compile: vi.fn(),
};

vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn(() => mockDb),
  };
});

import { getDatabasePool, pool } from './connection';

describe('Database Connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getDatabasePool', () => {
    it('should return a database pool instance', () => {
      const result = getDatabasePool();
      expect(result).toBeDefined();
      expect(result).not.toBeNull();
    });

    it('should return the same instance on subsequent calls (singleton)', () => {
      const result1 = getDatabasePool();
      const result2 = getDatabasePool();
      expect(result1).toBe(result2);
    });

    it('should close the database connection', () => {
      const db = getDatabasePool();
      db.close();
      expect(mockDb.close).toHaveBeenCalled();
    });
  });

  describe('pool', () => {
    it('should be a valid database instance', () => {
      expect(pool).toBeDefined();
      expect(typeof pool.close).toBe('function');
    });
  });
});
