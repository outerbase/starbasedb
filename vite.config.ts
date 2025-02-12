import build from '@hono/vite-build/cloudflare-workers'
import devServer from '@hono/vite-dev-server'
import cloudflareAdapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
    if (mode === 'client') {
        // return {
        //     build: {
        //         rollupOptions: {
        //         input: "./plugins/interface/client/index.tsx",
        //         output: {
        //             entryFileNames: "assets/[name]-[hash].js",
        //         },
        //         },
        //         outDir: "./public",
        //         copyPublicDir: true,
        //         emptyOutDir: true,
        //         manifest: true,
        //     },
        //     publicDir: "./plugins/interface/public"
        // };
        return {
            build: {
                rollupOptions: {
                    input: {
                        main: './plugins/interface/client/index.tsx',
                        admin: './plugins/interface/client/index2.tsx',
                    },
                    output: {
                        entryFileNames: 'assets/[name]-[hash].js',
                    },
                },
                outDir: './public',
                copyPublicDir: true,
                emptyOutDir: true,
                manifest: true,
            },
            publicDir: './plugins/interface/public',
        }
    }

    const entry = './src/index.ts'
    return {
        server: { port: 8787 },
        plugins: [
            devServer({ adapter: cloudflareAdapter, entry }),
            build({ entry }),
        ],
        build: {
            rollupOptions: {
                external: ['cloudflare:workers'],
            },
        },
    }
})
