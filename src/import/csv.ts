import { createResponse } from '../utils'
import { DataSource } from '../types'
import { executeOperation } from '../export'
import { StarbaseDBConfiguration } from '../handler'

interface ColumnMapping {
    [key: string]: string
}

interface CsvData {
    data: string
    columnMapping?: Record<string, string>
}

export async function importTableFromCsvRoute(
    tableName: string,
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        if (!request.body) {
            return createResponse(undefined, 'Request body is empty', 400)
        }

        let csvData: CsvData
        const contentType = request.headers.get('Content-Type') || ''

        if (contentType.includes('application/json')) {
            csvData = (await request.json()) as CsvData
        } else if (contentType.includes('text/csv')) {
            const csvContent = await request.text()
            csvData = { data: csvContent }
        } else if (contentType.includes('multipart/form-data')) {
            const formData = await request.formData()
            const file = formData.get('file') as File | null
            if (!file) return createResponse(undefined, 'No file uploaded', 400)
            const csvContent = await file.text()
            csvData = { data: csvContent }
        } else {
            return createResponse(undefined, 'Unsupported Content-Type', 400)
        }

        const { data: csvContent, columnMapping = {} } = csvData
        const records = parseCSV(csvContent)

        if (records.length === 0) {
            return createResponse(undefined, 'Invalid CSV format or empty data', 400)
        }

        let successCount = 0
        const failedStatements: { statement: string; error: string }[] = []

        for (const record of records) {
            const mappedRecord = mapRecord(record, columnMapping)
            const columns = Object.keys(mappedRecord)
            const values = Object.values(mappedRecord)
            const placeholders = values.map(() => '?').join(', ')
            const statement = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`

            try {
                await executeOperation([{ sql: statement, params: values }], dataSource, config)
                successCount++
            } catch (error: any) {
                failedStatements.push({ statement, error: error.message || 'Unknown error' })
            }
        }

        return createResponse({
            message: `Imported ${successCount} out of ${records.length} records successfully.`,
            failedStatements: failedStatements,
        }, undefined, 200)
    } catch (error: any) {
        console.error('CSV Import Error:', error)
        return createResponse(undefined, 'Failed to import CSV data: ' + error.message, 500)
    }
}

function parseCSV(csv: string): Record<string, string>[] {
    const lines = csv.split('\n')
    if (lines.length === 0) return []
    const headers = lines[0].split(',').map((header) => header.trim())
    const records: Record<string, string>[] = []

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map((value) => value.trim())
        if (values.length === headers.length) {
            const record: Record<string, string> = {}
            headers.forEach((header, index) => {
                record[header] = values[index]
            })
            records.push(record)
        }
    }
    return records
}

function mapRecord(record: any, columnMapping: ColumnMapping): any {
    const mappedRecord: any = {}
    for (const [key, value] of Object.entries(record)) {
        const mappedKey = columnMapping[key] || key
        mappedRecord[mappedKey] = value
    }
    return mappedRecord
}