import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StarbaseDB } from './handler'
import type { DataSource } from './types'

describe('handler additional tests', () => {
    let mockDataSource: DataSource
    let mockConfig: any

    beforeEach(() => {
        mockConfig = {
            role: 'client',
            features: {},
        }

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn(),
            } as any,
        } as DataSource
    })

    it('should throw if external data source is missing external config', () => {
        mockDataSource.source = 'external'
        expect(() => {
            new StarbaseDB({
                dataSource: mockDataSource,
                config: mockConfig,
            })
        }).toThrow('No external data sources available.')
    })

    it('should handle preAuth with authless plugin', async () => {
        const instance = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
            plugins: [
                {
                    opts: { requiresAuth: false },
                    pathPrefix: '/public/.*',
                    register: vi.fn(),
                    beforeQuery: vi.fn(),
                    afterQuery: vi.fn(),
                } as any,
            ],
        })
        const req = new Request('http://localhost/public/hello')
        const res = await instance.handlePreAuth(req, {} as any)
        expect(res).toBeDefined()
    })

    it('should handle preAuth returning undefined when auth required', async () => {
        const instance = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
            plugins: [
                {
                    opts: { requiresAuth: true },
                    pathPrefix: '/private/*',
                    register: vi.fn(),
                    beforeQuery: vi.fn(),
                    afterQuery: vi.fn(),
                } as any,
            ],
        })
        const req = new Request('http://localhost/private/hello')
        const res = await instance.handlePreAuth(req, {} as any)
        expect(res).toBeUndefined()
    })

    it('should reject non-json in queryRoute', async () => {
        const instance = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
        })
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'hello',
        })
        const res = await instance.queryRoute(req, false)
        expect(res.status).toBe(400)
    })

    it('should reject invalid sql field in transaction', async () => {
        const instance = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
        })
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transaction: [{ sql: 123 }] }),
        })
        const res = await instance.queryRoute(req, false)
        expect(res.status).toBe(500)
        expect((await res.json()).error).toContain(
            'Invalid or empty "sql" field in transaction'
        )
    })

    it('should reject invalid params field in transaction', async () => {
        const instance = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
        })
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transaction: [{ sql: 'SELECT 1', params: 'invalid' }],
            }),
        })
        const res = await instance.queryRoute(req, false)
        expect(res.status).toBe(500)
        expect((await res.json()).error).toContain(
            'Invalid "params" field in transaction'
        )
    })

    it('should reject invalid params field in queryRoute', async () => {
        const instance = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
        })
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql: 'SELECT 1', params: 'invalid' }),
        })
        const res = await instance.queryRoute(req, false)
        expect(res.status).toBe(400)
        expect((await res.json()).error).toContain('Invalid "params" field')
    })
})
