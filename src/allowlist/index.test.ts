import { describe, it, expect } from 'vitest'

export function isTableAllowed(tableName: string, allowlist?: string[], blocklist?: string[]): boolean {
    if (!tableName || tableName.startsWith('sqlite_') || tableName.startsWith('_cf_')) {
        return false
    }
    if (blocklist && blocklist.includes(tableName)) {
        return false
    }
    if (allowlist && allowlist.length > 0) {
        return allowlist.includes(tableName)
    }
    return true
}

describe('Table Allowlist & System Table Guard (#71)', () => {
    it('blocks internal sqlite_ and _cf_ tables', () => {
        expect(isTableAllowed('sqlite_master')).toBe(false)
        expect(isTableAllowed('_cf_KV')).toBe(false)
    })

    it('enforces explicit allowlist and blocklist rules', () => {
        expect(isTableAllowed('users', ['users', 'posts'])).toBe(true)
        expect(isTableAllowed('secrets', ['users', 'posts'])).toBe(false)
        expect(isTableAllowed('users', ['users'], ['users'])).toBe(false)
    })
})
