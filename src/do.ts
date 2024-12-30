import { DurableObject } from 'cloudflare:workers'
// import { OperationQueueItem } from "./operation";
// import { createResponse } from "./utils";

export class StarbaseDBDurableObject extends DurableObject {
    // Durable storage for the SQL database
    public sql: SqlStorage
    public storage: DurableObjectStorage

    // // Queue of operations to be processed, with each operation containing a list of queries to be executed
    // private operationQueue: Array<OperationQueueItem> = [];

    // // Flag to indicate if an operation is currently being processed
    // private processingOperation: { value: boolean } = { value: false };

    /**
     * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
     * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
     *
     * @param ctx - The interface for interacting with Durable Object state
     * @param env - The interface to reference bindings declared in wrangler.toml
     */
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.sql = ctx.storage.sql
        this.storage = ctx.storage

        // Install default necessary `tmp_` tables for various features here.
        const cacheStatement = `
        CREATE TABLE IF NOT EXISTS tmp_cache (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT,
            "timestamp" REAL NOT NULL,
            "ttl" INTEGER NOT NULL,
            "query" TEXT UNIQUE NOT NULL,
            "results" TEXT
        );`

        const allowlistStatement = `
        CREATE TABLE IF NOT EXISTS tmp_allowlist_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sql_statement TEXT NOT NULL,
            source TEXT DEFAULT 'external'
        )`
        const allowlistRejectedStatement = `
        CREATE TABLE IF NOT EXISTS tmp_allowlist_rejections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sql_statement TEXT NOT NULL,
            source TEXT DEFAULT 'external',
            created_at TEXT DEFAULT (datetime('now'))
        )`

        const rlsStatement = `
        CREATE TABLE IF NOT EXISTS tmp_rls_policies (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT,
            "actions" TEXT NOT NULL CHECK(actions IN ('SELECT', 'UPDATE', 'INSERT', 'DELETE')),
            "schema" TEXT,
            "table" TEXT NOT NULL,
            "column" TEXT NOT NULL,
            "value" TEXT NOT NULL,
            "value_type" TEXT NOT NULL DEFAULT 'string',
            "operator" TEXT DEFAULT '='
        )`

