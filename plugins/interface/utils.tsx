import type { JSX } from 'hono/jsx'

/**
 * Helper function that reads the Vite manifest and returns the import tags for
 * the JS/CSS assets processed by Vite.
 * Setting `build.manifest` to `true` in the Vite config is required for this.
 */
export async function getAssetImportTagsFromManifest() {
    const rootManifest = await import('../../public/.vite/manifest.json')

    const manifest = rootManifest.default
    if (!manifest) {
        return null
    }

    const importTags: Array<
        JSX.IntrinsicElements['link'] | JSX.IntrinsicElements['script']
    > = []

    for (const entry of Object.values(manifest)) {
        // Skip creating script tags for CSS files
        if (!entry.file.endsWith('.css')) {
            const scriptTag = (
                <script key={entry.file} type="module" src={entry.file} />
            )
            importTags.push(scriptTag)
        }

        if (
            'css' in entry &&
            Array.isArray(entry.css) &&
            entry.css.length > 0
        ) {
            const cssTags = entry.css.map((cssPath) => (
                <link key={cssPath} rel="stylesheet" href={cssPath} />
            ))
            importTags.push(cssTags)
        }
    }

    return importTags
}
