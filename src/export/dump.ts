import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

// Rows fetched per page while streaming a table. Caps how much data is held
// in memory at once, independent of the table's total size.
const EXPORT_PAGE_SIZE = 1000

// SQLite database file magic string, emitted first for parity with the
// original implementation.
const SQLITE_HEADER = 'SQLite format 3\0'

// Alias used to carry each row's rowid alongside its columns for keyset
// pagination. Deliberately unlikely to collide with a real column name.
const ROWID_ALIAS = '__starbasedb_export_rowid__'

// Quote a SQL identifier so unusual table names and reserved words are safe.
function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

// Render a value returned by the driver as a SQL literal for an INSERT.
function toSqlLiteral(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value)
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    if (value instanceof ArrayBuffer) {
        const hex = Array.from(new Uint8Array(value))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }
    return `'${String(value).replace(/'/g, "''")}'`
}

// List every user table in the database.
async function listTables(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    const rows = await executeOperation(
        [
            {
                sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
            },
        ],
        dataSource,
        config
    )

    return rows.map((row: any) => row.name as string)
}

// Yield a table's rows one bounded page at a time.
//
// Ordinary tables use keyset pagination on the implicit `_rowid_`
// (`WHERE _rowid_ > ?`), which stays O(n) across the whole table. Plain
// `LIMIT/OFFSET` re-walks every skipped row on each page — O(n²) — which is
// what makes dumping a large database unusably slow today.
//
// `WITHOUT ROWID` tables have no `_rowid_`, so they fall back to `LIMIT/OFFSET`.
async function* streamTableRows(
    table: string,
    keyset: boolean,
    pageSize: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<Record<string, any>[]> {
    const quoted = quoteIdentifier(table)

    if (keyset) {
        let cursor: unknown = undefined

        while (true) {
            const sql =
                cursor === undefined
                    ? `SELECT *, _rowid_ AS ${ROWID_ALIAS} FROM ${quoted} ORDER BY _rowid_ LIMIT ?;`
                    : `SELECT *, _rowid_ AS ${ROWID_ALIAS} FROM ${quoted} WHERE _rowid_ > ? ORDER BY _rowid_ LIMIT ?;`
            const params =
                cursor === undefined ? [pageSize] : [cursor, pageSize]

            const rows = await executeOperation(
                [{ sql, params }],
                dataSource,
                config
            )
            if (!rows.length) {
                return
            }

            const nextCursor = rows[rows.length - 1][ROWID_ALIAS]
            for (const row of rows) {
                delete row[ROWID_ALIAS]
            }

            yield rows

            if (rows.length < pageSize || nextCursor === undefined) {
                return
            }
            cursor = nextCursor
        }
    } else {
        let offset = 0

        while (true) {
            const rows = await executeOperation(
                [
                    {
                        sql: `SELECT * FROM ${quoted} LIMIT ? OFFSET ?;`,
                        params: [pageSize, offset],
                    },
                ],
                dataSource,
                config
            )
            if (!rows.length) {
                return
            }

            yield rows

            if (rows.length < pageSize) {
                return
            }
            offset += rows.length
        }
    }
}

// Produce the dump as a sequence of text chunks, fetching only one page of
// rows from the database at any given moment.
async function* generateDump(
    tables: string[],
    pageSize: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    yield SQLITE_HEADER

    for (const table of tables) {
        const schemaRows = await executeOperation(
            [
                {
                    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                    params: [table],
                },
            ],
            dataSource,
            config
        )

        const schema: string | undefined = schemaRows[0]?.sql
        if (!schema) {
            continue
        }

        yield `\n-- Table: ${table}\n${schema};\n\n`

        const quoted = quoteIdentifier(table)
        const keyset = !/without\s+rowid/i.test(schema)

        for await (const rows of streamTableRows(
            table,
            keyset,
            pageSize,
            dataSource,
            config
        )) {
            let chunk = ''
            for (const row of rows) {
                const values = Object.values(row).map(toSqlLiteral)
                chunk += `INSERT INTO ${quoted} VALUES (${values.join(', ')});\n`
            }
            yield chunk
        }

        yield '\n'
    }
}

// Adapt an async iterable of strings into a pull-based byte stream. Because
// the stream is `pull`-driven, the runtime only asks the generator for the
// next page once the previous chunk has been flushed downstream — this is
// what gives the dump real backpressure.
function toReadableStream(
    chunks: AsyncGenerator<string>
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await chunks.next()
                if (done) {
                    controller.close()
                    return
                }
                if (value) {
                    controller.enqueue(encoder.encode(value))
                }
            } catch (error) {
                controller.error(error)
            }
        },
        async cancel() {
            await chunks.return(undefined)
        },
    })
}

// Stream a full SQL dump of the database.
//
// The previous implementation concatenated every row of every table into a
// single in-memory string before responding, so a large database would
// exceed the isolate's memory limit and the request would fail outright.
//
// This implementation streams the dump instead:
//   - rows are read one bounded page at a time using keyset pagination (O(n)),
//   - each page is encoded, enqueued, and then released,
//   - the response body is a `pull`-driven `ReadableStream`, so the runtime
//     paces production to match how fast the client consumes it.
//
// Peak memory is therefore proportional to one page, not to the database size.
export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize: number = EXPORT_PAGE_SIZE
): Promise<Response> {
    try {
        // Resolve the table list eagerly so a connection or permission error
        // surfaces as a clean 500 before the streaming response has started.
        const tables = await listTables(dataSource, config)

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        })

        const body = toReadableStream(
            generateDump(tables, pageSize, dataSource, config)
        )

        return new Response(body, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
