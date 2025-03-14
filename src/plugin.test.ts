import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StarbasePlugin, StarbasePluginRegistry } from './plugin'
import type { StarbaseApp, StarbaseDBConfiguration } from './handler'
import type { DataSource } from './types'

const mockApp = {} as StarbaseApp

class MockPlugin extends StarbasePlugin {
    async register(app: StarbaseApp): Promise<void> {
        console.log(`MockPlugin ${this.name} registered`)
    }

    async beforeQuery(opts: {
        sql: string
        params?: unknown[]
    }): Promise<{ sql: string; params?: unknown[] }> {
        return { sql: `${opts.sql} /* modified */`, params: opts.params }
    }

    async afterQuery(opts: { sql: string; result: any }): Promise<any> {
        return { ...opts.result, modified: true }
    }
}

class TestPlugin extends StarbasePlugin {}

class BrokenPlugin extends StarbasePlugin {
    async register(): Promise<void> {
        throw new Error('Broken plugin')
    }
}

describe('StarbasePlugin', () => {
    it('should throw an error when register() is called without implementation', async () => {
        const plugin = new TestPlugin('TestPlugin')

        await expect(plugin.register(mockApp)).rejects.toThrowError(
            'Method register is not implemented'
        )
    })

    it('should return unmodified SQL in beforeQuery()', async () => {
        const plugin = new TestPlugin('TestPlugin')

        const result = await plugin.beforeQuery({ sql: 'SELECT * FROM users' })

        expect(result).toEqual({
            sql: 'SELECT * FROM users',
            params: undefined,
        })
    })

    it('should return unmodified result in afterQuery()', async () => {
        const plugin = new TestPlugin('TestPlugin')

        const result = await plugin.afterQuery({
            sql: 'SELECT * FROM users',
            result: { data: [] },
            isRaw: false,
        })

        expect(result).toEqual({ data: [] })
    })
    it('should apply beforeQuery modifications in order', async () => {
        class PluginA extends StarbasePlugin {
            async beforeQuery(opts: {
                sql: any
                params?: any
                dataSource?: DataSource | undefined
                config?: StarbaseDBConfiguration | undefined
            }) {
                return { sql: `[A] ${opts.sql}`, params: opts.params }
            }
        }

        class PluginB extends StarbasePlugin {
            async beforeQuery(opts: {
                sql: any
                params?: any
                dataSource?: DataSource | undefined
                config?: StarbaseDBConfiguration | undefined
            }) {
                return { sql: `[B] ${opts.sql}`, params: opts.params }
            }
        }

        const pluginA = new PluginA('PluginA')
        const pluginB = new PluginB('PluginB')

        const registry = new StarbasePluginRegistry({
            app: mockApp,
            plugins: [pluginA, pluginB],
        })

        const result = await registry.beforeQuery({
            sql: 'SELECT * FROM users',
        })

        expect(result.sql).toBe('[B] [A] SELECT * FROM users')
    })
})

describe('StarbasePluginRegistry', () => {
    let registry: StarbasePluginRegistry
    let mockPlugin: MockPlugin

    beforeEach(() => {
        mockPlugin = new MockPlugin('MockPlugin')
        registry = new StarbasePluginRegistry({
            app: mockApp,
            plugins: [mockPlugin],
        })

        vi.spyOn(mockPlugin, 'register').mockResolvedValue(undefined)
        vi.spyOn(mockPlugin, 'beforeQuery')
        vi.spyOn(mockPlugin, 'afterQuery')
    })

    it('should register plugins correctly', async () => {
        await registry.init()

        expect(mockPlugin.register).toHaveBeenCalledWith(mockApp)
    })

    it('should handle UnimplementedError during registration', async () => {
        // Temporarily mock console.error to suppress the error output
        const originalConsoleError = console.error
        console.error = vi.fn()

        try {
            // Create a plugin that will throw an error during initialization
            class BrokenPlugin2 extends StarbasePlugin {
                constructor() {
                    super('BrokenPlugin2')
                }

                async register(): Promise<void> {
                    throw new Error('Broken plugin')
                }
            }

            // Create registry with the broken plugin
            const registry = new StarbasePluginRegistry({
                app: {} as StarbaseApp,
                plugins: [new BrokenPlugin2()],
            })

            // We need to expect this to throw since the implementation doesn't catch errors
            await expect(registry.init()).rejects.toThrow('Broken plugin')
        } finally {
            // Restore console.error
            console.error = originalConsoleError
        }
    })

    it('should call beforeQuery on all plugins', async () => {
        const result = await registry.beforeQuery({
            sql: 'SELECT * FROM users',
        })

        expect(mockPlugin.beforeQuery).toHaveBeenCalled()
        expect(result.sql).toBe('SELECT * FROM users /* modified */')
    })

    it('should call afterQuery on all plugins', async () => {
        const result = await registry.afterQuery({
            sql: 'SELECT * FROM users',
            result: { data: [] },
            isRaw: false,
        })

        expect(mockPlugin.afterQuery).toHaveBeenCalled()
        expect(result).toEqual({ data: [], modified: true })
    })
})
