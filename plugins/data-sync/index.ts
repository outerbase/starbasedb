import type { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import type { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'
import { CronPlugin } from '../cron'
import {
    deleteDataSyncTask,
    ensureDataSyncTables,
    listDataSyncTasks,
    runDataSyncTask,
    upsertDataSyncTask,
} from './service'

export class DataSyncPlugin extends StarbasePlugin {
    public pathPrefix = '/data-sync'
    private cronPlugin?: CronPlugin
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration

    constructor(opts?: { cronPlugin?: CronPlugin }) {
        super('starbasedb:data-sync', { requiresAuth: true })
        this.cronPlugin = opts?.cronPlugin
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c, next) => {
            const dataSource = c.get('dataSource') as DataSource
            this.dataSource = dataSource
            this.config = c.get('config') as StarbaseDBConfiguration
            await ensureDataSyncTables(dataSource)
            await next()
        })

        if (this.cronPlugin) {
            this.cronPlugin.onEvent(async ({ name, payload }) => {
                const eventTaskName =
                    typeof payload?.taskName === 'string'
                        ? payload.taskName
                        : undefined

                const taskName =
                    eventTaskName ||
                    (name.startsWith('data-sync:')
                        ? name.replace('data-sync:', '')
                        : undefined)

                if (!taskName || !this.dataSource || !this.config) {
                    return
                }

                try {
                    await runDataSyncTask(this.dataSource, taskName, this.config)
                } catch (error) {
                    console.error(`Data sync cron run failed for ${taskName}:`, error)
                }
            })
        }

        app.get(this.pathPrefix, async (c) => {
            const dataSource = c.get('dataSource') as DataSource
            const tasks = await listDataSyncTasks(dataSource)
            return createResponse({ tasks }, undefined, 200)
        })

        app.post(this.pathPrefix, async (c) => {
            const dataSource = c.get('dataSource') as DataSource

            let body: any = {}
            try {
                body = await c.req.json()
            } catch {
                return createResponse(undefined, 'Invalid JSON payload', 400)
            }

            const task = await upsertDataSyncTask(dataSource, {
                name: body.name,
                sourceTable: body.sourceTable,
                targetTable: body.targetTable,
                cursorColumn: body.cursorColumn,
                sourceSchema: body.sourceSchema,
                intervalCron: body.intervalCron,
                batchSize: body.batchSize,
            })

            if (this.cronPlugin) {
                await this.cronPlugin.addEvent(
                    task.cronTab,
                    `data-sync:${task.name}`,
                    { taskName: task.name },
                    new URL(c.req.url).origin
                )
            }

            return createResponse({ task }, undefined, 201)
        })

        app.delete(`${this.pathPrefix}/:name`, async (c) => {
            const dataSource = c.get('dataSource') as DataSource
            const name = c.req.param('name')
            const deleted = await deleteDataSyncTask(dataSource, name)

            if (!deleted) {
                return createResponse(undefined, 'Task not found', 404)
            }

            if (this.cronPlugin) {
                await this.cronPlugin.removeEvent(`data-sync:${name}`)
            }

            return createResponse({ deleted: true, name }, undefined, 200)
        })

        app.post(`${this.pathPrefix}/run/:name`, async (c) => {
            const dataSource = c.get('dataSource') as DataSource
            const config = c.get('config') as StarbaseDBConfiguration
            const name = c.req.param('name')

            const summary = await runDataSyncTask(dataSource, name, config)
            return createResponse({ summary }, undefined, 200)
        })
    }
}
