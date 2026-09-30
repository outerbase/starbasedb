import { afterEach, describe, expect, it, vi } from 'vitest'
import { CronPlugin } from './index'
const events = [
    { name: 'first', cron_tab: '* * * * *', payload: {} },
    { name: 'second', cron_tab: '* * * * *', payload: {} },
]
async function route(plugin: CronPlugin) {
    const app = { use: vi.fn(), post: vi.fn() }
    await plugin.register(app as any)
    return () =>
        app.post.mock.calls[0][1]({ req: { json: async () => events } })
}
afterEach(() => vi.restoreAllMocks())
describe('cron callback delivery', () => {
    it.each(['sync', 'async'])(
        'contains %s failures for every event and still delivers to other listeners',
        async (mode) => {
            const error = vi
                .spyOn(console, 'error')
                .mockImplementation(() => {})
            const plugin = new CronPlugin()
            plugin.onEvent(() => {
                if (mode === 'sync') throw new Error('listener failed')
                return Promise.reject(new Error('listener failed'))
            })
            const healthy = vi.fn()
            plugin.onEvent(healthy)
            const response = await (await route(plugin))()
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ result: { success: true } })
            expect(healthy.mock.calls.map(([event]) => event.name)).toEqual([
                'first',
                'second',
            ])
            expect(error).toHaveBeenCalledTimes(2)
        }
    )
    it('waits for asynchronous delivery without an execution context', async () => {
        const plugin = new CronPlugin()
        let finish!: () => void
        const pending = new Promise<void>((resolve) => {
            finish = resolve
        })
        const done = vi.fn()
        plugin.onEvent(async () => {
            await pending
            done()
        })
        const handler = await route(plugin)
        let replied = false
        const response = handler().then(() => {
            replied = true
        })
        await Promise.resolve()
        await Promise.resolve()
        expect(replied).toBe(false)
        finish()
        await response
        expect(done).toHaveBeenCalledTimes(2)
    })
    it('defers pending delivery through waitUntil without blocking the response', async () => {
        const plugin = new CronPlugin()
        let finish!: () => void
        const pending = new Promise<void>((resolve) => {
            finish = resolve
        })
        const waitUntil = vi.fn()
        plugin.onEvent(() => pending, { waitUntil } as any)
        const response = await (await route(plugin))()
        expect(response.status).toBe(200)
        expect(waitUntil).toHaveBeenCalledTimes(2)
        finish()
        await Promise.all(waitUntil.mock.calls.map(([promise]) => promise))
    })
    it('handles rejected deferred callbacks before passing them to waitUntil', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const waitUntil = vi.fn()
        const plugin = new CronPlugin()
        plugin.onEvent(
            async () => {
                throw new Error('late failure')
            },
            { waitUntil } as any
        )
        await (
            await route(plugin)
        )()
        await expect(
            Promise.all(waitUntil.mock.calls.map(([promise]) => promise))
        ).resolves.toEqual([undefined, undefined])
        expect(error).toHaveBeenCalledTimes(2)
    })
    it('accepts a batch with no subscribers', async () => {
        expect((await (await route(new CronPlugin()))()).status).toBe(200)
    })
})
