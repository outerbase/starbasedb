import * as cronParser from 'cron-parser'

export function parseCronExpression(cronTab: string) {
    return cronParser.parseExpression(cronTab)
}

export function getNextExecutionTime(cronTab: string, after: number): number {
    const interval = cronParser.parseExpression(cronTab, {
        currentDate: new Date(after),
    })
    const next = interval.next()
    return next.getTime()
}
