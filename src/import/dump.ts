import { createResponse } from '../utils';
import { DataSource } from '../types';
import { executeOperation } from '../export';
import { StarbaseDBConfiguration } from '../handler';

function parseSqlStatements(sqlContent: string): string[] {
    const lines = sqlContent.split('\n');
    let currentStatement = '';
    const statements: string[] = [];

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('--') || trimmedLine === '') {
            continue; // Skip comments and empty lines
        }

        currentStatement += line + '\n';

        if (trimmedLine.endsWith(';')) {
            statements.push(currentStatement.trim());
            currentStatement = '';
        }
    }

    // Add any remaining statement without a semicolon
    if (currentStatement.trim()) {
        statements.push(currentStatement.trim());
    }

    return statements;
}

export async function importDumpRoute(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    if (request.method !== 'POST') {
        return createResponse(undefined, 'Method not allowed', 405);
    }

    const contentType = request.headers.get('Content-Type');
    if (!contentType || !contentType.includes('multipart/form-data')) {
        return createResponse(undefined, 'Content-Type must be multipart/form-data', 400);
    }

    try {
        const formData = await request.formData();
        const sqlFile = formData.get('sqlFile');

        if (!sqlFile || !(sqlFile instanceof File)) {
            return createResponse(undefined, 'No SQL file uploaded', 400);
        }

        if (!sqlFile.name.endsWith('.sql')) {
            return createResponse(undefined, 'Uploaded file must be a .sql file', 400);
        }

        let sqlContent = await sqlFile.text();
        
        // Remove the SQLite format header if present
        if (sqlContent.startsWith('SQLite format 3')) {
            sqlContent = sqlContent.substring(sqlContent.indexOf('\n') + 1);
        }

        const sqlStatements = parseSqlStatements(sqlContent);

        const results = [];
        for (const statement of sqlStatements) {
            try {
                const result = await executeOperation([{ sql: statement }], dataSource, config)
                results.push({ statement, success: true, result });
            } catch (error: any) {
                console.error(`Error executing statement: ${statement}`, error);
                results.push({ statement, success: false, error: error.message });
            }
        }

        const successCount = results.filter(r => r.success).length;
        const failureCount = results.filter(r => !r.success).length;

        return createResponse({
            message: `SQL dump import completed. ${successCount} statements succeeded, ${failureCount} failed.`,
            details: results
        }, undefined, failureCount > 0 ? 207 : 200);
    } catch (error: any) {
        console.error('Import Dump Error:', error);
        return createResponse(undefined, error.message || 'An error occurred while importing the SQL dump', 500);
    }
}
