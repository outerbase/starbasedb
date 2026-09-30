import { beforeEach, expect, it, vi } from 'vitest'
import { isQueryAllowed } from './index'
let source: any
const config = { role: 'client' } as any
beforeEach(() => {
    source = {
        source: 'internal',
        rpc: { executeQuery: vi.fn().mockResolvedValue([]) },
    }
})
const check = (sql: string, isEnabled = true, configuration = config) =>
    isQueryAllowed({
        sql,
        isEnabled,
        dataSource: source,
        config: configuration,
    })
it('bypasses disabled allowlist without storage access', async () => {
    expect(await check('SELECT 1', false)).toBe(true)
    expect(source.rpc.executeQuery).not.toHaveBeenCalled()
})
it('bypasses explicit administrator', async () => {
    expect(await check('SELECT 1', true, { role: 'admin' })).toBe(true)
    expect(source.rpc.executeQuery).not.toHaveBeenCalled()
})
it('matches whitespace and trailing semicolon after source filtering', async () => {
    source.rpc.executeQuery.mockResolvedValue([
        { source: 'external', sql_statement: 'SELECT 9' },
        {
            source: 'internal',
            sql_statement: 'SELECT id FROM users WHERE id = 1',
        },
    ])
    expect(await check(' SELECT id FROM users WHERE id = 1; ')).toBe(true)
})
it.each([
    'SELECT id FROM users WHERE id = 2',
    'SELECT id, name FROM users WHERE id = 1',
    'SELECT id FROM users',
    'DELETE FROM users',
    'SELECT id FROM users WHERE id IN (1,2)',
])('rejects changed query structure or values: %s', async (sql) => {
    source.rpc.executeQuery.mockResolvedValueOnce([
        {
            source: 'internal',
            sql_statement: 'SELECT id FROM users WHERE id = 1',
        },
    ])
    await expect(check(sql)).rejects.toThrow('Query not allowed')
    expect(source.rpc.executeQuery).toHaveBeenLastCalledWith({
        sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
        params: [sql, 'internal'],
    })
})
it('returns the empty-query error contract', async () => {
    expect(await check('')).toBeInstanceOf(Error)
})
it('rejects malformed SQL', async () => {
    await expect(check('not valid SQL @@')).rejects.toThrow()
})
it('denies when policy storage fails', async () => {
    source.rpc.executeQuery.mockRejectedValue(new Error('offline'))
    await expect(check('SELECT 1')).rejects.toThrow('Query not allowed')
})
it('keeps rejection even if audit insertion fails', async () => {
    source.rpc.executeQuery
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('audit failed'))
    await expect(check('SELECT 1')).rejects.toThrow('Query not allowed')
})
it('records an audit result returned by storage', async () => {
    source.rpc.executeQuery
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ sql_statement: 'SELECT 1' }])
    await expect(check('SELECT 1')).rejects.toThrow('Query not allowed')
})
