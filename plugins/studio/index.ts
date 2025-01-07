import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { handleStudioRequest } from './handler'

export class StudioPlugin extends StarbasePlugin {
    private username: string
    private password: string
    private apiKey: string

    constructor(options: {
        username?: string
        password?: string
        apiKey: string
        prefix?: string
    }) {
        super(
            'starbasedb:studio',
            {
                requiresAuth: false,
            },
            options.prefix ?? '/studio'
        )
        this.username = options.username || ''
        this.password = options.password || ''
        this.apiKey = options.apiKey
    }

    override async register(app: StarbaseApp) {
        if (!this.pathPrefix) return

        app.get(this.pathPrefix, async (c) => {
            return handleStudioRequest(c.req.raw, {
                username: this.username,
                password: this.password,
                apiKey: this.apiKey,
            })
        })
    }
}
