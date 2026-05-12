import { describe, expect, it } from 'vitest'

import { getNextExecutionTime, parseCronExpression } from './utils'

describe('cron utils', () => {
    it('parses valid cron expressions', () => {
        const interval = parseCronExpression('*/15 * * * *')

        expect(interval.next().getTime()).toBeGreaterThan(Date.now())
    })

    it('throws for invalid cron expressions', () => {
        expect(() => parseCronExpression('not a cron')).toThrow()
    })

    it('returns the next execution time after the provided timestamp', () => {
        const after = Date.UTC(2026, 0, 1, 0, 0, 30)
        const nextExecution = getNextExecutionTime('* * * * *', after)

        expect(nextExecution).toBe(Date.UTC(2026, 0, 1, 0, 1, 0))
    })
})
