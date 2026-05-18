import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SqlMacrosPlugin } from './index'

// Mock node-sql-parser
vi.mock('node-sql-parser', () => {
    return {
        Parser: vi.fn().mockImplementation(() => ({
            astify: vi.fn().mockImplementation((sql: string) => {
                if (sql.includes('SELECT *')) {
                    return [{ type: 'select', columns: [{ expr: { type: 'star' } }] }]
                }
                if (sql.includes('__exclude')) {
                    return [{ 
                        type: 'select', 
                        columns: [{ expr: { type: 'function', name: '__exclude', args: { value: [{ column: 'secret' }] } } }],
                        from: [{ table: 'users' }]
                    }]
                }
                return [{ type: 'select', columns: [{ expr: { type: 'column_ref', column: 'id' } }] }]
            }),
            sqlify: vi.fn().mockImplementation((ast: any) => 'SELECT id FROM users'),
        })),
    }
})

describe('SqlMacrosPlugin', () => {
    let mockDataSource: any
    let plugin: SqlMacrosPlugin

    beforeEach(() => {
        vi.clearAllMocks()
        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn(),
            },
        }
        plugin = new SqlMacrosPlugin({ preventSelectStar: true })
    })

    it('should throw error if SELECT * is not allowed and user is not admin', async () => {
        // @ts-ignore - setting private config for test
        plugin.config = { role: 'client' }
        
        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: mockDataSource,
            })
        ).rejects.toThrow('SELECT * is not allowed')
    })

    it('should allow SELECT * if user is admin', async () => {
        // @ts-ignore
        plugin.config = { role: 'admin' }
        
        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
            dataSource: mockDataSource,
        })
        expect(result.sql).toBe('SELECT * FROM users')
    })

    it('should expand $_exclude columns for internal data source', async () => {
        mockDataSource.rpc.executeQuery.mockResolvedValueOnce([
            { column_name: 'id' },
            { column_name: 'secret' },
        ])

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(secret) FROM users',
            dataSource: mockDataSource,
        })

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({ sql: expect.stringContaining('pragma_table_info') })
        )
        expect(result.sql).toBe('SELECT id FROM users')
    })

    it('should not expand $_exclude for non-internal data source', async () => {
        mockDataSource.source = 'external'
        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(secret) FROM users',
            dataSource: mockDataSource,
        })
        expect(result.sql).toBe('SELECT $_exclude(secret) FROM users')
    })
})
