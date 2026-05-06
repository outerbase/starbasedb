import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import { executeOperation } from '.'

/**
 * Default page size when reading rows from a table for export. SQLite + DO
 * round-trips are cheap, but the JS-side cost of holding rows in memory is the
 * scaling bottleneck — 1000 rows per page keeps peak memory well under the
 * 128 MB DO isolate limit even for very wide rows while still amortising query
 * overhead.
 */
export const DEFAULT_PAGE_SIZE = 1000

/**
 * Yield back to the runtime between pages. Cloudflare Workers expose
 * `scheduler.wait(0)` as the canonical "let the event loop breathe" hook;
 * `setTimeout(0)` is the universal fallback (vitest, node, browsers).
 *
 * Without this, exporting a 10 GB DB monopolises the isolate long enough that
 * Cloudflare evicts the DO mid-stream — see issue #59 for context.
 */
export async function breathe(): Promise<void> {
    const sched = (globalThis as any).scheduler
    if (sched && typeof sched.wait === 'function') {
        await sched.wait(0)
        return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/**
 * Async iterator over the rows of a single table. Pages with LIMIT/OFFSET so
 * we never materialise more than `pageSize` rows in memory at once, and
 * `breathe()`s between pages so the DO runtime stays responsive.
 *
 * We assume the caller has already validated the table name (handler does this
 * via `hasTableName`); the dump endpoint reads names directly from
 * `sqlite_master` which is trusted. We still avoid concatenating the page
 * markers as identifiers — LIMIT/OFFSET take bound integers.
 */
export async function* iterateTableRows(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize: number = DEFAULT_PAGE_SIZE
): AsyncGenerator<any, void, void> {
    let offset = 0
    while (true) {
        const page = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${tableName} LIMIT ? OFFSET ?;`,
                    params: [pageSize, offset],
                },
            ],
            dataSource,
            config
        )

        if (!page || page.length === 0) return

        for (const row of page) yield row

        if (page.length < pageSize) return
        offset += page.length
        await breathe()
    }
}

/**
 * Wrap an async generator of string chunks as a `ReadableStream<Uint8Array>`
 * suitable for handing directly to `new Response(stream, ...)`. Errors thrown
 * inside the generator propagate to the stream consumer (the HTTP client sees
 * a truncated body, which is the correct signal mid-export).
 */
export function chunksToStream(
    chunks: AsyncGenerator<string, void, void>
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await chunks.next()
                if (done) {
                    controller.close()
                    return
                }
                if (value) controller.enqueue(encoder.encode(value))
            } catch (err) {
                controller.error(err)
            }
        },
        async cancel(reason) {
            // Allow the generator to clean up if the client disconnects.
            await chunks.return?.(undefined as any)
        },
    })
}

export function streamingResponse(
    stream: ReadableStream<Uint8Array>,
    fileName: string,
    contentType: string
): Response {
    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        // Hint to clients/proxies that we're streaming — discourages buffering.
        'Cache-Control': 'no-store',
        'Transfer-Encoding': 'chunked',
    })
    return new Response(stream, { headers })
}
