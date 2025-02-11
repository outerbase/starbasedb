import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'
import { getNextExecutionTime } from './utils'

const SQL_QUERIES = {
    CREATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_cron_tasks (
            name TEXT NOT NULL UNIQUE PRIMARY KEY,
            cron_tab TEXT NOT NULL,
            payload TEXT,
            callback_host TEXT,
            is_active INTEGER
        )
    `,
    INSERT_TASK: `
        INSERT OR REPLACE INTO tmp_cron_tasks (name, cron_tab, payload, callback_host)
        VALUES (?, ?, ?, ?)
    `,
    GET_TASKS: `
        SELECT name, cron_tab, payload 
        FROM tmp_cron_tasks
    `,
    DELETE_TASK: `
        DELETE FROM tmp_cron_tasks WHERE name = ?
    `,
    // The below query allows up to 10 cron events set to `is_active`. At the moment
    // it is hard coded constrained but adding more WHEN clause rows will up that limit.
    UPDATE_ACTIVE_STATUS: `
        UPDATE tmp_cron_tasks 
        SET is_active = CASE 
            WHEN name = ? THEN 1 
            WHEN name = ? THEN 1
            WHEN name = ? THEN 1
            WHEN name = ? THEN 1
            WHEN name = ? THEN 1
            WHEN name = ? THEN 1
            WHEN name = ? THEN 1
            WHEN name = ? THEN 1
            WHEN name = ? THEN 1
            WHEN name = ? THEN 1
            ELSE 0 
        END
    `,
}

export interface CronEventPayload {
    name: string
    cron_tab: string
    payload: Record<string, any>
}

export class CronPlugin extends StarbasePlugin {
    public pathPrefix: string = '/cron'
    private dataSource?: DataSource
    private eventCallbacks: ((payload: CronEventPayload) => void)[] = []

    constructor() {
        super('starbasedb:cron', {
            requiresAuth: true,
        })
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            await this.init()
            await this.scheduleNextAlarm()
            await next()
        })

        app.post(`${this.pathPrefix}/callback`, async (c) => {
            const payload = (await c.req.json()) as CronEventPayload[]

            this.eventCallbacks.forEach((callback) => {
                try {
                    payload.forEach((element) => {
                        callback(element)
                    })
                } catch (error) {
                    console.error('Error in Cron event callback:', error)
                }
            })

            return createResponse({ success: true }, undefined, 200)
        })
    }

    private async init() {
        if (!this.dataSource) return

        // Create cron tasks table if it doesn't exist
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_TABLE,
            params: [],
        })
    }

    private async scheduleNextAlarm() {
        if (!this.dataSource) return

        // Get all tasks from our database table
        const result = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_TASKS,
            params: [],
        })) as QueryResult[]

        const tasks = result as {
            name: string
            cron_tab: string
            payload: string
        }[]

        /**
         * No tasks exist. There are two options here we can proceed with:
         * 1. Delete the existing alarm in case they removed the task and no longer needed
         * 2. Leave any alarms and just return early (in case other plugins utilize Alarms)
         *
         * For the purpose of this plugin in its current state we are going to simply
         * return early so if other plugins utilize the Alarm we're not disrupting the
         * service(s) they provide. A side effect to this decision is that if you delete
         * a cron task from this plugin you may get one last lingering message sent that
         * is currently set to be triggered.
         */
        if (tasks.length === 0) {
            // await this.dataSource.rpc.deleteAlarm() <-- We are intentionally _NOT_ calling this.
            return
        }

        // Find the next execution time for each task
        const now = Date.now()
        let nextExecutionMs = Infinity
        let nextTasks: typeof tasks = []

        for (const task of tasks) {
            const nextTime = getNextExecutionTime(task.cron_tab, now)

            if (nextTime < nextExecutionMs && nextTime > now) {
                nextExecutionMs = nextTime
                nextTasks = [task]
            } else if (nextTime === nextExecutionMs && nextTime > now) {
                nextTasks.push(task)
            }
        }

        if (nextTasks.length > 0) {
            // Update active status for all tasks
            // Fill remaining parameter slots with null if fewer than 10 tasks
            const taskNames = [
                ...nextTasks.map((t) => t.name),
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
            ].slice(0, 10)
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPDATE_ACTIVE_STATUS,
                params: taskNames,
            })

            await this.dataSource.rpc.setAlarm(nextExecutionMs)
        }
    }

    public async addEvent(
        cronTab: string,
        name: string,
        payload: Record<string, any> = {},
        callbackHost: string
    ) {
        if (!this.dataSource)
            throw new Error('CronPlugin not properly initialized')

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.INSERT_TASK,
            params: [name, cronTab, JSON.stringify(payload), callbackHost],
        })

        // Reschedule alarms after adding new task
        await this.scheduleNextAlarm()
    }

    public onEvent(
        callback: (payload: CronEventPayload) => void | Promise<void>,
        ctx?: ExecutionContext
    ) {
        const wrappedCallback = async (payload: CronEventPayload) => {
            const result = callback(payload)
            if (result instanceof Promise && ctx) {
                ctx.waitUntil(result)
            }
        }

        this.eventCallbacks.push(wrappedCallback)
    }
}
