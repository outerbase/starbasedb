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
            // Handle JSON-wrapped CSV data in POST body
            csvData = (await request.json()) as CsvData
        } else if (contentType.includes('text/csv')) {
            // Handle raw CSV data in POST body
            const csvContent = await request.text()
            csvData = { data: csvContent }
        } else if (contentType.includes('multipart/form-data')) {
            // Handle file upload
            const formData = await request.formData()
            const file = formData.get('file') as File | null

            if (!file) {
                return createResponse(undefined, 'No file uploaded', 400)
            }

            const csvContent = await file.text()
            csvData = { data: csvContent }
        } else {
            return createResponse(undefined, 'Unsupported Content-Type', 400)
        }

        const { data: csvContent, columnMapping = {} } = csvData

        // Parse CSV data
        const records = parseCSV(csvContent)

        if (records.length === 0) {
            return createResponse(
                undefined,
                'Invalid CSV format or empty data',
                400
            )
        }

        const failedStatements: { statement: string; error: string }[] = []
        let successCount = 0

        for (const record of records) {
            const mappedRecord = mapRecord(record, columnMapping)
            const columns = Object.keys(mappedRecord)
            const values = Object.values(mappedRecord)
            const placeholders = values.map(() => '?').join(', ')

            const statement = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`

            try {
                await executeOperation(
                    [{ sql: statement, params: values }],
                    dataSource,
                    config
                )
                successCount++
            } catch (error: any) {
                failedStatements.push({
                    statement: statement,
                    error: error.message || 'Unknown error',
                })
            }
        }

        const totalRecords = records.length
        const failedCount = failedStatements.length

        const resultMessage = `Imported ${successCount} out of ${totalRecords} records successfully. ${failedCount} records failed.`

        return createResponse(
            {
                message: resultMessage,
                failedStatements: failedStatements,
            },
            undefined,
            200
        )
    } catch (error: any) {
        console.error('CSV Import Error:', error)
        return createResponse(
            undefined,
            'Failed to import CSV data: ' + error.message,
            500
        )
    }
}

function parseCSV(csv: string): Record<string, string>[] {
    const lines = csv.split('\n')
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
