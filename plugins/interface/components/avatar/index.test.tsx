import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it } from 'vitest'
import { Avatar } from './index'

describe('Avatar', () => {
    it('renders a button avatar with the username initial', () => {
        const html = renderToString(
            <Avatar
                class="custom-avatar"
                size="sm"
                toggled
                username="starbase"
            />
        )

        expect(html).toContain('<button')
        expect(html).toContain('custom-avatar')
        expect(html).toContain('ob-size-sm')
        expect(html).toContain('toggle')
        expect(html).toContain('>S</p>')
    })

    it('renders an anchor avatar with an image when href and image are provided', () => {
        const html = renderToString(
            <Avatar
                as="a"
                href="/profile"
                image="/avatar.png"
                size="lg"
                username="outerbase"
            />
        )

        expect(html).toContain('<a')
        expect(html).toContain('href="/profile"')
        expect(html).toContain('ob-size-lg')
        expect(html).toContain('src="/avatar.png"')
        expect(html).toContain('alt="outerbase"')
        expect(html).toContain('height="36"')
        expect(html).toContain('width="36"')
    })
})
