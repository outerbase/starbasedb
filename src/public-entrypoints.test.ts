import { describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
    DurableObject: class DurableObject {
        constructor(..._args: unknown[]) {}
    },
}))

describe('public package entrypoints', () => {
    it('re-exports the runtime classes from their source modules', async () => {
        const entrypoint = await import('../dist')
        const handler = await import('./handler')
        const durableObject = await import('./do')

        expect(entrypoint.StarbaseDB).toBe(handler.StarbaseDB)
        expect(entrypoint.StarbaseDBDurableObject).toBe(
            durableObject.StarbaseDBDurableObject
        )
    })

    it('re-exports the documented plugin constructors', async () => {
        const plugins = await import('../dist/plugins')
        const studio = await import('../plugins/studio')
        const websocket = await import('../plugins/websocket')
        const sqlMacros = await import('../plugins/sql-macros')
        const stripe = await import('../plugins/stripe')
        const cdc = await import('../plugins/cdc')
        const queryLog = await import('../plugins/query-log')
        const resend = await import('../plugins/resend')
        const clerk = await import('../plugins/clerk')

        expect(plugins.StudioPlugin).toBe(studio.StudioPlugin)
        expect(plugins.WebSocketPlugin).toBe(websocket.WebSocketPlugin)
        expect(plugins.SqlMacrosPlugin).toBe(sqlMacros.SqlMacrosPlugin)
        expect(plugins.StripeSubscriptionPlugin).toBe(
            stripe.StripeSubscriptionPlugin
        )
        expect(plugins.ChangeDataCapturePlugin).toBe(
            cdc.ChangeDataCapturePlugin
        )
        expect(plugins.QueryLogPlugin).toBe(queryLog.QueryLogPlugin)
        expect(plugins.ResendPlugin).toBe(resend.ResendPlugin)
        expect(plugins.ClerkPlugin).toBe(clerk.ClerkPlugin)
    })
})
