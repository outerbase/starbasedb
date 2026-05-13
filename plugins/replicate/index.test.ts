import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicatePlugin } from './index'

function makeDataSource(externalRows: Record<string, unknown>[] = []) {
    const internalStore: Record<string, unknown>[][] = []
    return {
        source: 'external' as const,
        external: { dialect: 'postgresql', host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'db', defaultSchema: 'public' },
        rpc: {
            executeQuery: vi.fn(async ({ sql }: { sql: string }) => {
                // meta table queries return empty initially
                if (sql.includes('tmp_replicate_meta')) return []
                return []
            }),
        },
        context: {},
    }
}

describe('ReplicatePlugin', () => {
    it('instantiates with default options', () => {
        const plugin = new ReplicatePlugin()
        expect(plugin.name).toBe('starbasedb:replicate')
        expect(plugin.pathPrefix).toBe('/replicate')
    })

    it('instantiates with custom tables and batchSize', () => {
        const plugin = new ReplicatePlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            batchSize: 100,
        })
        expect(plugin['tables']).toHaveLength(1)
        expect(plugin['batchSize']).toBe(100)
    })

    it('throws when dataSource is not set', async () => {
        const plugin = new ReplicatePlugin()
        await expect(plugin.runReplication()).rejects.toThrow('dataSource not available')
    })

    it('throws when no external source configured', async () => {
        const plugin = new ReplicatePlugin()
        // @ts-expect-error — inject internal-only dataSource
        plugin['dataSource'] = { source: 'internal', rpc: { executeQuery: vi.fn(async () => []) } }
        // @ts-expect-error
        plugin['config'] = { role: 'admin' }
        await expect(plugin.runReplication()).rejects.toThrow('No external data source configured')
    })
})
