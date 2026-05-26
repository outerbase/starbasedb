/**
 * Durable Object adapter for the streaming dump engine.
 *
 * Bridges the abstract DumpEngineHost interface (defined in dump-engine.ts)
 * to the concrete Cloudflare APIs: ctx.storage.sql, ctx.storage for state,
 * the R2 bucket binding for parts and pending buffer.
 */

import type { DumpEngineHost, RowCursor } from './dump-engine'
import { DumpJobState } from './streaming-dump'

const STATE_KEY_PREFIX = 'dump:job:'

export function jobStateKey(jobId: string): string {
    return STATE_KEY_PREFIX + jobId
}

export interface DumpHostOptions {
    sql: SqlStorage
    storage: DurableObjectStorage
    bucket: R2Bucket
}

export function createDumpHost(opts: DumpHostOptions): DumpEngineHost {
    const { sql, storage, bucket } = opts

    return {
        query(sqlText: string, params?: unknown[]): RowCursor {
            const cursor =
                params && params.length
                    ? sql.exec(sqlText, ...(params as any[]))
                    : sql.exec(sqlText)

            // SqlStorageCursor exposes a JS iterator directly, but we adapt it
            // to the engine's RowCursor.next() contract (returns null at end
            // instead of throwing IteratorResult.done).
            return {
                columns: cursor.columnNames as string[],
                next(): Record<string, unknown> | null {
                    const r = cursor.next()
                    if (r.done) return null
                    return r.value as Record<string, unknown>
                },
            }
        },

        async saveState(state: DumpJobState): Promise<void> {
            await storage.put(jobStateKey(state.jobId), state)
        },

        async uploadPart(
            uploadId: string,
            key: string,
            partNumber: number,
            body: Uint8Array
        ): Promise<R2UploadedPart> {
            const upload = bucket.resumeMultipartUpload(key, uploadId)
            // `uploadPart` accepts ArrayBuffer / ArrayBufferView. We need a
            // detached copy so the underlying buffer cannot be mutated while
            // the upload is in-flight.
            const copy = new Uint8Array(body.byteLength)
            copy.set(body)
            return await upload.uploadPart(partNumber, copy)
        },

        async completeUpload(
            uploadId: string,
            key: string,
            parts: R2UploadedPart[]
        ): Promise<void> {
            const upload = bucket.resumeMultipartUpload(key, uploadId)
            await upload.complete(parts)
        },

        async abortUpload(uploadId: string, key: string): Promise<void> {
            const upload = bucket.resumeMultipartUpload(key, uploadId)
            await upload.abort()
        },

        async readPending(key: string): Promise<Uint8Array | null> {
            const obj = await bucket.get(key)
            if (!obj) return null
            const buf = await obj.arrayBuffer()
            return new Uint8Array(buf)
        },

        async writePending(key: string, bytes: Uint8Array): Promise<void> {
            await bucket.put(key, bytes)
        },

        async deletePending(key: string): Promise<void> {
            await bucket.delete(key)
        },
    }
}
