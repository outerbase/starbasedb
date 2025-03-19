import { PluginContext, Plugin } from '../index'
import DataSyncPlugin from '../index'

// This is a demo script to test the Data Sync plugin functionality
async function runDemo() {
    console.log('Starting Data Sync Plugin Demo')

    // Create a mock plugin context
    const mockContext: PluginContext = {
        env: {
            EXTERNAL_DB_TYPE: 'postgresql',
            EXTERNAL_DB_HOST: 'localhost',
            EXTERNAL_DB_PORT: '5432',
            EXTERNAL_DB_USER: 'postgres',
            EXTERNAL_DB_PASS: 'postgres',
            EXTERNAL_DB_DATABASE: 'demo',
            EXTERNAL_DB_DEFAULT_SCHEMA: 'public',
        },
        config: {
            sync_interval: 5,
            tables: ['users', 'products'],
            batch_size: 100,
            track_column: 'created_at',
            enabled: true,
        },
        internalDb: {
            executeQuery: async (query: {
                sql: string
                params?: unknown[]
                isRaw?: boolean
            }) => {
                console.log(
                    `[SQLite] Executing: ${query.sql}, Params: ${JSON.stringify(query.params)}`
                )
                return Promise.resolve([])
            },
            getAlarm: async () => Promise.resolve(null),
            setAlarm: async (scheduledTime: number | Date, options?: any) =>
                Promise.resolve(),
            deleteAlarm: async () => Promise.resolve(),
        },
        externalDb: {
            executeQuery: async (query: {
                sql: string
                params?: unknown[]
                isRaw?: boolean
            }) => {
                console.log(
                    `[PostgreSQL] Query: ${query.sql}, Params: ${JSON.stringify(query.params)}`
                )

                if (query.sql.includes('information_schema.tables')) {
                    return [
                        { table_name: 'users' },
                        { table_name: 'products' },
                        { table_name: 'orders' },
                    ]
                } else if (query.sql.includes('information_schema.columns')) {
                    if (query.params?.[1] === 'users') {
                        return [
                            {
                                name: 'id',
                                type: 'integer',
                                nullable: 'NO',
                                default_value:
                                    "nextval('users_id_seq'::regclass)",
                            },
                            {
                                name: 'name',
                                type: 'character varying',
                                nullable: 'NO',
                                default_value: null,
                            },
                            {
                                name: 'email',
                                type: 'character varying',
                                nullable: 'NO',
                                default_value: null,
                            },
                            {
                                name: 'created_at',
                                type: 'timestamp with time zone',
                                nullable: 'NO',
                                default_value: 'now()',
                            },
                        ]
                    } else if (query.params?.[1] === 'products') {
                        return [
                            {
                                name: 'id',
                                type: 'integer',
                                nullable: 'NO',
                                default_value:
                                    "nextval('products_id_seq'::regclass)",
                            },
                            {
                                name: 'name',
                                type: 'character varying',
                                nullable: 'NO',
                                default_value: null,
                            },
                            {
                                name: 'price',
                                type: 'numeric',
                                nullable: 'NO',
                                default_value: null,
                            },
                            {
                                name: 'created_at',
                                type: 'timestamp with time zone',
                                nullable: 'NO',
                                default_value: 'now()',
                            },
                        ]
                    }
                } else if (query.sql.includes('SELECT * FROM')) {
                    if (query.sql.includes('users')) {
                        return [
                            {
                                id: 1,
                                name: 'John Doe',
                                email: 'john@example.com',
                                created_at: '2023-01-01T00:00:00Z',
                            },
                            {
                                id: 2,
                                name: 'Jane Smith',
                                email: 'jane@example.com',
                                created_at: '2023-01-02T00:00:00Z',
                            },
                        ]
                    } else if (query.sql.includes('products')) {
                        return [
                            {
                                id: 1,
                                name: 'Product 1',
                                price: 19.99,
                                created_at: '2023-01-01T00:00:00Z',
                            },
                            {
                                id: 2,
                                name: 'Product 2',
                                price: 29.99,
                                created_at: '2023-01-02T00:00:00Z',
                            },
                        ]
                    }
                }

                return []
            },
        },
    }

    // Create and initialize the plugin
    const plugin = new DataSyncPlugin()
    await plugin.initialize(mockContext)

    // Wait for initial sync to complete
    console.log('Waiting for initial sync to complete...')
    await new Promise((resolve) => setTimeout(resolve, 2000))

    // Get sync status
    const status = await plugin.getSyncStatus()
    console.log('Sync Status:', JSON.stringify(status, null, 2))

    // Trigger manual sync
    console.log('Triggering manual sync...')
    await plugin.triggerSync()

    // Reset sync state for a specific table
    console.log('Resetting sync state for users table...')
    await plugin.resetSyncState('users')

    // Shutdown the plugin
    console.log('Shutting down plugin...')
    await plugin.shutdown()

    console.log('Demo completed')
}

// Run the demo
runDemo().catch((err) => {
    console.error('Demo failed:', err)
})
