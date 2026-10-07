import { Hono } from 'hono'
import { Env, validateAuth } from '../middleware/index'
import type { DB } from '@databases/sqlite'
import { z } from 'zod'
import { randomUUID } from 'cloudflare:workers'
import { getR2Object, putR2Object } from '../../utils/r2'

const exportRouter = new Hono<Env>()

export const ExportFormatSchema = z.enum(['sql', 'csv', 'json'])
export type ExportFormat = z.infer<typeof ExportFormatSchema>

export const ExportTableSchema = z.object({
  name: z.string().min(1),
})

export const ExportOptionsSchema = z.object({
  format: ExportFormatSchema.optional().default('sql'),
  table: ExportTableSchema.optional(),
  limit: z.number().int().positive().max(10000).optional().default(1000),
  r2Bucket: z.string().optional(),
  callbackUrl: z.string().url().optional(),
})
export type ExportOptions = z.infer<typeof ExportOptionsSchema>

export const ExportResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  url: z.string().optional(),
  filename: z.string().optional(),
  size: z.number().optional(),
})

// Helper: stream SQL dump directly to R2 with DoAlarm support
async function streamSQLDumpToR2(
  db: DB,
  r2Bucket: string | undefined,
  tableName: string | undefined,
  ctx: { env: Env; executionCtx?: ExecutionContext },
  progress?: { rowsExported: number; totalRows: number; lastCheckpoint: string }
): Promise<{ url: string; filename: string; rowsExported: number }> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `dump_${timestamp}_${randomUUID()}.sql`
  const bucket = r2Bucket || ctx.env.STARBASE_EXPORT_BUCKET

  if (!bucket) {
    throw new Error('R2 bucket not configured. Provide r2Bucket option or set STARBASE_EXPORT_BUCKET binding.')
  }

  // Build query
  const tables = tableName ? [tableName] : []
  if (tables.length === 0) {
    const allTables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    for (const row of allTables) {
      if (row[0]) tables.push(String(row[0]))
    }
  }

  let offset = progress?.rowsExported || 0
  const stream = new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(new TextEncoder().encode(chunk))
    }
  })

  const writer = (await (r2Bucket ? bucket : ctx.env.STARBASE_EXPORT_BUCKET!).put(filename, stream, {
    httpMetadata: { contentType: 'application/sql' }
  })) as any

  // For now, stream incrementally via R2 multipart-like approach
  // We'll collect chunks and write progressively
  const chunks: Uint8Array[] = []
  let totalRows = 0

  // Start from progress checkpoint
  const startIdx = offset
  let idx = 0

  for (const table of tables) {
    const safeTable = table.replace(/'/g, "''")
    
    // Stream header for each table
    const headerChunk = `-- Table: ${safeTable}\n-- Exported at: ${new Date().toISOString()}\n\nBEGIN TRANSACTION;\n\n`
    chunks.push(new TextEncoder().encode(headerChunk))
    idx += headerChunk.length

    // Get schema
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${safeTable}'`).get() as any
    if (schema && schema.sql) {
      const schemaChunk = `${schema.sql};\n\n`
      chunks.push(new TextEncoder().encode(schemaChunk))
      idx += schemaChunk.length
    }

    // Stream data in batches to avoid memory issues
    const batchSize = 500
    let batchOffset = startIdx > totalRows ? startIdx - totalRows : 0
    
    while (true) {
      const rows = db.prepare(`SELECT * FROM "${safeTable}" LIMIT ${batchSize} OFFSET ${batchOffset}`).all() as any[]
      if (rows.length === 0) break
      
      for (const row of rows) {
        const values: string[] = []
        const columns = Object.keys(row)
        for (const col of columns) {
          let val = row[col]
          if (val === null) {
            values.push('NULL')
          } else if (typeof val === 'string') {
            values.push(`'${val.replace(/'/g, "''")}'`)
          } else if (typeof val === 'object' && val.buffer) {
            // Blob handling
            const bytes = new Uint8Array(val.buffer)
            values.push(`X'${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}'`)
          } else {
            values.push(String(val))
          }
        }
        const insertStmt = `INSERT INTO "${safeTable}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});\n`
        chunks.push(new TextEncoder().encode(insertStmt))
        idx += insertStmt.length
        totalRows++
      }
      batchOffset += batchSize

      // Yield control for breathing interval simulation
      if (idx % 50000 === 0) {
        await new Promise(r => setTimeout(r, 0))
      }

      // Check if we should continue via alarm (for large exports)
      if (totalRows > (progress?.rowsExported || 0) + 10000) {
        // Schedule continuation alarm
        ctx.executionCtx?.scheduleAlarm({
          alarmId: `dump-continue-${filename}`,
          runAt: Date.now() + 5000,
          payload: JSON.stringify({ filename, bucket, offset: totalRows, tables, hasMore: true }),
        })
        break
      }
    }
  }

  // Write final data to R2
  const finalData = Buffer.concat(chunks)
  await putR2Object(bucket, filename, finalData, { contentType: 'application/sql' })

  return {
    url: `https://${ctx.env.CF_ACCOUNT_ID}.r2.dev/${bucket}/${filename}`,
    filename,
    rowsExported: totalRows,
  }
}

