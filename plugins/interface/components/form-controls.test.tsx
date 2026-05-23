import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it, vi } from 'vitest'

import { Button } from './button/Button'
import { Select } from './select'

describe('interface form controls', () => {
    it('renders buttons with the expected element, title, variant, and custom classes', () => {
        const html = renderToString(
            <Button
                className="tracking-test"
                href="/docs"
                title="Open docs"
                variant="primary"
            />
        )

        expect(html).toContain('<a')
        expect(html).toContain('href="/docs"')
        expect(html).toContain('Open docs')
        expect(html).toContain('btn-primary')
        expect(html).toContain('btn-shadow')
        expect(html).toContain('ob-size-base')
        expect(html).toContain('tracking-test')
    })

    it('keeps square loading buttons icon-only while preserving disabled state', () => {
        const html = renderToString(
            <Button
                disabled
                loading
                shape="square"
                size="lg"
                title="Save"
                variant="destructive"
            />
        )

        expect(html).toContain('<button')
        expect(html).toContain('disabled')
        expect(html).toContain('btn-destructive')
        expect(html).toContain('ob-disable')
        expect(html).toContain('ob-size-lg')
        expect(html).toContain('square')
        expect(html).toContain('w-4')
        expect(html).not.toContain('Save')
    })

    it('renders select options, placeholder text, size classes, and custom classes', () => {
        const setValue = vi.fn()

        const html = renderToString(
            <Select
                className="data-source-select"
                options={['sqlite', 'postgres']}
                placeholder="Choose a source"
                setValue={setValue}
                size="sm"
                value="sqlite"
            />
        )

        expect(html).toContain('<select')
        expect(html).toContain('data-source-select')
        expect(html).toContain('ob-size-sm')
        expect(html).toContain('!pr-6.5')
        expect(html).toContain('Choose a source')
        expect(html).toContain('value="sqlite"')
        expect(html).toContain('>sqlite</option>')
        expect(html).toContain('>postgres</option>')
        expect(setValue).not.toHaveBeenCalled()
    })
})
