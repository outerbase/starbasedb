import { expect, test, vi } from 'vitest'
import { isQueryAllowed } from './index'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

test('isQueryAllowed should return true if isEnabled is false', async () => {
    const mockDataSource = {} as DataSource
    const mockConfig = {} as StarbaseDBConfiguration

    const result = await isQueryAllowed({
        sql: 'SELECT * FROM users',
        isEnabled: false,
        dataSource: mockDataSource,
        config: mockConfig,
    })

    expect(result).toBe(true)
})

test('isQueryAllowed should return true if config.role is admin', async () => {
    const mockDataSource = {} as DataSource
    const mockConfig = { role: 'admin' } as StarbaseDBConfiguration

    const result = await isQueryAllowed({
        sql: 'SELECT * FROM users',
        isEnabled: true,
        dataSource: mockDataSource,
        config: mockConfig,
    })

    expect(result).toBe(true)
})

test('isQueryAllowed should return an Error if no SQL is provided', async () => {
    const mockDataSource = {
        source: 'test-source',
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        },
    } as unknown as DataSource
    const mockConfig = { role: 'user' } as StarbaseDBConfiguration

    const result = await isQueryAllowed({
        sql: '',
        isEnabled: true,
        dataSource: mockDataSource,
        config: mockConfig,
    })

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe(
        'No SQL provided for allowlist check'
    )
})

test('isQueryAllowed should allow matching queries in allowlist', async () => {
    const mockExecuteQuery = vi
        .fn()
        .mockResolvedValue([
            { sql_statement: 'SELECT * FROM users;', source: 'test-source' },
        ])
    const mockDataSource = {
        source: 'test-source',
        rpc: {
            executeQuery: mockExecuteQuery,
        },
    } as unknown as DataSource
    const mockConfig = { role: 'user' } as StarbaseDBConfiguration

    const result = await isQueryAllowed({
        sql: 'SELECT * FROM users',
        isEnabled: true,
        dataSource: mockDataSource,
        config: mockConfig,
    })

    expect(result).toBe(true)
    expect(mockExecuteQuery).toHaveBeenCalledWith({
        sql: 'SELECT sql_statement, source FROM tmp_allowlist_queries WHERE source="test-source"',
    })
})

test('isQueryAllowed should reject and audit queries not in allowlist', async () => {
    const mockExecuteQuery = vi
        .fn()
        .mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'test-source' },
        ])
    const mockDataSource = {
        source: 'test-source',
        rpc: {
            executeQuery: mockExecuteQuery,
        },
    } as unknown as DataSource
    const mockConfig = { role: 'user' } as StarbaseDBConfiguration

    await expect(
        isQueryAllowed({
            sql: 'DELETE FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
    ).rejects.toThrow('Query not allowed')

    expect(mockExecuteQuery).toHaveBeenLastCalledWith({
        sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
        params: ['DELETE FROM users', 'test-source'],
    })
})

test('isQueryAllowed should handle loadAllowlist query execution failure gracefully', async () => {
    const mockExecuteQuery = vi
        .fn()
        .mockRejectedValue(new Error('DB Connection Error'))
    const mockDataSource = {
        source: 'test-source',
        rpc: {
            executeQuery: mockExecuteQuery,
        },
    } as unknown as DataSource
    const mockConfig = { role: 'user' } as StarbaseDBConfiguration

    await expect(
        isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
    ).rejects.toThrow('Query not allowed')
})
