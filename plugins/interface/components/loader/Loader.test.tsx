import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it } from 'vitest'
import { Loader } from './Loader'

describe('Loader', () => {
    it('renders an animated svg loader with custom size and class', () => {
        const html = renderToString(<Loader class="custom-loader" size={16} />)

        expect(html).toContain('<svg')
        expect(html).toContain('custom-loader')
        expect(html).toContain('height: 16px; width: 16px')
        expect(html).toContain('animateTransform')
        expect(html).toContain('repeatCount="indefinite"')
    })
})
