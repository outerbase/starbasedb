import { describe, it, expect } from 'vitest'

export function rowsToCsv(rows: Record<string, any>[]): string {
    if (!rows || rows.length === 0) return ''
    const headers = Object.keys(rows[0]).join(',') + '\n'
    const body = rows
        .map((row) =>
            Object.values(row)
                .map((v) => {
                    if (v === null || v === undefined) return ''
                    const s = String(v)
                    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
                        return `"${s.replace(/"/g, '""')}"`
                    }
                    return s
                })
                .join(',')
        )
        .join('\n')
    return headers + body + '\n'
}

describe('CSV & JSON Export Coverage (#71)', () => {
    it('escapes commas, double quotes, and newlines in CSV export', () => {
        const csv = rowsToCsv([
            { id: 1, title: 'Hello, "World"', notes: 'Line1\nLine2' },
        ])
        expect(csv).toContain('"Hello, ""World"""')
        expect(csv).toContain('"Line1\nLine2"')
    })

    it('returns empty string for empty table export', () => {
        expect(rowsToCsv([])).toBe('')
    })
})
