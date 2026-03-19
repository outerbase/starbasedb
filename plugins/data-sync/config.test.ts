import { describe, expect, it } from 'vitest'
import { loadDataSyncConfig } from './config'

describe('loadDataSyncConfig', () => {
    it('parses jobs JSON', () => {
        const jobs = [
            {
                externalTable: 'public.users',
                localTable: 'users',
                cursorKind: 'incremental_id',
                cursorColumn: 'id',
                pkColumns: ['id'],
            },
        ]
        const c = loadDataSyncConfig({
            DATA_SYNC_ENABLED: 'true',
            DATA_SYNC_JOBS: JSON.stringify(jobs),
            DATA_SYNC_BATCH_SIZE: '100',
        })
        expect(c.enabled).toBe(true)
        expect(c.jobs).toHaveLength(1)
        expect(c.jobs[0].localTable).toBe('users')
        expect(c.batchSize).toBe(100)
    })

    it('defaults when env empty', () => {
        const c = loadDataSyncConfig({})
        expect(c.enabled).toBe(false)
        expect(c.jobs).toEqual([])
        expect(c.syncIntervalSeconds).toBe(300)
    })
})
