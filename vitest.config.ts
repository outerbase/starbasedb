import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        coverage: {
            provider: 'istanbul',
            reporter: ['text', 'html', 'json', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['**/node_modules/**'],
            reportOnFailure: true,
            thresholds: {
                lines: 60,
                branches: 60,
                functions: 60,
                statements: 60,
            },
        },
    },
})
