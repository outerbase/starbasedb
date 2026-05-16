import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import {
    createStreamingExportResponse,
    listExportableTables,
    sqlDumpChunks,
} from './streaming'

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const tables = await listExportableTables(dataSource, config)

        return createStreamingExportResponse(
            sqlDumpChunks(tables, dataSource, config),
            'database_dump.sql',
            'application/x-sqlite3'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
