import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { StatsPlugin } from './index'
import { ResendPlugin } from '../resend/index'

describe('StatsPlugin & ResendPlugin', () => {
    it('StatsPlugin rejects non-admin requests and returns statistics for admin', async () => {
        let currentRole = 'user'
        const mockDataSource = {
            source: 'internal',
            rpc: {
                getStatistics: vi.fn(async () => ({
                    rowsRead: 120,
                    rowsWritten: 15,
                })),
            },
            registry: {
                currentPlugins: () => ['starbasedb:stats'],
            },
        }

        const app = new Hono<any>()
        app.use('*', async (c, next) => {
            c.set('config', { role: currentRole })
            c.set('dataSource', mockDataSource)
            await next()
        })

        const statsPlugin = new StatsPlugin()
        await statsPlugin.register(app as any)

        const unauthRes = await app.request('/_internal/stats')
        expect(unauthRes.status).toBe(400)

        currentRole = 'admin'
        const adminRes = await app.request('/_internal/stats')
        expect(adminRes.status).toBe(200)
        const body: any = await adminRes.json()
        expect(body.result.rowsRead).toBe(120)
        expect(body.result.plugins).toEqual(['starbasedb:stats'])
    })

    it('ResendPlugin sends email via Resend API and handles errors', async () => {
        const plugin = new ResendPlugin({ apiKey: 're_test_123' })

        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ id: 'email_001' }), { status: 200 })
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ message: 'Invalid API key' }), {
                    status: 401,
                })
            )

        const okRes = await plugin.sendEmail(
            'noreply@outerbase.com',
            ['dev@outerbase.com'],
            'Test Subject',
            '<p>Hello</p>'
        )
        expect(okRes.id).toBe('email_001')

        await expect(
            plugin.sendEmail(
                'noreply@outerbase.com',
                ['dev@outerbase.com'],
                'Fail Subject',
                '<p>Fail</p>'
            )
        ).rejects.toThrow('Invalid API key')

        fetchSpy.mockRestore()
    })
})
