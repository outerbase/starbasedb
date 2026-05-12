import { describe, expect, it, vi } from 'vitest'
import { StarbaseDB } from './handler'
import type { DataSource } from './types'

const executionContext = {
    waitUntil: vi.fn(),
} as unknown as ExecutionContext

function createDataSource(overrides: Partial<DataSource> = {}): DataSource {
    return {
        source: 'internal',
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        } as any,
        ...overrides,
    }
}

async function readJson(response: Response) {
    return response.json() as Promise<{ result?: any; error?: string }>
}

describe('StarbaseDB route registration', () => {
    it('returns configured database dialect metadata from /status/database', async () => {
        const starbase = new StarbaseDB({
            dataSource: createDataSource({
                source: 'external',
                external: {
                    dialect: 'postgresql',
                    host: 'localhost',
                    port: 5432,
                    user: 'postgres',
                    password: 'postgres',
                    database: 'app',
                },
            }),
            config: {
                role: 'admin',
            },
        })

        const response = await starbase.handle(
            new Request('https://example.com/status/database'),
            executionContext
        )
        const body = await readJson(response)

        expect(response.status).toBe(200)
        expect(body.result).toEqual({
            dialects: {
                external: 'postgresql',
                hyperdrive: 'postgresql',
            },
        })
    })

    it('does not register export routes when the export feature is disabled', async () => {
        const starbase = new StarbaseDB({
            dataSource: createDataSource(),
            config: {
                role: 'admin',
                features: {
                    export: false,
                },
            },
        })

        const response = await starbase.handle(
            new Request('https://example.com/export/dump'),
            executionContext
        )
        const body = await readJson(response)

        expect(response.status).toBe(404)
        expect(body.error).toBe('Not found')
    })

    it('does not register import routes when the import feature is disabled', async () => {
        const starbase = new StarbaseDB({
            dataSource: createDataSource(),
            config: {
                role: 'admin',
                features: {
                    import: false,
                },
            },
        })

        const response = await starbase.handle(
            new Request('https://example.com/import/dump', { method: 'POST' }),
            executionContext
        )
        const body = await readJson(response)

        expect(response.status).toBe(404)
        expect(body.error).toBe('Not found')
    })

    it('blocks export routes for external data sources before dispatching export logic', async () => {
        const starbase = new StarbaseDB({
            dataSource: createDataSource({
                source: 'external',
                external: {
                    dialect: 'mysql',
                    host: 'localhost',
                    port: 3306,
                    user: 'root',
                    password: 'root',
                    database: 'app',
                },
            }),
            config: {
                role: 'admin',
                features: {
                    export: true,
                },
            },
        })

        const response = await starbase.handle(
            new Request('https://example.com/export/dump'),
            executionContext
        )
        const body = await readJson(response)

        expect(response.status).toBe(400)
        expect(body.error).toBe(
            'Function is only available for internal data source.'
        )
    })

    it('blocks import routes for external data sources before parsing the request body', async () => {
        const starbase = new StarbaseDB({
            dataSource: createDataSource({
                source: 'external',
                external: {
                    dialect: 'postgresql',
                    host: 'localhost',
                    port: 5432,
                    user: 'postgres',
                    password: 'postgres',
                    database: 'app',
                },
            }),
            config: {
                role: 'admin',
                features: {
                    import: true,
                },
            },
        })

        const response = await starbase.handle(
            new Request('https://example.com/import/dump', {
                method: 'POST',
                body: 'not multipart',
            }),
            executionContext
        )
        const body = await readJson(response)

        expect(response.status).toBe(400)
        expect(body.error).toBe(
            'Function is only available for internal data source.'
        )
    })

    it('dispatches internal import routes to the import handler validation', async () => {
        const starbase = new StarbaseDB({
            dataSource: createDataSource(),
            config: {
                role: 'admin',
                features: {
                    import: true,
                },
            },
        })

        const response = await starbase.handle(
            new Request('https://example.com/import/dump', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: '{}',
            }),
            executionContext
        )
        const body = await readJson(response)

        expect(response.status).toBe(400)
        expect(body.error).toBe('Content-Type must be multipart/form-data')
    })
})
