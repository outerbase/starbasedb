import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CronPlugin, CronEventPayload } from './index'

describe('CronPlugin - Initialization', () => {
    it('should initialize with correct plugin name, prefix and auth requirement', () => {
        const plugin = new CronPlugin()
        expect(plugin).toBeInstanceOf(CronPlugin)
        expect(plugin.name).toBe('starbasedb:cron')
        expect(plugin.pathPrefix).toBe('/cron')
        expect(plugin.options?.requiresAuth).toBe(true)
    })
})

describe('CronPlugin - Event Subscription & Emission', () => {
    let plugin: CronPlugin

    beforeEach(() => {
        plugin = new CronPlugin()
    })

    it('should register event listener via on() and trigger on emit()', () => {
        const mockCallback = vi.fn()
        plugin.on(mockCallback)

        const testPayload: CronEventPayload = {
            name: 'cleanup_job',
            cron_tab: '0 0 * * *',
            payload: { action: 'purge_temp' },
        }

        plugin.emit(testPayload)

        expect(mockCallback).toHaveBeenCalledTimes(1)
        expect(mockCallback).toHaveBeenCalledWith(testPayload)
    })

    it('should support multiple registered event listeners', () => {
        const cb1 = vi.fn()
        const cb2 = vi.fn()

        plugin.on(cb1)
        plugin.on(cb2)

        const testPayload: CronEventPayload = {
            name: 'daily_summary',
            cron_tab: '@daily',
            payload: { metrics: true },
        }

        plugin.emit(testPayload)

        expect(cb1).toHaveBeenCalledWith(testPayload)
        expect(cb2).toHaveBeenCalledWith(testPayload)
    })
})
