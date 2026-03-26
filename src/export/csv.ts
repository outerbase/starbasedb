import { getTableData, createExportResponse } from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

export async function exportTableToCsvRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const data = await getTableData(tableName, dataSource, config)

        if (data === null) {
            return createResponse(undefined, `Table '${tableName}' does not exist.`, 404)
        }

        if (data.length === 0) {
            return createExportResponse('', `${tableName}_export.csv`, 'text/csv')
        }

        // CSV Başlıklarını oluştur (Tablonun sütun isimleri)
        const headers = Object.keys(data[0]).join(',')
        
        // Verileri satırlara çevir (Tırnak işaretlerini düzeltir)
        const rows = data.map((row: any) => 
            Object.values(row).map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')
        ).join('\n')

        const csvData = `${headers}\n${rows}`

        return createExportResponse(
            csvData,
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}