        this.executeQuery({ sql: cacheStatement })
        this.executeQuery({ sql: allowlistStatement })
        this.executeQuery({ sql: allowlistRejectedStatement })
        this.executeQuery({ sql: rlsStatement })
    }

    init() {
        return {
            executeQuery: this.executeQuery.bind(this),
        }
    }

    // TODO: Hiding for now as it's not used in the current implementation
    // /**
    //  * Execute a raw SQL query on the database, typically used for external requests
    //  * from other service bindings (e.g. auth). This serves as an exposed function for
    //  * other service bindings to query the database without having to have knowledge of
    //  * the current operation queue or processing state.
    //  *
    //  * @param sql - The SQL query to execute.
    //  * @param params - Optional parameters for the SQL query.
    //  * @returns A response containing the query result or an error message.
    //  */
    // private async executeExternalQuery(
    //   sql: string,
    //   params: any[] | undefined
    // ): Promise<any> {
    //   try {
    //     const queries = [{ sql, params }];
    //     const response = await this.enqueueOperation(
    //       queries,
    //       false,
    //       false,
    //       this.operationQueue,
    //       () =>
    //         this.processNextOperation(
    //           this.sql,
    //           this.operationQueue,
    //           this.ctx,
    //           this.processingOperation
    //         )
    //     );

    //     return response;
    //   } catch (error: any) {
    //     console.error("Execute External Query Error:", error);
    //     return null;
    //   }
    // }

    private async executeRawQuery<
        T extends Record<string, SqlStorageValue> = Record<
            string,
            SqlStorageValue
        >,
    >(opts: { sql: string; params?: unknown[] }) {
        const { sql, params } = opts

        try {
            let cursor

            if (params && params.length) {
                cursor = this.sql.exec<T>(sql, ...params)
            } else {
                cursor = this.sql.exec<T>(sql)
            }

            return cursor
        } catch (error) {
            console.error('SQL Execution Error:', error)
            throw error
        }
    }

    public async executeQuery(opts: {
        sql: string
        params?: unknown[]
        isRaw?: boolean
    }) {
        const cursor = await this.executeRawQuery(opts)

        if (opts.isRaw) {
            return {
                columns: cursor.columnNames,
                rows: Array.from(cursor.raw()),
                meta: {
                    rows_read: cursor.rowsRead,
                    rows_written: cursor.rowsWritten,
                },
            }
        }

        return cursor.toArray()
    }

    public executeTransaction(
        queries: { sql: string; params?: unknown[] }[],
        isRaw: boolean
    ): unknown[] {
        return this.storage.transactionSync(() => {
            const results = []

            try {
                for (const queryObj of queries) {
                    const { sql, params } = queryObj
                    const result = this.executeQuery({ sql, params, isRaw })
                    results.push(result)
                }

                return results
            } catch (error) {
                console.error('Transaction Execution Error:', error)
                throw error
            }
        })
    }

    // TODO: Hiding for now as it's not used in the current implementation
    // private enqueueOperation(
    //   queries: { sql: string; params?: any[] }[],
    //   isTransaction: boolean,
    //   isRaw: boolean,
    //   operationQueue: any[],
    //   processNextOperation: () => Promise<void>
    // ): Promise<{ result?: any; error?: string | undefined; status: number }> {
    //   const MAX_WAIT_TIME = 25000;
    //   return new Promise((resolve, reject) => {
    //     const timeout = setTimeout(() => {
    //       reject(createResponse(undefined, "Operation timed out.", 503));
    //     }, MAX_WAIT_TIME);

    //     operationQueue.push({
    //       queries,
    //       isTransaction,
    //       isRaw,
    //       resolve: (value: any) => {
    //         clearTimeout(timeout);

    //         resolve({
    //           result: value,
    //           error: undefined,
    //           status: 200,
    //         });
    //       },
    //       reject: (reason?: any) => {
    //         clearTimeout(timeout);

    //         reject({
    //           result: undefined,
    //           error: reason ?? "Operation failed.",
    //           status: 500,
    //         });
    //       },
    //     });

    //     processNextOperation().catch((err) => {
    //       console.error("Error processing operation queue:", err);
    //     });
    //   });
    // }

    // TODO: Hiding for now as it's not used in the current implementation
    // private async processNextOperation(
    //   sqlInstance: any,
    //   operationQueue: OperationQueueItem[],
    //   ctx: any,
    //   processingOperation: { value: boolean }
    // ) {
    //   if (processingOperation.value) {
    //     // Already processing an operation
    //     return;
    //   }

    //   if (operationQueue.length === 0) {
    //     // No operations remaining to process
    //     return;
    //   }

    //   processingOperation.value = true;
    //   const { queries, isTransaction, isRaw, resolve, reject } =
    //     operationQueue.shift()!;

    //   try {
    //     let result;

    //     if (isTransaction) {
    //       result = await this.executeTransaction(queries, isRaw);
    //     } else {
    //       const { sql, params } = queries[0];
    //       result = this.executeQuery({ sql, params });
    //     }

    //     resolve(result);
    //   } catch (error: any) {
    //     reject(error.message || "Operation failed.");
    //   } finally {
    //     processingOperation.value = false;
    //     await this.processNextOperation(
    //       sqlInstance,
    //       operationQueue,
    //       ctx,
    //       processingOperation
    //     );
    //   }
    // }

    async fetch(request: Request) {
        const url = new URL(request.url)

        if (url.pathname === '/replicate') {
            if (request.method !== 'POST') {
                return new Response('Method not allowed', { status: 405 })
            }

            try {
                const event = (await request.json()) as any

                if ('cf' in request) {
                    const cf = (request as Request & { cf: { colo: string } })
                        .cf
                    console.log(
                        `Replicating in colo ${cf} :  ${JSON.stringify(event)}`
                    )
                }

                // Type guard for the event
                type SqlEvent = {
                    sql?: string
                    transaction?: Array<{ sql: string; params?: unknown[] }>
                    params?: unknown[]
                    isRaw?: boolean
                }

                const sqlEvent = event.body as SqlEvent
                console.log(`sqlEvent = ${JSON.stringify(sqlEvent)}`)
                if (sqlEvent.sql || sqlEvent.transaction) {
                    if (Array.isArray(sqlEvent.transaction)) {
                        // Handle transaction
                        const trans = await this.executeTransaction(
                            sqlEvent.transaction,
                            sqlEvent.isRaw ?? false
                        )
                        console.log('Trans: ', trans)

                        return new Response(JSON.stringify(trans))
                    } else if (sqlEvent.sql) {
                        console.log('sqlEvent executeQuery: ', sqlEvent.sql)

                        const test = await this.executeQuery({
                            sql: sqlEvent.sql,
                            params: sqlEvent.params,
                            isRaw: sqlEvent.isRaw,
                        })

                        console.log('TEST: ', JSON.stringify(test))
                        // Handle single query
                        return new Response(JSON.stringify(test))
                    }
                }

                return new Response('Invalid event format', { status: 400 })
            } catch (error) {
                console.error('Replication error:', error)
                return new Response('Replication failed', { status: 500 })
            }
        }

        return new Response('Not found', { status: 404 })
    }
}
