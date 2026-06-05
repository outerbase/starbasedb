import { getTableData, createExportResponse } from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import { CHUNK_SIZE } from './constants'

export async function exportTableToJsonRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    limit?: number,
    offset?: number
): Promise<Response> {
    try {
        const data = await getTableData(tableName, dataSource, config, limit, offset)

        if (data === null) {
            return createResponse(
                undefined,
                `Table '${tableName}' does not exist.`,
                404
            )
        }

        const jsonData = JSON.stringify(data, null, 4)
        return createExportResponse(
            jsonData,
            `${tableName}_export.json`,
            'application/json'
        )
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}

export async function exportTableToJsonStreamRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // First check table exists
        const firstChunk = await getTableData(tableName, dataSource, config, 1, 0)
        if (firstChunk === null) {
            return createResponse(undefined, `Table '${tableName}' does not exist.`, 404)
        }

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    controller.enqueue(new TextEncoder().encode('[\n'))
                    let offset = 0
                    let first = true

                    while (true) {
                        const chunk = await getTableData(tableName, dataSource, config, CHUNK_SIZE, offset)
                        if (!chunk || chunk.length === 0) break

                        for (const row of chunk) {
                            if (!first) controller.enqueue(new TextEncoder().encode(',\n'))
                            controller.enqueue(new TextEncoder().encode(JSON.stringify(row, null, 2)))
                            first = false
                        }
                        offset += CHUNK_SIZE
                    }

                    controller.enqueue(new TextEncoder().encode('\n]'))
                } catch (err: any) {
                    controller.error(err)
                    return
                }
                controller.close()
            }
        })

        const headers = new Headers({
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${tableName}_export.json"`,
            'Transfer-Encoding': 'chunked',
        })
        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
