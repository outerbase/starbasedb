import { describe, expect, it, vi } from 'vitest'

import { ChangeDataCapturePlugin } from '../plugins/cdc'
import { ClerkPlugin } from '../plugins/clerk'
import { QueryLogPlugin } from '../plugins/query-log'
import { ResendPlugin } from '../plugins/resend'
import { SqlMacrosPlugin } from '../plugins/sql-macros'
import { StripeSubscriptionPlugin } from '../plugins/stripe'
import { StudioPlugin } from '../plugins/studio'
import { WebSocketPlugin } from '../plugins/websocket'
import * as publicApi from '../dist'
import * as pluginApi from '../dist/plugins'
import { StarbaseDBDurableObject } from './do'
import { StarbaseDB } from './handler'

vi.mock('cloudflare:workers', () => {
    return {
        DurableObject: class MockDurableObject {},
    }
})

describe('public package entrypoints', () => {
    it('exposes runtime APIs from the root package export', () => {
        expect(publicApi.StarbaseDB).toBe(StarbaseDB)
        expect(publicApi.StarbaseDBDurableObject).toBe(StarbaseDBDurableObject)
        expect(Object.keys(publicApi).sort()).toEqual([
            'StarbaseDB',
            'StarbaseDBDurableObject',
        ])
    })

    it('exposes documented plugin constructors from the plugin export', () => {
        expect(pluginApi.StudioPlugin).toBe(StudioPlugin)
        expect(pluginApi.WebSocketPlugin).toBe(WebSocketPlugin)
        expect(pluginApi.SqlMacrosPlugin).toBe(SqlMacrosPlugin)
        expect(pluginApi.StripeSubscriptionPlugin).toBe(
            StripeSubscriptionPlugin
        )
        expect(pluginApi.ChangeDataCapturePlugin).toBe(ChangeDataCapturePlugin)
        expect(pluginApi.QueryLogPlugin).toBe(QueryLogPlugin)
        expect(pluginApi.ResendPlugin).toBe(ResendPlugin)
        expect(pluginApi.ClerkPlugin).toBe(ClerkPlugin)
        expect(Object.keys(pluginApi).sort()).toEqual([
            'ChangeDataCapturePlugin',
            'ClerkPlugin',
            'QueryLogPlugin',
            'ResendPlugin',
            'SqlMacrosPlugin',
            'StripeSubscriptionPlugin',
            'StudioPlugin',
            'WebSocketPlugin',
        ])
    })
})
