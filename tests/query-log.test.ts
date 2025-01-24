import { describe, it, expect } from 'vitest'
import { QueryLogPlugin } from '../plugins/query-log'

describe('QueryLogPlugin', () => {
    let queryLogPlugin: QueryLogPlugin

    beforeEach(() => {
        queryLogPlugin = new QueryLogPlugin()
    })

    it('should log queries correctly', () => {
        const result = queryLogPlugin.logQuery('SELECT * FROM users')
        expect(result).toBe(true) // Expect the method to return true
    })

    it('should handle errors gracefully', () => {
        expect(() => queryLogPlugin.logQuery(null)).toThrow('Invalid query')
    })
})
