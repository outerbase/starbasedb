import { DataSource } from '../types'
import { executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

// 1. Veritabanından veriyi çeken motor
export async function executeOperation(
    queries: { sql: string; params?: any[] }[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<any[]> {
    const results: any[] = (await executeTransaction({
        queries,
        isRaw: false,
        dataSource,
        config,
    })) as any[]
    return results.length > 0 && Array.isArray(results[0]) ? results[0] : results
}

// 2. Tablo var mı kontrol eden ve veriyi getiren motor
export async function getTableData(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<any[] | null> {
    try {
        const tableExistsResult = await executeOperation(
            [{ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?;`, params: [tableName] }],
            dataSource, config
        )
        if (!tableExistsResult || tableExistsResult.length === 0) return null
        return await executeOperation([{ sql: `SELECT * FROM ${tableName};` }], dataSource, config)
    } catch (error: any) {
        console.error('Table Data Fetch Error:', error); throw error
    }
}

// 3. Dosyayı paketleyip indirilmeye hazır hale getiren motor
export function createExportResponse(data: any, fileName: string, contentType: string): Response {
    const blob = new Blob([data], { type: contentType })
    return new Response(blob, {
        headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${fileName}"`,
        }
    })
}