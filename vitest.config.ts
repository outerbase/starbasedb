import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        coverage: {
            provider: 'istanbul',
            reporter: ['text', 'html', 'json', 'json-summary', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['**/node_modules/**'],
            thresholds: {
                lines: 60,
                functions: 60,
                branches: 60,
                statements: 60,
            },
        },
    },
})
