import path from 'node:path'
import { describe, expect, it } from 'vitest'

import viteConfig from './vite.config'

type ViteConfigFactory = (env: {
    mode: string
    command: 'build' | 'serve'
}) => unknown

async function resolveConfig(
    mode: string,
    command: 'build' | 'serve' = 'build'
) {
    const config = (viteConfig as ViteConfigFactory)({ mode, command })
    return (await Promise.resolve(config)) as Record<string, any>
}

describe('vite config', () => {
    it('discovers interface pages and keeps the client build output stable', async () => {
        const config = await resolveConfig('client')

        expect(config.build?.rollupOptions?.input).toEqual({
            template: path.join(
                'plugins',
                'interface',
                'pages',
                'template',
                'index.tsx'
            ),
        })
        expect(config.build?.outDir).toBe('./public')
        expect(config.build?.copyPublicDir).toBe(true)
        expect(config.build?.emptyOutDir).toBe(false)
        expect(config.build?.manifest).toBe(true)
        expect(config.publicDir).toBe('./plugins/interface/public')
        expect(config.resolve?.alias?.['@interface']).toBe(
            path.resolve(process.cwd(), './plugins/interface')
        )

        const output = config.build?.rollupOptions?.output
        expect(output.entryFileNames).toBe('assets/[name].[hash].js')
        expect(output.chunkFileNames).toBe('assets/[name].[hash].js')
        expect(output.assetFileNames).toBe('assets/[name].[hash][extname]')
        expect(output.manualChunks.vendor).toEqual([
            'hono/jsx',
            'hono/jsx/dom/client',
        ])
        expect(output.manualChunks.components).toEqual(
            expect.arrayContaining([
                './plugins/interface/components/button/Button',
                './plugins/interface/components/input/Input',
                './plugins/interface/components/card',
                './plugins/interface/components/avatar',
            ])
        )
    })

    it('keeps the worker build pointed at the Cloudflare entrypoint', async () => {
        const config = await resolveConfig('development', 'serve')

        expect(config.assetsInclude).toEqual(['**/*.sql'])
        expect(config.server).toMatchObject({ port: 8787 })
        expect(config.build?.rollupOptions?.external).toEqual([
            'cloudflare:workers',
        ])

        const pluginNames = config.plugins
            .map((plugin: { name?: string } | null | undefined) => plugin?.name)
            .filter(Boolean)

        expect(pluginNames).toEqual(
            expect.arrayContaining([
                '@hono/vite-dev-server',
                '@hono/vite-build/cloudflare-workers',
            ])
        )
    })
})
