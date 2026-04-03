import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const taskId = crypto.randomUUID()

        // Call RPC to start the dump
        await dataSource.rpc.startDump(taskId)

        return createResponse({ task_id: taskId }, undefined, 202)
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(
            undefined,
            'Failed to initiate database dump',
            500
        )
    }
}
