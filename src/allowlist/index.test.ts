import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('node-sql-parser', () => ({
  Parser: class {
    astify(sql: string) {
      return { type: 'select', sql }
    }
  },
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
  vi.clearAllMocks()

  mockDataSource = {
    source: 'internal',
    rpc: {
      executeQuery: vi.fn().mockResolvedValue([
        { sql_statement: 'SELECT * FROM users', source: 'internal' },
      ]),
    },
  } as any

  mockConfig = {
    outerbaseApiKey: 'test-key',
    role: 'client',
    features: { allowlist: false, rls: false, rest: true },
  }
})

describe('isQueryAllowed', () => {
  it('should return true when allowlist is not enabled', async () => {
    const result = await isQueryAllowed({
      sql: 'SELECT * FROM users',
      isEnabled: false,
      dataSource: mockDataSource,
      config: mockConfig,
    })

    expect(result).toBe(true)
  })

  it('should return true for admin role regardless of allowlist', async () => {
    mockConfig.role = 'admin'

    const result = await isQueryAllowed({
      sql: 'SELECT * FROM users',
      isEnabled: true,
      dataSource: mockDataSource,
      config: mockConfig,
    })

    expect(result).toBe(true)
  })

  it('should return error when SQL is empty', async () => {
    const result = await isQueryAllowed({
      sql: '',
      isEnabled: true,
      dataSource: mockDataSource,
      config: { ...mockConfig, role: 'client' },
    })

    expect(result instanceof Error).toBe(true)
    expect((result as Error).message).toBe('No SQL provided for allowlist check')
  })

  it('should throw error when query is not in allowlist', async () => {
    await expect(
      isQueryAllowed({
        sql: 'DROP TABLE users',
        isEnabled: true,
        dataSource: mockDataSource,
        config: { ...mockConfig, role: 'client' },
      })
    ).rejects.toThrow('Query not allowed')
  })

  it('should handle errors from loadAllowlist gracefully', async () => {
    mockDataSource.rpc.executeQuery = vi.fn().mockRejectedValue(new Error('DB error'))

    await expect(
      isQueryAllowed({
        sql: 'SELECT * FROM users',
        isEnabled: true,
        dataSource: mockDataSource,
        config: { ...mockConfig, role: 'client' },
      })
    ).rejects.toThrow()
  })

  it('should normalize trailing semicolons from SQL', async () => {
    mockDataSource.rpc.executeQuery = vi.fn().mockResolvedValue([
      { sql_statement: 'SELECT * FROM users', source: 'internal' },
    ])

    const result = await isQueryAllowed({
      sql: 'SELECT * FROM users;',
      isEnabled: true,
      dataSource: mockDataSource,
      config: { ...mockConfig, role: 'client' },
    })

    expect(result).toBe(true)
  })
})
