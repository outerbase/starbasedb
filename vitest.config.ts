import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
    assetsInclude: ['**/*.sql'],
    resolve: {
        alias: {
            // Allow plugins that import the built package entry (e.g. `../../dist`)
            // to be unit tested directly against the TypeScript sources.
            [resolve(__dirname, 'dist')]: resolve(__dirname, 'src/index.ts'),
        },
    },
    test: {
        coverage: {
            provider: 'istanbul',
            reporter: ['text', 'html', 'json', 'json-summary', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['**/node_modules/**'],
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
