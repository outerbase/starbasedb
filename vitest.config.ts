import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        coverage: {
            reporter: ['text', 'json', 'html'],
            include: ['src/**/*.{ts,js}'], // Adjust based on your source files
        },
    },
})
