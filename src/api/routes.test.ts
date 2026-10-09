import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouter } from './router';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('createRouter', () => {
  it('should create a router instance', () => {
    const router = createRouter();
    expect(router).toBeDefined();
  });
});
