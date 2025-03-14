import { createResponse } from '../utils'
import { executeOperation } from '../export'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

interface ColumnMapping {
    [key: string]: string
}

interface JsonData {
    data: any[]
    columnMapping?: Record<string, string>
}

export async function importTableFromJsonRoute(
    tableName: string,
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    const contentType = request.headers.get('Content-Type') || ''

    if (contentType.includes('multipart/form-data')) {
        try {
            // Handle file upload
            const formData = await request.formData()
            const file = formData.get('file') as File | null

            if (!file) {
                return createResponse(undefined, 'No file uploaded', 400)
            }

            const fileContent = await file.text()
            let jsonData = JSON.parse(fileContent) as JsonData

            if (
                !jsonData ||
                typeof jsonData !== 'object' ||
                !Array.isArray((jsonData as any).data)
            ) {
                return createResponse(
                    undefined,
                    'Invalid JSON format. Expected an object with "data" array and optional "columnMapping".',
                    400
                )
            }

            // Cast jsonData to any to avoid TypeScript errors
            const jsonDataObj = jsonData as any
            const data = jsonDataObj.data
            const columnMapping = jsonDataObj.columnMapping || {}

            const failedStatements: { statement: string; error: string }[] = []
            let successCount = 0

            for (const record of data) {
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
                        error: error || 'Unknown error',
                    })
                }
            }

            const totalRecords = data.length
            const failedCount = failedStatements.length

            if (failedCount === totalRecords) {
                return createResponse(
                    undefined,
                    'Failed to import JSON data',
                    500
                )
            }

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
            console.error('File Upload Processing Error:', error)
            return createResponse(undefined, 'Invalid file upload', 400)
        }
    } else if (contentType.includes('application/json')) {
        try {
            // Safely parse JSON with error handling
            let jsonData
            try {
                jsonData = await request.json()
            } catch (error) {
                return createResponse(
                    null,
                    `Invalid JSON format: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    400
                )
            }

            if (
                !jsonData ||
                typeof jsonData !== 'object' ||
                !Array.isArray((jsonData as any).data)
            ) {
                return createResponse(
                    undefined,
                    'Invalid JSON format. Expected an object with "data" array and optional "columnMapping".',
                    400
                )
            }

            // Cast jsonData to any to avoid TypeScript errors
            const jsonDataObj = jsonData as any
            const data = jsonDataObj.data
            const columnMapping = jsonDataObj.columnMapping || {}

            const failedStatements: { statement: string; error: string }[] = []
            let successCount = 0

            for (const record of data) {
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
                        error: error || 'Unknown error',
                    })
                }
            }

            const totalRecords = data.length
            const failedCount = failedStatements.length

            if (failedCount === totalRecords) {
                return createResponse(
                    undefined,
                    'Failed to import JSON data',
                    500
                )
            }

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
            console.error('JSON Import Error:', error)
            return createResponse(undefined, 'Failed to import JSON data', 500)
        }
    } else {
        return createResponse(null, 'Unsupported Content-Type', 400)
    }
}

function mapRecord(record: any, columnMapping: ColumnMapping): any {
    const mappedRecord: any = {}
    for (const [key, value] of Object.entries(record)) {
        const mappedKey = columnMapping[key] || key
        mappedRecord[mappedKey] = value
    }
    return mappedRecord
}
