import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, it } from 'vitest'

import { Avatar } from './avatar'
import { Card } from './card'
import { Input } from './input/Input'
import { Label } from './label/Label'
import { Loader } from './loader/Loader'
import { Toggle } from './toggle'

describe('interface primitive components', () => {
    it('renders avatar links with fallback initials and custom classes', () => {
        const html = renderToString(
            <Avatar as="a" href="/profile" username="outerbase" class="extra" />
        )

        expect(html).toContain('<a')
        expect(html).toContain('href="/profile"')
        expect(html).toContain('extra')
        expect(html).toContain('>O</p>')
    })

    it('renders avatar images with accessible alt text and selected state', () => {
        const html = renderToString(
            <Avatar
                image="/avatar.png"
                toggled
                username="Ada"
                data-testid="avatar"
            />
        )

        expect(html).toContain('<button')
        expect(html).toContain('after:opacity-100')
        expect(html).toContain('src="/avatar.png"')
        expect(html).toContain('alt="Ada"')
        expect(html).toContain('data-testid="avatar"')
    })

    it('renders cards as links or divs with variant classes', () => {
        const link = renderToString(
            <Card as="a" href="/docs" variant="primary">
                Docs
            </Card>
        )
        const panel = renderToString(
            <Card variant="secondary" data-testid="card">
                Panel
            </Card>
        )

        expect(link).toContain('<a')
        expect(link).toContain('href="/docs"')
        expect(link).toContain('btn-primary')
        expect(link).toContain('Docs')

        expect(panel).toContain('<div')
        expect(panel).toContain('btn-secondary')
        expect(panel).toContain('data-testid="card"')
    })

    it('renders labels with validation messaging only when invalid', () => {
        const invalid = renderToString(
            <Label
                title="Database"
                required
                requiredDescription="Required"
                isValid={false}
            >
                <input />
            </Label>
        )
        const valid = renderToString(
            <Label
                title="Database"
                required
                requiredDescription="Required"
                isValid
            />
        )

        expect(invalid).toContain('Database')
        expect(invalid).toContain('*')
        expect(invalid).toContain('Required')
        expect(valid).not.toContain('Required')
    })

    it('renders loader and toggle sizing/state classes', () => {
        const loader = renderToString(<Loader size={18} class="spin" />)
        const toggle = renderToString(
            <Toggle onClick={() => undefined} size="lg" toggled />
        )

        expect(loader).toContain('class="spin"')
        expect(loader).toContain('style="height: 18px; width: 18px"')
        expect(toggle).toContain('h-7.5 w-12.5')
        expect(toggle).toContain('translate-x-full')
    })

    it('renders input wrappers with prefix, suffix, and invalid state', () => {
        const wrapped = renderToString(
            <Input
                initialValue="abc"
                isValid={false}
                onValueChange={() => undefined}
                placeholder="Filter"
                preText="$"
                postText="USD"
                size="sm"
            />
        )
        const plain = renderToString(
            <Input
                className="extra-input"
                initialValue="plain"
                onValueChange={() => undefined}
                size="lg"
            />
        )

        expect(wrapped).toContain('<div')
        expect(wrapped).toContain('ob-size-sm')
        expect(wrapped).toContain('>$</span>')
        expect(wrapped).toContain('>USD</span>')
        expect(wrapped).toContain('placeholder="Filter"')
        expect(wrapped).toContain('text-ob-destructive')

        expect(plain).toContain('<input')
        expect(plain).toContain('extra-input')
        expect(plain).toContain('ob-size-lg')
        expect(plain).toContain('value="plain"')
    })
})
