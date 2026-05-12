import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Select } from './index'

describe('Select', () => {
    it('renders placeholder and options with the selected value', () => {
        const html = renderToString(
            <Select
                className="custom-select"
                options={['alpha', 'beta']}
                placeholder="Choose"
                setValue={vi.fn()}
                size="sm"
                value="beta"
            />
        )

        expect(html).toContain('<select')
        expect(html).toContain('custom-select')
        expect(html).toContain('ob-size-sm')
        expect(html).toContain('value="beta"')
        expect(html).toContain('<option>Choose</option>')
        expect(html).toContain('<option value="alpha">alpha</option>')
        expect(html).toContain('<option value="beta">beta</option>')
        expect(html).toContain('background-image:url(/caret.svg)')
    })
})
