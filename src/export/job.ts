import { DataSource } from '../types'

export interface ExportJob {
    id: string
    status: 'in_progress' | 'completed' | 'failed'
    startedAt: number
    completedAt?: number
    currentTable?: string
    currentRow?: number
    totalTables?: number
    fileName: string
    error?: string
}

/**
 * Create a table to track export jobs in the Durable Object storage
 */
export async function initializeExportJobsTable(dataSource: DataSource): Promise<void> {
    const createTableSql = `
        CREATE TABLE IF NOT EXISTS tmp_export_jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            completed_at INTEGER,
            current_table TEXT,
            current_row INTEGER,
            total_tables INTEGER,
            file_name TEXT NOT NULL,
            error TEXT
        );
    `
    await dataSource.rpc.executeQuery({ sql: createTableSql })
}

/**
 * Create a new export job
 */
export async function createExportJob(
    dataSource: DataSource,
    fileName: string
): Promise<string> {
    const jobId = `export_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const sql = `
        INSERT INTO tmp_export_jobs (id, status, started_at, file_name)
        VALUES (?, ?, ?, ?);
    `
    await dataSource.rpc.executeQuery({
        sql,
        params: [jobId, 'in_progress', Date.now(), fileName],
    })
    return jobId
}

/**
 * Update export job progress
 */
export async function updateExportJobProgress(
    dataSource: DataSource,
    jobId: string,
    currentTable: string,
    currentRow: number,
    totalTables: number
): Promise<void> {
    const sql = `
        UPDATE tmp_export_jobs
        SET current_table = ?, current_row = ?, total_tables = ?
        WHERE id = ?;
    `
    await dataSource.rpc.executeQuery({
        sql,
        params: [currentTable, currentRow, totalTables, jobId],
    })
}

/**
 * Mark export job as completed
 */
export async function completeExportJob(
    dataSource: DataSource,
    jobId: string
): Promise<void> {
    const sql = `
        UPDATE tmp_export_jobs
        SET status = 'completed', completed_at = ?
        WHERE id = ?;
    `
    await dataSource.rpc.executeQuery({
        sql,
        params: [Date.now(), jobId],
    })
}

/**
 * Mark export job as failed
 */
export async function failExportJob(
    dataSource: DataSource,
    jobId: string,
    error: string
): Promise<void> {
    const sql = `
        UPDATE tmp_export_jobs
        SET status = 'failed', completed_at = ?, error = ?
        WHERE id = ?;
    `
    await dataSource.rpc.executeQuery({
        sql,
        params: [Date.now(), error, jobId],
    })
}

/**
 * Get export job status
 */
export async function getExportJob(
    dataSource: DataSource,
    jobId: string
): Promise<ExportJob | null> {
    const sql = `SELECT * FROM tmp_export_jobs WHERE id = ?;`
    const result = (await dataSource.rpc.executeQuery({
        sql,
        params: [jobId],
        isRaw: false,
    })) as any[]

    if (!result || result.length === 0) {
        return null
    }

    const row = result[0]
    return {
        id: row.id as string,
        status: row.status as 'in_progress' | 'completed' | 'failed',
        startedAt: row.started_at as number,
        completedAt: row.completed_at as number | undefined,
        currentTable: row.current_table as string | undefined,
        currentRow: row.current_row as number | undefined,
        totalTables: row.total_tables as number | undefined,
        fileName: row.file_name as string,
        error: row.error as string | undefined,
    }
}
