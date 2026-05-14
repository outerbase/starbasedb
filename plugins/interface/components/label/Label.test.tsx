import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it } from 'vitest'
import { Label } from './Label'

describe('Label', () => {
    it('renders title and children', () => {
        const html = renderToString(
            <Label className="custom-label" title="Database">
                <input name="database" />
            </Label>
        )

        expect(html).toContain('<label')
        expect(html).toContain('custom-label')
        expect(html).toContain('Database')
        expect(html).toContain('name="database"')
    })

    it('renders required validation text when invalid', () => {
        const html = renderToString(
            <Label
                isValid={false}
                required
                requiredDescription="required"
                title="Name"
            />
        )

        expect(html).toContain('Name')
        expect(html).toContain('*')
        expect(html).toContain('required')
        expect(html).toContain('text-ob-destructive')
    })
})
