import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { handleStudioRequest } from './handler'

export class StudioPlugin extends StarbasePlugin {
    private username: string
    private password: string
    private apiKey: string
    private prefix: string

    constructor(options: {
        username: string
        password: string
        apiKey: string
        prefix?: string
    }) {
        super('starbasedb:studio')
        this.username = options.username
        this.password = options.password
        this.apiKey = options.apiKey
        this.prefix = options.prefix || '/studio'
    }

    override async register(app: StarbaseApp) {
        app.get(this.prefix, async (c) => {
            return handleStudioRequest(c.req.raw, {
                username: this.username,
                password: this.password,
                apiKey: this.apiKey,
            })
        })
    }
}
