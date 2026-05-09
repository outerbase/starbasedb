

import { DataReplicatorPlugin } from './index'
import { DataSource, ExternalDatabaseSource } from '../../src/types'

describe('DataReplicatorPlugin', () => {
    let plugin: DataReplicatorPlugin

    beforeEach(() => {
        plugin = new DataReplicatorPlugin()
    })

    it('should initialize with default configuration', () => {
        expect(plugin).toBeDefined()
    })

    it('should start and stop replication', () => {
        // Mock the data source
        const mockDataSource = {
            rpc: {
                query: jest.fn().mockResolvedValue([])
            }
        }

        // This is a simplified test - in a real test, we'd need to properly mock
        // the plugin's internal state and methods
        plugin['dataSource'] = mockDataSource as any

        // Start replication
        plugin.startReplication()
        expect(plugin['isRunning']).toBe(true)

        // Stop replication
        plugin.stopReplication()
        expect(plugin['isRunning']).toBe(false)
    })

    it('should handle different database dialects for table listing', async () => {
        const postgresqlSource: ExternalDatabaseSource = {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'user',
            password: 'pass',
            database: 'db',
            defaultSchema: 'public'
        }

        const tables = await plugin['getTablesToReplicate'](postgresqlSource)
        expect(tables).toEqual([])
    })
})

