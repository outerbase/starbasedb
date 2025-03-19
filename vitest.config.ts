import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
    assetsInclude: ['**/*.sql'],
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
        include: ['./plugins/data_sync/**/*.test.ts'],
        environment: 'node',
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
})
