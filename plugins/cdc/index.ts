import { StarbaseDBDurableObject } from '../../src'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'

const parser = new (require('node-sql-parser').Parser)()

interface ChangeEvent {
    action: 'INSERT' | 'UPDATE' | 'DELETE' | '*'
    schema: string
    table: string
    column?: string
}

// Add this new interface
interface CDCEventPayload {
    action: string
    schema: string
    table: string
    data: any
}

export class ChangeDataCapturePlugin extends StarbasePlugin {
    // Prefix
    public prefix: string = '/cdc'
    // Stub of the Durable Object class for us to access the web socket
    private durableObjectStub
    // If all events should be broadcasted,
    private broadcastAllEvents?: boolean
    // A list of events that the user is listening to
    private listeningEvents?: ChangeEvent[] = [
        {
            action: 'INSERT',
            schema: 'main',
            table: 'orders',
        },
    ]
    // Configuration details about the request and user
    private config?: StarbaseDBConfiguration
    // Add this new property
    private eventCallbacks: ((payload: CDCEventPayload) => void)[] = []

    constructor(opts?: {
        stub?: DurableObjectStub<StarbaseDBDurableObject>
        broadcastAllEvents?: boolean
    }) {
        super('starbasedb:change-data-capture', {
            requiresAuth: false,
        })
        this.durableObjectStub = opts?.stub
        this.broadcastAllEvents = opts?.broadcastAllEvents
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.config = c?.get('config')
            await next()
        })

        app.all(this.prefix, async (c, next) => {
            if (c.req.header('upgrade') !== 'websocket') {
                return new Response('Expected upgrade request', { status: 400 })
            }

            // Only admin authorized users are permitted to subscribe to CDC events.
            if (this.config?.role !== 'admin') {
                return new Response('Unauthorized request', { status: 400 })
            }

            // Create a new Request object with the modified URL
            let raw: Request = c.req.raw.clone()
            const sessionId = crypto.randomUUID()

            // Save active sessionId in a `tmp_change_detection` table
            // In the DO we should assign this sessionId to a web socket connection
            // Then when we hit `/broadcast?sessionId=123` append the sessionId to it
            // If we detect that query param, only send to connections matching that

            raw = new Request(
                `https://example.com/socket?sessionId=${sessionId}`,
                {
                    method: raw.method,
                    headers: raw.headers,
                    body: raw.body,
                }
            )

            return this.durableObjectStub?.fetch(raw)
        })
    }

    override async afterQuery(opts: {
        sql: string
        result: any
        isRaw: boolean
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<any> {
        try {
            // Parse the SQL statement
            const ast = parser.astify(opts.sql)
            const astObject = Array.isArray(ast) ? ast[0] : ast
            const type = ast.type || ast[0].type

            if (type === 'insert') {
                this.queryEventDetected('INSERT', astObject, opts.result)
            } else if (type === 'delete') {
                this.queryEventDetected('DELETE', astObject, opts.result)
            } else if (type === 'update') {
                this.queryEventDetected('UPDATE', astObject, opts.result)
            }
        } catch (error) {
            console.error('Error parsing SQL in CDC plugin:', error)
        }

        return opts.result
    }

    /**
     * Checks if a given database event matches any of the events we're listening for
     * @param action The database action (INSERT, UPDATE, DELETE, or *)
     * @param schema The database schema name
     * @param table The table name
     * @returns true if there is a matching event subscription, false otherwise
     */
    isEventMatch(action: string, schema: string, table: string): boolean {
        if (this.broadcastAllEvents) return true

        const matchingEvent = this.listeningEvents?.find(
            (event) =>
                (event.action === action || event.action === '*') &&
                event.schema === schema &&
                event.table === table
        )

        return matchingEvent ? true : false
    }

    /**
     * Extracts values from a SQL query AST and result. If the result has data in its
     * array then we will use that information. Otherwise lets use the data from the
     * query to populate our response object.
     * Perhaps in the future we can do a `SELECT * ...` statement in the `beforeQuery`
     * if this is a matching event so we can gain access to the entire rows contents
     * to display here instead of trying to piece together information we have access
     * to in the moment.
     * @param ast The Abstract Syntax Tree of the SQL query
     * @param result The query execution result
     * @returns The extracted data either from the result or parsed from the AST
     */
    extractValuesFromQuery(ast: any, result: any): any {
        let eventData = result

        // If result is empty, extract data from the statement
        if (
            !eventData ||
            (Array.isArray(eventData) && eventData.length === 0)
        ) {
            if (ast.type === 'delete') {
                // For DELETE queries, extract the WHERE clause information
                const whereClause = ast.where
                if (whereClause && whereClause.type === 'binary_expr') {
                    eventData = {
                        [whereClause.left.column]: whereClause.right.value,
                    }
                }
            } else if (ast.type === 'update') {
                // For UPDATE queries, extract from the set array
                eventData = ast.set.reduce((obj: any, item: any) => {
                    obj[item.column] = item.value.value
                    return obj
                }, {})

                // Also include the WHERE clause information
                if (ast.where && ast.where.type === 'binary_expr') {
                    eventData[ast.where.left.column] = ast.where.right.value
                }
            } else {
                // Handle INSERT queries
                const columns = ast.columns
                const values = ast.values?.[0].value

                // Create an object mapping columns to their values
                eventData = columns.reduce(
                    (obj: any, col: string, index: number) => {
                        obj[col] = values[index].value
                        return obj
                    },
                    {}
                )
            }
        }

        return eventData
    }

    /**
     * Register a callback function to be called when CDC events occur
     * @param callback The function to be called with the CDC event payload
     */
    public onEvent(callback: (payload: CDCEventPayload) => void) {
        this.eventCallbacks.push(callback)
    }

    queryEventDetected(
        action: string,
        ast: any,
        result: any,
        sessionId?: string
    ) {
        // Extract the table info
        const table = ast.table?.[0]
        const schema = table?.schema || 'main'
        const tableName = table?.table

        // Check if this matches any of our listening events
        const matchingEvent = this.isEventMatch(action, schema, tableName)

        if (matchingEvent) {
            const eventData = this.extractValuesFromQuery(ast, result)
            const payload = {
                action,
                schema,
                table: tableName,
                data: eventData,
            }

            const message = {
                type: 'cdc_event',
                payload,
            }

            // Trigger all registered callbacks
            this.eventCallbacks.forEach((callback) => {
                try {
                    callback(payload)
                } catch (error) {
                    console.error('Error in CDC event callback:', error)
                }
            })

            // Send the broadcast message to the Durable Object
            this.durableObjectStub?.fetch(
                new Request(
                    `https://example.com/socket/broadcast${sessionId ? `?sessionId=${sessionId}` : ''}`,
                    {
                        method: 'POST',
                        body: JSON.stringify(message),
                    }
                )
            )
        }
    }
}
