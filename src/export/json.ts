import { getTableData, createExportResponse } from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

export async function exportTableToJsonRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // index.ts'deki motoru kullanarak veriyi çekiyoruz
        const data = await getTableData(tableName, dataSource, config)

        if (data === null) {
            return createResponse(
                undefined,
                `Table '${tableName}' does not exist.`,
                404
            )
        }

        // Veriyi JSON formatına çeviriyoruz (4 boşluk ile okunabilir yaptık)
        const jsonData = JSON.stringify(data, null, 4)

        // index.ts'deki motoru kullanarak dosya yanıtını oluşturuyoruz
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