exportRouter.get('/export/dump', validateAuth, async (c) => {
  const db = c.get('db')
  const { format, table, limit, r2Bucket, callbackUrl } = ExportOptionsSchema.parse(c.req.query())
  
  const exportStart = Date.now()
  
  // Check if this is a resumable/large export
  const estimateRows = table 
    ? (db.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get() as any)?.cnt 
    : 0
  
  // For large exports, use R2 streaming
  if ((estimateRows || 0) > 10000 || limit > 5000) {
    const result = await streamSQLDumpToR2(db, r2Bucket, table, c, {
      rowsExported: 0,
      totalRows: estimateRows || 0,
      lastCheckpoint: new Date().toISOString(),
    })

    // Fire callback if provided
    if (callbackUrl) {
      try {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: true,
            filename: result.filename,
            url: result.url,
            rowsExported: result.rowsExported,
            durationMs: Date.now() - exportStart,
          }),
        })
      } catch (e) {
        console.error('Callback failed:', e)
      }
    }

    return c.json({
      success: true,
      message: `Database dump created successfully. File available for download.`,
      url: result.url,
      filename: result.filename,
      size: result.rowsExported,
    })
  }

  // Small export - return inline (existing behavior)
  const tables = table ? [table] : []
  if (tables.length === 0) {
    const allTables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    for (const row of allTables) {
      if (row[0]) tables.push(String(row[0]))
    }
  }

  const sqlChunks: string[] = []
  
  for (const tableName of tables) {
    const safeTable = tableName.replace(/'/g, "''")
    
    // Schema
    const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${safeTable}'`).get() as any
    if (schema?.sql) {
      sqlChunks.push(`${schema.sql};\n\n`)
    }
    
    // Data
    const rows = db.prepare(`SELECT * FROM "${safeTable}" LIMIT ${limit}`).all() as any[]
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []
    
    for (const row of rows) {
      const values: string[] = []
      for (const col of columns) {
        let val = row[col]
        if (val === null) {
          values.push('NULL')
        } else if (typeof val === 'string') {
          values.push(`'${val.replace(/'/g, "''")}'`)
        } else if (typeof val === 'object' && val.buffer) {
          const bytes = new Uint8Array(val.buffer)
          values.push(`X'${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}'`)
        } else {
          values.push(String(val))
        }
      }
      sqlChunks.push(`INSERT INTO "${safeTable}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${values.join(', ')});\n`)
    }
  }

  const sqlContent = sqlChunks.join('\n')
  const blob = new Blob([sqlContent], { type: 'application/sql' })

  return c.newResponse(blob.stream(), 200, {
    'Content-Disposition': 'attachment; filename="database_dump.sql"',
    'Content-Type': 'application/sql',
  })
})

exportRouter.get('/export/:format', validateAuth, async (c) => {
  const db = c.get('db')
  const format = c.req.param('format') as ExportFormat
  const { table, limit } = ExportOptionsSchema.parse(c.req.query())

  const tables = table ? [table] : []
  if (tables.length === 0) {
    const allTables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    for (const row of allTables) {
      if (row[0]) tables.push(String(row[0]))
    }
  }

  let content = ''
  const disposition = `attachment; filename="database_dump.${format}"`

  if (format === 'json') {
    const data: Record<string, any[]> = {}
    for (const tableName of tables) {
      const rows = db.prepare(`SELECT * FROM "${tableName}" LIMIT ${limit}`).all() as any[]
      data[tableName] = rows
    }
    content = JSON.stringify(data, null, 2)
  } else if (format === 'csv') {
    const rows: string[] = []
    for (const tableName of tables) {
      const schema = db.prepare(`SELECT * FROM "${tableName}" LIMIT 1`).get() as any
      if (!schema) continue
      const columns = Object.keys(schema)
      rows.push(columns.join(','))
      const data = db.prepare(`SELECT * FROM "${tableName}" LIMIT ${limit}`).all() as any[]
      for (const row of data) {
        const values = columns.map(col => {
          const val = row[col]
          if (val === null) return ''
          const str = String(val)
          return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str
        })
        rows.push(values.join(','))
      }
    }
    content = rows.join('\n')
  }

  return c.newResponse(content, 200, {
    'Content-Disposition': disposition,
    'Content-Type': format === 'json' ? 'application/json' : 'text/csv',
  })
})

export default exportRouter
