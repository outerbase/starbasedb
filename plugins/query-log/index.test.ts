import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryLogPlugin } from './index'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'

let queryLogPlugin: QueryLogPlugin
let mockDataSource: DataSource
let mockExecutionContext: ExecutionContext

beforeEach(() => {
    vi.clearAllMocks()

    mockExecutionContext = {
        waitUntil: vi.fn(),
    } as unknown as ExecutionContext

    mockDataSource = {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        },
    } as unknown as DataSource

    queryLogPlugin = new QueryLogPlugin({ ctx: mockExecutionContext })
})

describe('QueryLogPlugin - Initialization', () => {
    it('should initialize with default values', () => {
        expect(queryLogPlugin).toBeInstanceOf(QueryLogPlugin)
        expect(queryLogPlugin['ttl']).toBe(1)
        expect(queryLogPlugin['state'].totalTime).toBe(0)
    })
})

describe('QueryLogPlugin - register()', () => {
    it('should execute the query to create the log table', async () => {
        const mockApp = {
            use: vi.fn((middleware) =>
                middleware({ get: vi.fn(() => mockDataSource) }, vi.fn())
            ),
        } as unknown as StarbaseApp

        await queryLogPlugin.register(mockApp)

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS tmp_query_log'
            ),
            params: [],
        })
    })
})

describe('QueryLogPlugin - beforeQuery()', () => {
    it('should set the query state before execution', async () => {
        const sql = 'SELECT * FROM users WHERE id = ?'
        const params = [1]

        const result = await queryLogPlugin.beforeQuery({
            sql,
            params,
            dataSource: mockDataSource,
        })

        expect(queryLogPlugin['state'].query).toBe(sql)
        expect(queryLogPlugin['state'].startTime).toBeInstanceOf(Date)
        expect(result).toEqual({ sql, params })
    })
})

describe('QueryLogPlugin - afterQuery()', () => {
    it('should calculate query duration and insert log', async () => {
        const sql = 'SELECT * FROM users WHERE id = ?'

        await queryLogPlugin.beforeQuery({ sql, dataSource: mockDataSource })
        await new Promise((resolve) => setTimeout(resolve, 10))
        await queryLogPlugin.afterQuery({
            sql,
            result: [],
            isRaw: false,
            dataSource: mockDataSource,
        })

        expect(queryLogPlugin['state'].totalTime).toBeGreaterThan(0)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('INSERT INTO tmp_query_log'),
            params: [sql, expect.any(Number)],
        })
    })

    it('should schedule log expiration using executionContext.waitUntil()', async () => {
        const sql = 'SELECT * FROM users WHERE id = ?'

        await queryLogPlugin.beforeQuery({ sql, dataSource: mockDataSource })
        await queryLogPlugin.afterQuery({
            sql,
            result: [],
            isRaw: false,
            dataSource: mockDataSource,
        })

        expect(mockExecutionContext.waitUntil).toHaveBeenCalledTimes(1)
    })
})

describe('QueryLogPlugin - addQuery()', () => {
    it('should insert query execution details into the log table', async () => {
        queryLogPlugin['state'].query = 'SELECT * FROM test'
        queryLogPlugin['state'].totalTime = 50

        await queryLogPlugin['addQuery'](mockDataSource)

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('INSERT INTO tmp_query_log'),
            params: ['SELECT * FROM test', 50],
        })
    })
})

describe('QueryLogPlugin - expireLog()', () => {
    it('should delete old logs based on TTL', async () => {
        queryLogPlugin['dataSource'] = mockDataSource

        await queryLogPlugin['expireLog']()

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('DELETE FROM tmp_query_log'),
            params: [1],
        })
    })

    it('should return false if no dataSource is available', async () => {
        queryLogPlugin['dataSource'] = undefined

        const result = await queryLogPlugin['expireLog']()
        expect(result).toBe(false)
    })
})
