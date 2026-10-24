import { describe, it, expect } from 'vitest'
import { parseCronExpression, getNextExecutionTime } from './utils'

describe('Cron Utils - parseCronExpression()', () => {
    it('should successfully parse valid standard 5-part cron expressions', () => {
        const interval = parseCronExpression('*/5 * * * *')
        expect(interval).toBeDefined()
        expect(typeof interval.next).toBe('function')
    })

    it('should parse hourly cron expressions', () => {
        const interval = parseCronExpression('0 * * * *')
        expect(interval).toBeDefined()
        const nextDate = interval.next().toDate()
        expect(nextDate).toBeInstanceOf(Date)
    })

    it('should throw an error for invalid cron expressions', () => {
        expect(() => parseCronExpression('invalid cron string')).toThrow()
        expect(() => parseCronExpression('60 * * * *')).toThrow()
    })
})

describe('Cron Utils - getNextExecutionTime()', () => {
    it('should calculate the next execution time greater than the reference timestamp', () => {
        const refTime = new Date('2026-01-01T12:00:00Z').getTime()
        const nextTime = getNextExecutionTime('*/15 * * * *', refTime)

        expect(nextTime).toBeGreaterThan(refTime)
        const nextDate = new Date(nextTime)
        expect(nextDate.getMinutes() % 15).toBe(0)
    })

    it('should correctly calculate midnight trigger time for daily schedule', () => {
        const refTime = new Date('2026-05-10T14:30:00Z').getTime()
        const nextTime = getNextExecutionTime('0 0 * * *', refTime)

        expect(nextTime).toBeGreaterThan(refTime)
        const nextDate = new Date(nextTime)
        expect(nextDate.getHours()).toBe(0)
        expect(nextDate.getMinutes()).toBe(0)
    })

    it('should throw when given an invalid cron string', () => {
        const refTime = Date.now()
        expect(() => getNextExecutionTime('not-a-cron', refTime)).toThrow()
    })
})
