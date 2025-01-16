import { StarbaseDBDurableObject } from '../../src'
import {
    StarbaseApp,
    StarbaseContext,
    StarbaseDBConfiguration,
} from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { WebSocketPlugin } from '../websocket'

const parser = new (require('node-sql-parser').Parser)()

interface ChangeEvent {
    action: 'INSERT' | 'UPDATE' | 'DELETE' | '*'
    schema: string
    table: string
    column?: string
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
    // WebSocketPlugin instance for us to communicate changes
    private webSocket?: WebSocketPlugin

    private context?: StarbaseContext

    constructor(opts?: {
        stub?: DurableObjectStub<StarbaseDBDurableObject>
        broadcastAllEvents?: boolean
        webSocketPlugin?: WebSocketPlugin
    }) {
        super('starbasedb:change-data-capture', {
            requiresAuth: false,
        })
        this.durableObjectStub = opts?.stub
        this.broadcastAllEvents = opts?.broadcastAllEvents
        this.webSocket = opts?.webSocketPlugin
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.context = c
            await next()
        })

        app.all(this.prefix, async (c, next) => {
            if (!this.context) {
                await next()
                return
            }

            const client = this.webSocket?.createConnection(this.context)

            if (!client) {
                return new Response(null, { status: 400 })
            }

            // this.connections.set(`${Math.random()}`, client)
            return new Response(null, { status: 101, webSocket: client })
        })

        // app.get('/cdc/socket', async (c) => {
        //     const client = this.webSocket?.createConnection()
        //     if (!client) {
        //         return new Response(null, { status: 400 })
        //     }

        //     this.connections.set(`${Math.random()}`, client)
        //     return new Response(null, { status: 101, webSocket: client })
        // })
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

            if (ast.type === 'insert') {
                this.queryEventDetected('INSERT', ast, opts.result)
            } else if (ast.type === 'delete') {
                this.queryEventDetected('DELETE', ast, opts.result)
            } else if (ast.type === 'update') {
                this.queryEventDetected('UPDATE', ast, opts.result)
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
        const matchingEvent = this.listeningEvents?.find(
            (event) =>
                (event.action === action || event.action === '*') &&
                event.schema === schema &&
                event.table === table
        )

        return matchingEvent || this.broadcastAllEvents ? true : false
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

        return eventData
    }

    queryEventDetected(action: string, ast: any, result: any) {
        // Extract the table info
        const table = ast.table?.[0]
        const schema = table?.schema || 'main'
        const tableName = table?.table

        // Check if this matches any of our listening events
        const matchingEvent = this.isEventMatch(action, schema, tableName)

        if (matchingEvent) {
            const eventData = this.extractValuesFromQuery(ast, result)

            console.log('CDC Event Detected:', {
                type: 'INSERT',
                schema,
                table: tableName,
                result: eventData,
            })

            // QUESTION:
            // How do I push this back out of a websocket instead of just logging?
            // if (this.currentRequest) {
            // - Add a property to the request for a webSocketID
            // - Need a way to make sure only authorized requests are receiving these events
            // this.durableObjectStub?.fetch(this.currentRequest);
            // this.durableObjectStub?.state.getWebSockets()
            // }

            // this.connections.forEach(connection => {
            //     console.log('Sending CDC to socket: ', connection)
            //     connection.send('CDC Event detected...')
            //     // this.webSocket?.sendMessage('Test', connection)
            // });
        }
    }
}
