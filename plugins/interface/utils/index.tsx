import type { JSX } from 'hono/jsx'
import { ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]) => {
    return twMerge(clsx(inputs))
}

/**
 * Helper function that reads the Vite manifest and returns the import tags for
 * the JS/CSS assets processed by Vite.
 * Setting `build.manifest` to `true` in the Vite config is required for this.
 */
export async function getAssetImportTagsFromManifest(currentPage?: string) {
    let manifest
    try {
        const rootManifest = await import('../../../public/.vite/manifest.json')
        manifest = rootManifest.default
    } catch (error) {
        // If manifest file doesn't exist, return null
        return null
    }

    if (!manifest) return null

    const importTags: Array<
        JSX.IntrinsicElements['link'] | JSX.IntrinsicElements['script']
    > = []

    // Always include global CSS if it exists
    const globalCssEntry = Object.values(manifest).find((entry) =>
        entry.file.includes('global')
    )
    if (globalCssEntry?.file) {
        importTags.push(
            <link
                key={globalCssEntry.file}
                rel="stylesheet"
                href={`/${globalCssEntry.file}`}
            />
        )
    }

    // Include only current page JS and shared chunks
    for (const [key, entry] of Object.entries(manifest)) {
        // Debug each entry evaluation
        const isCurrentPage =
            currentPage && entry.file.includes(`${currentPage}.`)
        const isSharedChunk =
            entry.file.includes('vendor.') || entry.file.includes('components.')

        if (!entry.file.endsWith('.css') && (isCurrentPage || isSharedChunk)) {
            const scriptTag = (
                <script key={entry.file} type="module" src={`/${entry.file}`} />
            )
            importTags.push(scriptTag)
        }

        // Include any additional CSS files
        if ('css' in entry && Array.isArray(entry.css)) {
            entry.css.forEach((cssPath) => {
                if (!cssPath.includes('global')) {
                    importTags.push(
                        <link
                            key={cssPath}
                            rel="stylesheet"
                            href={`/${cssPath}`}
                        />
                    )
                }
            })
        }
    }

    return importTags
}
