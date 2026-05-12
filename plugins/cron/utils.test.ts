import { describe, expect, it } from 'vitest'
import { getNextExecutionTime, parseCronExpression } from './utils'

describe('cron utils', () => {
    it('parses valid cron expressions', () => {
        const interval = parseCronExpression('*/15 * * * *')

        expect(interval.next().getMinutes() % 15).toBe(0)
    })

    it('throws for invalid cron expressions', () => {
        expect(() => parseCronExpression('not a cron')).toThrow()
    })

    it('returns the next execution time after the provided timestamp', () => {
        const after = new Date(2026, 0, 1, 10, 30, 0).getTime()

        expect(getNextExecutionTime('0 11 * * *', after)).toBe(
            new Date(2026, 0, 1, 11, 0, 0).getTime()
        )
    })

    it('rolls over to the next day when the scheduled time has passed', () => {
        const after = new Date(2026, 0, 1, 11, 30, 0).getTime()

        expect(getNextExecutionTime('0 11 * * *', after)).toBe(
            new Date(2026, 0, 2, 11, 0, 0).getTime()
        )
    })
})
