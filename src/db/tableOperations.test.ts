import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeQuery, getTableInfo } from './tableOperations';

// Mock the connection module
const mockPrepare = vi.fn();
const mockMockStmt = {
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  bind: vi.fn().mockReturnValue({ get: vi.fn() }),
};

vi.mock('../db/connection', () => ({
  getDatabasePool: vi.fn(() => ({
    prepare: mockPrepare.mockReturnValue(mockMockStmt),
    close: vi.fn(),
  })),
}));

describe('executeQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute a select query', async () => {
    mockMockStmt.all.mockReturnValue([{ id: 1, name: 'test' }]);
    const result = await executeQuery('SELECT * FROM users');
    expect(result).toEqual([{ id: 1, name: 'test' }]);
    expect(mockPrepare).toHaveBeenCalledWith('SELECT * FROM users');
  });

  it('should execute a query with parameters', async () => {
    mockMockStmt.all.mockReturnValue([{ id: 1 }]);
    const result = await executeQuery('SELECT * FROM users WHERE id = ?', [1]);
    expect(result).toEqual([{ id: 1 }]);
    expect(mockMockStmt.bind).toHaveBeenCalledWith(1);
  });

  it('should throw error for invalid queries', async () => {
    mockPrepare.mockImplementation(() => {
      throw new Error('SQL error');
    });
    await expect(executeQuery('INVALID SQL')).rejects.toThrow('SQL error');
  });
});

describe('getTableInfo', () => {
  it('should return table info for valid table', async () => {
    mockMockStmt.all.mockReturnValue([{ name: 'id', type: 'INTEGER' }]);
    const result = await getTableInfo('users');
    expect(result).toEqual([{ name: 'id', type: 'INTEGER' }]);
  });

  it('should return empty array for non-existent table', async () => {
    mockMockStmt.all.mockReturnValue([]);
    const result = await getTableInfo('nonexistent');
    expect(result).toEqual([]);
  });
});
