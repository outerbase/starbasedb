import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hydrateRoot = vi.hoisted(() => vi.fn())

vi.mock('hono/jsx/dom/client', () => ({
    hydrateRoot,
}))

vi.mock('../../public/global.css', () => ({}))

describe('template page entrypoint', () => {
    beforeEach(() => {
        vi.resetModules()
        hydrateRoot.mockClear()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('does not hydrate when the template root is missing', async () => {
        const querySelector = vi.fn(() => null)
        vi.stubGlobal('document', { querySelector })

        await import('./index')

        expect(querySelector).toHaveBeenCalledWith(
            '#root[data-client="template"]'
        )
        expect(hydrateRoot).not.toHaveBeenCalled()
    })

    it('hydrates the template page when the server root is present', async () => {
        const root = {
            dataset: {
                serverProps: '{}',
            },
        }
        const querySelector = vi.fn(() => root)
        vi.stubGlobal('document', { querySelector })

        await import('./index')

        expect(hydrateRoot).toHaveBeenCalledTimes(1)
        expect(hydrateRoot).toHaveBeenCalledWith(root, expect.any(Object))
    })
})
