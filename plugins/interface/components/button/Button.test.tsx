import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
    it('renders a button with variant, size, title, and custom classes', () => {
        const html = renderToString(
            <Button
                className="custom-class"
                size="lg"
                title="Save changes"
                variant="primary"
            >
                <span>Icon</span>
            </Button>
        )

        expect(html).toContain('<button')
        expect(html).toContain('btn-primary')
        expect(html).toContain('ob-size-lg')
        expect(html).toContain('custom-class')
        expect(html).toContain('Save changes')
        expect(html).toContain('<span>Icon</span>')
    })

    it('uses anchor markup for href buttons and omits title text for square buttons', () => {
        const html = renderToString(
            <Button href="/docs" shape="square" title="Docs">
                D
            </Button>
        )

        expect(html).toContain('<a')
        expect(html).toContain('href="/docs"')
        expect(html).not.toContain('>Docs<')
        expect(html).toContain('>D</a>')
    })
})
