import { describe, expect, it } from 'vitest'
import manifest from '../../../public/.vite/manifest.json'
import { cn, getAssetImportTagsFromManifest } from './index'

type RenderableTag = {
    toString(): string | Promise<string>
}

type ManifestEntry = (typeof manifest)[keyof typeof manifest]

async function renderTags(
    tags: Awaited<ReturnType<typeof getAssetImportTagsFromManifest>>
) {
    if (!tags) return null

    return Promise.all(
        tags.map((tag) =>
            Promise.resolve((tag as unknown as RenderableTag).toString())
        )
    )
}

const manifestEntries = Object.values(manifest) as ManifestEntry[]
const sharedEntries = manifestEntries.filter(
    (entry) =>
        entry.file.includes('vendor.') || entry.file.includes('components.')
)
const additionalCss = manifestEntries.flatMap((entry) => {
    if (!('css' in entry) || !Array.isArray(entry.css)) return []
    return entry.css.filter((cssPath) => !cssPath.includes('global'))
})
const globalCssEntry = manifestEntries.find((entry) =>
    entry.file.includes('global')
)
const templateEntry = manifestEntries.find((entry) =>
    entry.file.includes('template.')
)

function expectedBaseTagCount() {
    return (
        sharedEntries.length +
        additionalCss.length +
        (globalCssEntry?.file ? 1 : 0)
    )
}

function expectSharedAssets(rendered: string[]) {
    for (const entry of sharedEntries) {
        expect(rendered).toEqual(
            expect.arrayContaining([
                expect.stringContaining(`src="/${entry.file}"`),
            ])
        )
    }

    for (const cssPath of additionalCss) {
        expect(rendered).toEqual(
            expect.arrayContaining([
                expect.stringContaining(`href="/${cssPath}"`),
            ])
        )
    }

    if (globalCssEntry?.file) {
        expect(rendered).toEqual(
            expect.arrayContaining([
                expect.stringContaining(`href="/${globalCssEntry.file}"`),
            ])
        )
    }
}

describe('interface utils - cn()', () => {
    it('combines ordinary and conditional class values', () => {
        expect(
            cn('text-sm', { 'font-bold': true, italic: false }, undefined)
        ).toBe('text-sm font-bold')
    })

    it('keeps the last conflicting Tailwind utility', () => {
        expect(cn('px-2', 'px-4', 'text-red-500', 'text-blue-500')).toBe(
            'px-4 text-blue-500'
        )
    })
})

describe('interface utils - getAssetImportTagsFromManifest()', () => {
    it('includes the current page script plus shared JS and CSS assets', async () => {
        expect(templateEntry).toBeDefined()

        const rendered = await renderTags(
            await getAssetImportTagsFromManifest('template')
        )

        expect(rendered).not.toBeNull()
        expectSharedAssets(rendered!)
        expect(rendered).toEqual(
            expect.arrayContaining([
                expect.stringContaining(`src="/${templateEntry!.file}"`),
            ])
        )
        expect(rendered).toHaveLength(expectedBaseTagCount() + 1)
    })

    it('omits an unrelated page script while retaining shared assets', async () => {
        expect(templateEntry).toBeDefined()

        const rendered = await renderTags(
            await getAssetImportTagsFromManifest('not-a-real-page')
        )

        expect(rendered).not.toBeNull()
        expectSharedAssets(rendered!)
        expect(rendered).toHaveLength(expectedBaseTagCount())
        expect(
            rendered!.some((tag) =>
                tag.includes(`src="/${templateEntry!.file}"`)
            )
        ).toBe(false)
    })

    it('includes shared assets when no current page is supplied', async () => {
        expect(templateEntry).toBeDefined()

        const rendered = await renderTags(await getAssetImportTagsFromManifest())

        expect(rendered).not.toBeNull()
        expectSharedAssets(rendered!)
        expect(rendered).toHaveLength(expectedBaseTagCount())
        expect(
            rendered!.some((tag) =>
                tag.includes(`src="/${templateEntry!.file}"`)
            )
        ).toBe(false)
    })
})
