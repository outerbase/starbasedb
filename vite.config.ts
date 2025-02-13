import build from '@hono/vite-build/cloudflare-workers'
import devServer from '@hono/vite-dev-server'
import cloudflareAdapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'

// Helper function to get page entries
function getPageEntries() {
    const pagesDir = './plugins/interface/pages'
    const entries: Record<string, string> = {}

    // Check if directory exists
    if (fs.existsSync(pagesDir)) {
        const folders = fs
            .readdirSync(pagesDir, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())

        folders.forEach((folder) => {
            const indexPath = path.join(pagesDir, folder.name, 'index.tsx')
            if (fs.existsSync(indexPath)) {
                entries[folder.name] = indexPath
            }
        })
    }

    return entries
}

export default defineConfig(({ mode }) => {
    if (mode === 'client') {
        return {
            build: {
                rollupOptions: {
                    input: getPageEntries(),
                    output: {
                        entryFileNames: 'assets/[name]-[hash].js',
                    },
                },
                outDir: './public',
                copyPublicDir: true,
                emptyOutDir: true,
                manifest: true,
            },
            plugins: [tailwindcss()],
            publicDir: './plugins/interface/public',
        }
    }

    const entry = './src/index.ts'
    return {
        server: { port: 8787 },
        plugins: [
            devServer({ adapter: cloudflareAdapter, entry }),
            build({ entry }),
            tailwindcss(),
        ],
        build: {
            rollupOptions: {
                external: ['cloudflare:workers'],
            },
        },
    }
})
