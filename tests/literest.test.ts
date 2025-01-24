import { describe, it, expect } from 'vitest'
import { LiteREST } from '../src/literest' // Adjust the import based on your structure

describe('LiteREST', () => {
    let liteREST: LiteREST

    beforeEach(() => {
        const dataSource = {} // Mock your data source
        const config = {} // Mock your configuration
        liteREST = new LiteREST(dataSource, config)
    })

    it('should fetch data for a valid table name', async () => {
        const response = await liteREST.fetchData('valid_table_name')
        expect(response).toBeDefined()
        expect(response).toHaveProperty('data') // Adjust based on expected structure
    })

    it('should handle invalid table name gracefully', async () => {
        await expect(liteREST.fetchData('invalid_table_name')).rejects.toThrow(
            'Table not found'
        )
    })
})
