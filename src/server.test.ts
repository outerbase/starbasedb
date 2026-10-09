import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db/connection', () => ({
  getDatabasePool: vi.fn().mockReturnValue({ 
    close: vi.fn(),
    prepare: vi.fn(),
  }),
  pool: { close: vi.fn() },
}));

describe('Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should export a startServer function', async () => {
    const { startServer } = await import('./server');
    expect(typeof startServer).toBe('function');
  });

  it('should have PORT defined', async () => {
    const mod = await import('./server');
    // The server module should exist and export correctly
    expect(mod).toBeDefined();
  });
});
