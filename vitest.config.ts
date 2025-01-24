import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        coverage: {
            provider: 'istanbul', // or ""
            reporter: ['text', 'html', 'json', 'lcov'],
        },
    },
})
