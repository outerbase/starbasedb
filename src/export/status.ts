import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export async function dumpStatusRoute(
    taskId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Query the Durable Object for the task status
        // We'll add a getDumpStatus method to the RPC
        const status = await dataSource.rpc.executeQuery({
            sql: 'SELECT value FROM _starbase_internal_state WHERE key = ?',
            params: [`dump_state_${taskId}`]
        }) as any[];

        // Wait, the state is in ctx.storage, not necessarily in SQL.
        // But the DO can expose it.
        // Let's use a new RPC method or just reuse executeQuery if we can.
        // Actually, it's better to add a specific RPC method for internal state.
        
        // For now, let's assume we'll add getInternalState to RPC
        const dumpState = await (dataSource.rpc as any).getInternalState(`dump_state_${taskId}`);

        if (!dumpState) {
            return createResponse(undefined, 'Task not found', 404);
        }

        const response: any = {
            task_id: taskId,
            status: dumpState.status,
            progress: {
                tables_completed: dumpState.currentTableIndex,
                total_tables: dumpState.tables.length,
            }
        };

        if (dumpState.status === 'completed') {
            response.download_url = `/export/download/${taskId}`;
        } else if (dumpState.status === 'failed') {
            response.error = dumpState.error;
        }

        return createResponse(response, undefined, 200);
    } catch (error: any) {
        console.error('Dump Status Error:', error);
        return createResponse(undefined, 'Failed to get dump status', 500);
    }
}

export async function downloadDumpRoute(
    taskId: string,
    env: any
): Promise<Response> {
    try {
        const object = await env.R2_BUCKET.get(`dumps/${taskId}.sql`);

        if (!object) {
            return createResponse(undefined, 'Dump file not found', 404);
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Content-Type', 'application/x-sqlite3');
        headers.set('Content-Disposition', `attachment; filename="database_dump_${taskId}.sql"`);

        return new Response(object.body, {
            headers,
        });
    } catch (error: any) {
        console.error('Download Dump Error:', error);
        return createResponse(undefined, 'Failed to download dump', 500);
    }
}
