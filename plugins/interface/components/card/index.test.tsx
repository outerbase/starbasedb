import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it } from 'vitest'
import { Card } from './index'

describe('Card', () => {
    it('renders a secondary div card by default', () => {
        const html = renderToString(
            <Card className="custom-card">Card content</Card>
        )

        expect(html).toContain('<div')
        expect(html).toContain('btn-secondary')
        expect(html).toContain('custom-card')
        expect(html).toContain('Card content')
    })

    it('renders an anchor card for link variants', () => {
        const html = renderToString(
            <Card as="a" href="/tables" variant="primary">
                Tables
            </Card>
        )

        expect(html).toContain('<a')
        expect(html).toContain('href="/tables"')
        expect(html).toContain('btn-primary')
        expect(html).toContain('Tables')
    })
})
