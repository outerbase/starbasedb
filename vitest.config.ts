import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        coverage: {
            provider: 'istanbul',
            reporter: ['text', 'html', 'json', 'lcov'],
            include: ['src/**/*.ts'],
            exclude: ['**/node_modules/**'],
        },
    },
})
