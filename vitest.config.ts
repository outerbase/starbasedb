import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        coverage: {
            provider: 'istanbul',
            reporter: ['text', 'html', 'json', 'lcov', 'json-summary'], // Ensure json-summary is included
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
