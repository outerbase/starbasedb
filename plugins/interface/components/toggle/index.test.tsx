import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Toggle } from './index'

describe('Toggle', () => {
    it('renders untoggled state with base sizing', () => {
        const html = renderToString(
            <Toggle onClick={vi.fn()} toggled={false} />
        )

        expect(html).toContain('<button')
        expect(html).toContain('h-6.5')
        expect(html).toContain('w-10.5')
        expect(html).not.toContain('translate-x-full')
    })

    it('renders toggled state with large sizing', () => {
        const html = renderToString(
            <Toggle onClick={vi.fn()} size="lg" toggled />
        )

        expect(html).toContain('h-7.5')
        expect(html).toContain('w-12.5')
        expect(html).toContain('translate-x-full')
        expect(html).toContain('bg-neutral-900')
    })
})
