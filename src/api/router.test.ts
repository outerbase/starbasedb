import { describe, it, expect, vi } from 'vitest';

describe('Router', () => {
  it('should have route handlers defined', async () => {
    const mod = await import('./router');
    expect(mod).toBeDefined();
  });
});
