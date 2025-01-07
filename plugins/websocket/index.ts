import { StarbaseApp, StarbaseContext } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'

export class WebSocketPlugin extends StarbasePlugin {
    private prefix = '/socket'

    constructor(opts?: { prefix?: string }) {
        super('starbasedb:websocket', {
            requiresAuth: true,
        })
        this.prefix = opts?.prefix ?? this.prefix
    }

    override async register(app: StarbaseApp) {
        app.all(this.prefix, (c) => {
            return this.upgrade(c)
        })
    }

    private upgrade(ctx: StarbaseContext): Response {
        if (ctx.req.header('upgrade') !== 'websocket') {
            return new Response('Expected upgrade request', { status: 400 })
        }

        const config = ctx.get('config')
        const dataSource = ctx.get('dataSource')
        const { executeQuery } = ctx.get('operations')

        const webSocketPair = new WebSocketPair()
        const [client, server] = Object.values(webSocketPair)

        server.accept()
        server.addEventListener('message', (event) => {
            const { sql, params, action } = JSON.parse(event.data as string)

            if (action === 'query') {
                const executeQueryWrapper = async () => {
                    const response = await executeQuery({
                        sql,
                        params,
                        isRaw: false,
                        dataSource,
                        config,
                    })
                    server.send(JSON.stringify(response))
                }
                executeQueryWrapper()
            }
        })

        return new Response(null, { status: 101, webSocket: client })
    }
}
