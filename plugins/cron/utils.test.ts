import { describe, it, expect } from 'vitest'
import { parseCronExpression, getNextExecutionTime } from './utils'

describe('cron utils', () => {
    it('parseCronExpression parses a valid cron expression into an interval', () => {
        const interval = parseCronExpression('0 0 * * *')
        expect(interval).toBeDefined()
        expect(typeof interval.next).toBe('function')
    })

    it('parseCronExpression throws on an invalid cron expression', () => {
        expect(() => parseCronExpression('not a cron')).toThrow()
    })

    it('getNextExecutionTime returns the next minute boundary after the given time', () => {
        const after = Date.UTC(2026, 0, 1, 12, 30, 30) // 2026-01-01 12:30:30 UTC
        const next = getNextExecutionTime('* * * * *', after)

        expect(next).toBeGreaterThan(after)
        expect(next - after).toBeLessThanOrEqual(60_000)
        // a "next minute" always lands on a whole-minute boundary
        expect(next % 60_000).toBe(0)
    })

    it('getNextExecutionTime returns a future time for a daily cron', () => {
        const after = Date.UTC(2026, 0, 1, 12, 0, 0)
        const next = getNextExecutionTime('0 0 * * *', after)

        expect(next).toBeGreaterThan(after)
    })

    it('getNextExecutionTime advances from one occurrence to the next', () => {
        const after = Date.UTC(2026, 0, 1, 12, 0, 0)
        const first = getNextExecutionTime('* * * * *', after)
        const second = getNextExecutionTime('* * * * *', first)

        expect(second).toBeGreaterThan(first)
    })
})
