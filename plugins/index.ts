// plugins/data-replicator/index.ts
// The core logic for the data replication plugin.

import { D1Database, D1Result } from '@cloudflare/workers-types';

// Define a standard interface for our data sources
interface DataSource {
    query(sql: string): Promise<any[]>;
}

// Placeholder for a PostgreSQL data source connector
class PostgresDataSource implements DataSource {
    private connectionString: string;

    constructor(connectionString: string) {
        this.connectionString = connectionString;
        // In a real implementation, we would initialize a pg client here.
        console.log(`PostgresDataSource initialized for: ${this.connectionString.substring(0, 40)}...`);
    }

    async query(sql: string): Promise<any[]> {
        // This is a mock implementation for the bounty.
        // A real implementation would execute the query against the Postgres DB using a library like 'pg'.
        console.log(`Executing query on Postgres: ${sql}`);
        if (sql.includes('SELECT MAX(id)')) {
            return [{ max: 100 }];
        }
        return [
            { id: 101, name: 'new_item_1', created_at: new Date().toISOString() },
            { id: 102, name: 'new_item_2', created_at: new Date().toISOString() },
        ];
    }
}

// Configuration for a single replication job
interface ReplicationConfig {
    sourceConnectionString: string;
    tableName: string;
    incrementalKey: string; // e.g., 'id' or 'created_at'
}

// The main replication logic for a single table
async function replicateTable(config: ReplicationConfig, internalDb: D1Database): Promise<void> {
    console.log(`Starting replication for table: ${config.tableName}`);

    const sourceDb = new PostgresDataSource(config.sourceConnectionString);

    // 1. Find the last synced value from the internal SQLite DB
    const lastSyncedValueQuery = `SELECT MAX(${config.incrementalKey}) as lastValue FROM ${config.tableName}`;
    let lastValue = 0;
    try {
        const lastSyncedResult: D1Result = await internalDb.prepare(lastSyncedValueQuery).run();
        if (lastSyncedResult.results && lastSyncedResult.results.length > 0) {
            lastValue = (lastSyncedResult.results[0]?.lastValue as number) || 0;
        }
    } catch (e) {
        console.warn(`Could not determine last synced value for ${config.tableName}. Assuming from scratch. Error: ${e}`);
    }
    console.log(`Last synced value for ${config.incrementalKey}: ${lastValue}`);

    // 2. Query the external source for new data
    const newDataQuery = `SELECT * FROM ${config.tableName} WHERE ${config.incrementalKey} > ${lastValue} ORDER BY ${config.incrementalKey} ASC;`;
    const newData = await sourceDb.query(newDataQuery);

    if (newData.length === 0) {
        console.log(`No new data found for table: ${config.tableName}`);
        return;
    }

    console.log(`Found ${newData.length} new records to insert.`);

    // 3. Insert new data into the internal SQLite DB using bulk insert
    const columns = Object.keys(newData[0]);
    const placeholders = columns.map(() => '?').join(', ');
    const insertStatement = `INSERT INTO ${config.tableName} (${columns.join(', ')}) VALUES (${placeholders});`;
    
    const stmt = internalDb.prepare(insertStatement);
    const batch = newData.map(row => stmt.bind(...Object.values(row)));
    await internalDb.batch(batch);
    
    console.log(`Successfully inserted ${newData.length} records into ${config.tableName}.`);
}

// The plugin's main entry point, triggered by a cron
export default {
    async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        console.log("Running Data Replication Cron Job...");

        // This config would ideally come from a config file or DB table
        const jobConfig: ReplicationConfig = {
            sourceConnectionString: env.EXTERNAL_DB_URL,
            tableName: 'users', // Example table
            incrementalKey: 'id'
        };

        try {
            await replicateTable(jobConfig, env.DB);
        } catch (error) {
            console.error(`Replication failed for table ${jobConfig.tableName}:`, error);
        }
    },
};

interface Env {
    DB: D1Database;
    EXTERNAL_DB_URL: string;
}
