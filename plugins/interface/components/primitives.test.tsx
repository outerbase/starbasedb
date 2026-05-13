import { describe, expect, it } from 'vitest'
import { renderToString } from 'hono/jsx/dom/server'
import { Avatar } from './avatar'
import { Card } from './card'
import { Input } from './input/Input'
import { Label } from './label/Label'
import { Loader } from './loader/Loader'
import { Toggle } from './toggle'
import { cn, getAssetImportTagsFromManifest } from '../utils'

describe('interface primitives', () => {
    it('merges Tailwind utility classes predictably', () => {
        expect(cn('px-2 text-sm', false && 'hidden', 'px-4')).toBe(
            'text-sm px-4'
        )
    })

    it('renders avatar initials and image variants', () => {
        const initialAvatar = renderToString(
            <Avatar username="outerbase" size="sm" toggled />
        )
        expect(initialAvatar).toContain('<button')
        expect(initialAvatar).toContain('ob-size-sm')
        expect(initialAvatar).toContain('toggle')
        expect(initialAvatar).toContain('>O</p>')

        const imageAvatar = renderToString(
            <Avatar
                as="a"
                href="/account"
                image="/avatar.png"
                username="Ada Lovelace"
                size="lg"
                toggled
                class="profile-avatar"
            />
        )
        expect(imageAvatar).toContain('<a href="/account"')
        expect(imageAvatar).toContain('ob-size-lg')
        expect(imageAvatar).toContain('profile-avatar')
        expect(imageAvatar).toContain('src="/avatar.png"')
        expect(imageAvatar).toContain('alt="Ada Lovelace"')
        expect(imageAvatar).toContain('height="36"')
    })

    it('renders card element variants without dropping attributes', () => {
        const card = renderToString(
            <Card className="custom-card" data-testid="summary">
                Summary
            </Card>
        )
        expect(card).toContain('<div')
        expect(card).toContain('btn-secondary')
        expect(card).toContain('custom-card')
        expect(card).toContain('data-testid="summary"')
        expect(card).toContain('>Summary</div>')

        const linkCard = renderToString(
            <Card as="a" href="/settings" variant="primary">
                Settings
            </Card>
        )
        expect(linkCard).toContain('<a href="/settings"')
        expect(linkCard).toContain('btn-primary')
        expect(linkCard).toContain('>Settings</a>')
    })

    it('renders labels with conditional required copy', () => {
        const invalidLabel = renderToString(
            <Label
                title="API key"
                required
                requiredDescription="required"
                isValid={false}
                className="field-label"
            >
                <input name="apiKey" />
            </Label>
        )
        expect(invalidLabel).toContain('<label')
        expect(invalidLabel).toContain('field-label')
        expect(invalidLabel).toContain('API key')
        expect(invalidLabel).toContain('required')
        expect(invalidLabel).toContain('name="apiKey"')

        const validLabel = renderToString(
            <Label title="Name" required requiredDescription="required" isValid>
                <input name="name" />
            </Label>
        )
        expect(validLabel).not.toContain('text-ob-destructive')
    })

    it('renders loader sizing through inline styles', () => {
        const loader = renderToString(<Loader class="saving" size={32} />)
        expect(loader).toContain('<svg')
        expect(loader).toContain('class="saving"')
        expect(loader).toContain('style="height: 32px; width: 32px"')
        expect(loader).toContain('<animateTransform')
        expect(loader).toContain('repeatCount="indefinite"')
    })

    it('renders toggle size and toggled classes', () => {
        const toggle = renderToString(
            <Toggle onClick={() => undefined} size="lg" toggled />
        )
        expect(toggle).toContain('<button')
        expect(toggle).toContain('h-7.5 w-12.5')
        expect(toggle).toContain('dark:bg-neutral-500')
        expect(toggle).toContain('translate-x-full')

        const offToggle = renderToString(
            <Toggle onClick={() => undefined} size="sm" toggled={false} />
        )
        expect(offToggle).toContain('h-5.5 w-8.5')
        expect(offToggle).not.toContain('translate-x-full')
    })

    it('renders input standalone and decorated variants', () => {
        const plainInput = renderToString(
            <Input
                name="plain"
                initialValue="hello"
                isValid={false}
                onValueChange={undefined}
                size="lg"
                className="plain-input"
            />
        )
        expect(plainInput).toContain('<input')
        expect(plainInput).toContain('name="plain"')
        expect(plainInput).toContain('value="hello"')
        expect(plainInput).toContain('text-ob-destructive')
        expect(plainInput).toContain('ob-size-lg')
        expect(plainInput).toContain('plain-input')

        const decoratedInput = renderToString(
            <Input
                name="amount"
                initialValue="42"
                onValueChange={undefined}
                preText="$"
                postText="USD"
                size="sm"
            />
        )
        expect(decoratedInput).toContain('<div')
        expect(decoratedInput).toContain('ob-size-sm')
        expect(decoratedInput).toContain('>$</span>')
        expect(decoratedInput).toContain('value="42"')
        expect(decoratedInput).toContain('>USD</span>')
    })

    it('builds manifest import tags for a requested page', async () => {
        const tags = await getAssetImportTagsFromManifest('template')
        const html = renderToString(<>{tags}</>)

        expect(html).toContain('src="/assets/template.')
        expect(html).toContain('src="/assets/vendor.')
        expect(html).toContain('src="/assets/components.')
        expect(html).toContain('href="/assets/template.')
        expect(html).toContain('.css"')
        expect(html).not.toContain('global')
    })
})
