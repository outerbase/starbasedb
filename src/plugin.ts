import type { StarbaseApp } from './handler'

class UnimplementedError extends Error {
    constructor(public method: string) {
        super(`Method ${method} is not implemented`)
    }
}

export abstract class StarbasePlugin {
    constructor(public name: string) {
        console.log(`Plugin ${name} loaded`)
    }

    public async register(app: StarbaseApp): Promise<void> {
        throw new UnimplementedError('register')
    }
}

export class StarbasePluginRegistry {
    private app: StarbaseApp
    private plugins: StarbasePlugin[] = []

    constructor(opts: { app: StarbaseApp; plugins: StarbasePlugin[] }) {
        this.app = opts.app
        this.plugins = opts.plugins
    }

    async init() {
        for (const plugin of this.plugins) {
            await this.registerPlugin(plugin)
        }
    }

    private async registerPlugin(plugin: StarbasePlugin) {
        try {
            await plugin.register(this.app)
            console.log(`Plugin ${plugin.name} registered`)
        } catch (e) {
            if (e instanceof UnimplementedError) {
                return
            }

            console.error(`Error registering plugin ${plugin.name}: ${e}`)
            throw e
        }
    }
}
