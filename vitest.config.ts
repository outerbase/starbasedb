import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
    assetsInclude: ['**/*.sql'],
    resolve: {
        alias: {
            'cloudflare:workers': path.resolve(
                __dirname,
                './src/mocks/cloudflare-workers.ts'
            ),
        },
    },
    test: {
        coverage: {
            provider: 'istanbul',
            reporter: ['text', 'html', 'json', 'json-summary', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['**/node_modules/**', 'src/mocks/**', '**/*.test.ts'],
            reportOnFailure: true, // Ensures the report is generated even if tests fail
            thresholds: {
                lines: 75,
                branches: 75,
                functions: 75,
                statements: 75,
            },
        },
    },
})
