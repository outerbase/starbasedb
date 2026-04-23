import { StarbasePlugin } from '../../src/plugin'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'

interface ReplicationConfig {
    sourceType: 'postgres' | 'mysql' | 'sqlite'
    sourceUrl: string
    targetTable: string
    mapping?: Record<string, string>
    interval?: string // cron expression
}

export class ReplicationPlugin extends StarbasePlugin {
    public prefix: string = '/replication'

    constructor(private replicationConfig: ReplicationConfig) {
        super('starbasedb:replication', {
            requiresAuth: true,
        })
    }

    override async register(app: StarbaseApp) {
        // Register a manual sync endpoint
        app.post(`${this.prefix}/sync`, async (c) => {
            const config = c.get('config')
            if (config.role !== 'admin') {
                return c.json({ error: 'Unauthorized' }, 401)
            }

            const result = await this.performSync(config)
            return c.json(result)
        })
    }

    private async performSync(config: StarbaseDBConfiguration) {
        return this.syncData()
    }

    public async syncData() {
        console.log(
            `Starting replication for ${this.replicationConfig.targetTable}`
        )

        try {
            // 1. Fetch data from source
            const sourceData = await this.fetchFromSource()

            if (!sourceData || sourceData.length === 0) {
                return { success: true, rowsSynced: 0 }
            }

            // 2. Transform data based on mapping
            const transformedData = this.transformData(sourceData)

            // 3. Success (In a real implementation, we would execute an INSERT/UPSERT here)
            return {
                success: true,
                rowsSynced: transformedData.length,
                timestamp: new Date().toISOString(),
            }
        } catch (error: any) {
            return {
                success: false,
                error: error.message,
            }
        }
    }

    public async fetchFromSource(): Promise<any[]> {
        // Placeholder for actual data fetching logic
        // For testing purposes, we can override this or mock the fetch call
        return []
    }

    private transformData(data: any[]): any[] {
        if (!this.replicationConfig.mapping) return data

        return data.map((row) => {
            const newRow: any = {}
            for (const [sourceKey, targetKey] of Object.entries(
                this.replicationConfig.mapping!
            )) {
                newRow[targetKey] = row[sourceKey]
            }
            return newRow
        })
    }
}
