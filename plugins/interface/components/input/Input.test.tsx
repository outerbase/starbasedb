import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Input } from './Input'

describe('Input', () => {
    it('renders a plain input with sizing, value, and invalid state classes', () => {
        const html = renderToString(
            <Input
                className="custom-input"
                initialValue="users"
                isValid={false}
                onValueChange={vi.fn()}
                placeholder="Table"
                size="lg"
            />
        )

        expect(html).toContain('<input')
        expect(html).toContain('custom-input')
        expect(html).toContain('ob-size-lg')
        expect(html).toContain('text-ob-destructive')
        expect(html).toContain('value="users"')
        expect(html).toContain('placeholder="Table"')
    })

    it('wraps the input with preText and postText when provided', () => {
        const html = renderToString(
            <Input
                initialValue="public"
                onValueChange={vi.fn()}
                postText=".sqlite"
                preText="schema:"
                size="sm"
            />
        )

        expect(html).toContain('<div')
        expect(html).toContain('ob-size-sm')
        expect(html).toContain('schema:')
        expect(html).toContain('.sqlite')
        expect(html).toContain('value="public"')
    })
})
