import { describe, expect, it } from 'vitest'
import { cn, getAssetImportTagsFromManifest } from './index'

describe('cn', () => {
    it('combines conditional classes and resolves Tailwind conflicts', () => {
        const result = cn(
            'flex px-2 text-sm',
            false && 'hidden',
            ['items-center'],
            { 'text-ob-base-300': true, hidden: false },
            'px-4'
        )

        expect(result).toContain('flex')
        expect(result).toContain('items-center')
        expect(result).toContain('text-sm')
        expect(result).toContain('text-ob-base-300')
        expect(result).toContain('px-4')
        expect(result).not.toContain('hidden')
        expect(result).not.toContain('px-2')
    })
})

describe('getAssetImportTagsFromManifest', () => {
    it('returns script and stylesheet tags for the current page and shared chunks', async () => {
        const tags = (await getAssetImportTagsFromManifest('template')) as any[]

        expect(tags).toHaveLength(4)
        expect(tags.map((tag) => tag.props.src ?? tag.props.href)).toEqual([
            '/assets/components.Dd6m7Hsm.js',
            '/assets/vendor.DLA8GOwG.js',
            '/assets/template.Cbhlkt6E.js',
            '/assets/template.BByNnpth.css',
        ])
        expect(tags.map((tag) => tag.props.type ?? tag.props.rel)).toEqual([
            'module',
            'module',
            'module',
            'stylesheet',
        ])
    })
})
