import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    beforeQueryCache,
    afterQueryCache,
    hasModifyingStatement,
} from './index'
import type { DataSource } from '../types'
import sqlparser from 'node-sql-parser'

const parser = new sqlparser.Parser()

let mockDataSource: DataSource

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        cache: true,
        cacheTTL: 120,
        rpc: {
            executeQuery: vi.fn(),
        },
    } as any
})

describe('Cache Module', () => {
    describe('beforeQueryCache', () => {
        it('should return null if caching is disabled', async () => {
            mockDataSource.cache = false
            const result = await beforeQueryCache({
                sql: 'SELECT * FROM users',
                params: [],
                dataSource: mockDataSource,
            })

            expect(result).toBeNull()
        })

        it('should return null if query has parameters', async () => {
            const result = await beforeQueryCache({
                sql: 'SELECT * FROM users WHERE id = ?',
                params: [1],
                dataSource: mockDataSource,
            })

            expect(result).toBeNull()
        })

        it('should return null if query is modifying (INSERT)', async () => {
            const result = await beforeQueryCache({
                sql: 'INSERT INTO users (id, name) VALUES (1, "John")',
                params: [],
                dataSource: mockDataSource,
            })

            expect(result).toBeNull()
        })

        it('should return cached result if present and valid', async () => {
            const cachedData = {
                timestamp: new Date().toISOString(),
                ttl: 300,
                results: JSON.stringify([{ id: 1, name: 'John' }]),
            }

            vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
                cachedData,
            ])

            const result = await beforeQueryCache({
                sql: 'SELECT * FROM users',
                params: [],
                dataSource: mockDataSource,
            })

            expect(result).toEqual([{ id: 1, name: 'John' }])
        })

        it('should return null if cache is expired', async () => {
            const expiredCache = {
                timestamp: new Date(Date.now() - 1000 * 3600).toISOString(), // 1 hour old
                ttl: 300,
                results: JSON.stringify([{ id: 1, name: 'John' }]),
            }

            vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
                expiredCache,
            ])

            const result = await beforeQueryCache({
                sql: 'SELECT * FROM users',
                params: [],
                dataSource: mockDataSource,
            })

            expect(result).toBeNull()
        })
    })

    describe('afterQueryCache', () => {
        it('should not cache queries with parameters', async () => {
            await afterQueryCache({
                sql: 'SELECT * FROM users WHERE id = ?',
                params: [1],
                result: [{ id: 1, name: 'John' }],
                dataSource: mockDataSource,
            })

            expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
        })

        it('should not cache modifying queries (UPDATE)', async () => {
            await afterQueryCache({
                sql: 'UPDATE users SET name = "John" WHERE id = 1',
                params: [],
                result: [{ id: 1, name: 'John' }],
                dataSource: mockDataSource,
            })

            expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
        })

        it('should insert new cache entry if query not cached', async () => {
            vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])

            await afterQueryCache({
                sql: 'SELECT * FROM users',
                params: [],
                result: [{ id: 1, name: 'John' }],
                dataSource: mockDataSource,
            })

            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
                sql: 'INSERT INTO tmp_cache (timestamp, ttl, query, results) VALUES (?, ?, ?, ?)',
                params: expect.any(Array),
            })
        })

        it('should update existing cache entry', async () => {
            vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([1])

            await afterQueryCache({
                sql: 'SELECT * FROM users',
                params: [],
                result: [{ id: 1, name: 'John' }],
                dataSource: mockDataSource,
            })

            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
                sql: 'UPDATE tmp_cache SET timestamp = ?, results = ? WHERE query = ?',
                params: expect.any(Array),
            })
        })
    })

    describe('hasModifyingStatement', () => {
        function testModifyingSQL(sql: string, expected: boolean) {
            const ast = parser.astify(sql, { database: 'sqlite' })
            expect(hasModifyingStatement(ast)).toBe(expected)
        }

        it('should return true for INSERT', () => {
            testModifyingSQL(
                'INSERT INTO users (id, name) VALUES (1, "John")',
                true
            )
        })

        it('should return true for UPDATE', () => {
            testModifyingSQL(
                'UPDATE users SET name = "John" WHERE id = 1',
                true
            )
        })

        it('should return true for DELETE', () => {
            testModifyingSQL('DELETE FROM users WHERE id = 1', true)
        })

        it('should return false for SELECT', () => {
            testModifyingSQL('SELECT * FROM users', false)
        })

        it('should return false for SELECT with JOIN', () => {
            testModifyingSQL(
                'SELECT users.id, orders.amount FROM users JOIN orders ON users.id = orders.user_id',
                false
            )
        })
    })
})
