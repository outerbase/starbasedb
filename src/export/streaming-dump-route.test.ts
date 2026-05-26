/**
 * Smoke tests for the streaming dump HTTP entry points in src/export/dump.ts.
 * The real DO RPC is mocked — these tests just confirm parameter parsing,
 * status code shape, and routing of the call into the RPC surface.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
    cancelDumpJobRoute,
    downloadDumpJobRoute,
    getDumpJobStatusRoute,
    startStreamingDumpRoute,
} from './dump'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

function makeRpcMock(overrides: Record<string, any> = {}) {
    return {
        executeQuery: vi.fn(),
        startDumpJob: vi.fn().mockResolvedValue({
            jobId: 'job-abc',
            status: 'queued',
            format: 'sql',
            objectKey: 'dumps/dump.sql',
            progress: {
                tables: ['users'],
                currentTableIndex: 0,
                currentTable: 'users',
                rowOffset: 0,
                rowsDumped: 0,
                bytesWritten: 0,
                partsUploaded: 0,
                startedAt: 1,
                updatedAt: 1,
            },
        }),
        getDumpJob: vi.fn().mockResolvedValue({
            jobId: 'job-abc',
            status: 'processing',
            format: 'sql',
            objectKey: 'dumps/dump.sql',
            progress: {
                tables: ['users'],
                currentTableIndex: 0,
                currentTable: 'users',
                rowOffset: 0,
                rowsDumped: 100,
                bytesWritten: 4096,
                partsUploaded: 0,
                startedAt: 1,
                updatedAt: 2,
            },
        }),
        getDumpDownloadBody: vi.fn(),
        cancelDumpJob: vi.fn(),
        ...overrides,
    }
}

let dataSource: DataSource
let config: StarbaseDBConfiguration

beforeEach(() => {
    dataSource = {
        source: 'internal',
        rpc: makeRpcMock() as any,
    } as any
    config = {
        role: 'admin',
        features: { export: true },
    }
})

describe('streaming dump HTTP routes', () => {
    it('startStreamingDumpRoute returns 202 with statusUrl/downloadUrl', async () => {
        const req = new Request('https://api.example.com/export/dump', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ format: 'sql' }),
        })
        const res = await startStreamingDumpRoute(req, dataSource, config)
        expect(res.status).toBe(202)
        expect(res.headers.get('Location')).toContain(
            '/export/dump/status/job-abc'
        )
        const json: any = await res.json()
        expect(json.result.jobId).toBe('job-abc')
        expect(json.result.statusUrl).toBe(
            'https://api.example.com/export/dump/status/job-abc'
        )
        expect(json.result.downloadUrl).toBe(
            'https://api.example.com/export/dump/download/job-abc'
        )
        expect(dataSource.rpc.startDumpJob).toHaveBeenCalledWith(
            expect.objectContaining({ format: 'sql' })
        )
    })

    it('startStreamingDumpRoute accepts format via query string', async () => {
        const req = new Request(
            'https://api.example.com/export/dump?format=csv',
            { method: 'POST' }
        )
        await startStreamingDumpRoute(req, dataSource, config)
        expect(dataSource.rpc.startDumpJob).toHaveBeenCalledWith(
            expect.objectContaining({ format: 'csv' })
        )
    })

    it('startStreamingDumpRoute rejects external data sources', async () => {
        const external: DataSource = {
            source: 'external',
            rpc: makeRpcMock() as any,
        } as any
        const req = new Request('https://api.example.com/export/dump', {
            method: 'POST',
        })
        const res = await startStreamingDumpRoute(req, external, config)
        expect(res.status).toBe(400)
    })

    it('getDumpJobStatusRoute returns 404 for missing jobs', async () => {
        ;(dataSource.rpc as any).getDumpJob = vi.fn().mockResolvedValue(null)
        const req = new Request(
            'https://api.example.com/export/dump/status/nope'
        )
        const res = await getDumpJobStatusRoute('nope', req, dataSource)
        expect(res.status).toBe(404)
    })

    it('getDumpJobStatusRoute adds downloadUrl only on completion', async () => {
        const req = new Request(
            'https://api.example.com/export/dump/status/job-abc'
        )
        const res = await getDumpJobStatusRoute('job-abc', req, dataSource)
        const json: any = await res.json()
        expect(json.result.downloadUrl).toBeUndefined() // still processing
        ;(dataSource.rpc as any).getDumpJob = vi.fn().mockResolvedValue({
            jobId: 'job-abc',
            status: 'completed',
            format: 'sql',
            objectKey: 'dumps/dump.sql',
            progress: {
                tables: [],
                currentTableIndex: 0,
                currentTable: null,
                rowOffset: 0,
                rowsDumped: 0,
                bytesWritten: 0,
                partsUploaded: 0,
                startedAt: 1,
                updatedAt: 2,
            },
        })
        const res2 = await getDumpJobStatusRoute('job-abc', req, dataSource)
        const json2: any = await res2.json()
        expect(json2.result.downloadUrl).toBe(
            'https://api.example.com/export/dump/download/job-abc'
        )
    })

    it('downloadDumpJobRoute streams the R2 body when available', async () => {
        const body = new Response('hello world').body
        ;(dataSource.rpc as any).getDumpDownloadBody = vi
            .fn()
            .mockResolvedValue({
                body,
                size: 11,
                contentType: 'application/sql',
                filename: 'dump.sql',
            })
        const res = await downloadDumpJobRoute('job-abc', dataSource)
        expect(res.status).toBe(200)
        expect(res.headers.get('Content-Length')).toBe('11')
        expect(res.headers.get('Content-Disposition')).toBe(
            'attachment; filename="dump.sql"'
        )
        expect(await res.text()).toBe('hello world')
    })

    it('downloadDumpJobRoute returns 404 when dump is not ready', async () => {
        ;(dataSource.rpc as any).getDumpDownloadBody = vi
            .fn()
            .mockResolvedValue(null)
        const res = await downloadDumpJobRoute('job-abc', dataSource)
        expect(res.status).toBe(404)
    })

    it('cancelDumpJobRoute round-trips through the DO RPC', async () => {
        ;(dataSource.rpc as any).cancelDumpJob = vi.fn().mockResolvedValue({
            jobId: 'job-abc',
            status: 'cancelled',
            format: 'sql',
            objectKey: 'dumps/dump.sql',
            progress: {
                tables: [],
                currentTableIndex: 0,
                currentTable: null,
                rowOffset: 0,
                rowsDumped: 0,
                bytesWritten: 0,
                partsUploaded: 0,
                startedAt: 1,
                updatedAt: 2,
            },
        })
        const res = await cancelDumpJobRoute('job-abc', dataSource)
        expect(res.status).toBe(200)
        const json: any = await res.json()
        expect(json.result.status).toBe('cancelled')
    })
})
