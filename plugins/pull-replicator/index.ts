import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'

const SQL = {
	CREATE_REPLICATION_JOBS: `
		CREATE TABLE IF NOT EXISTS tmp_replication_jobs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			source_name TEXT NOT NULL,
			table_name TEXT NOT NULL,
			cursor_column TEXT DEFAULT 'updated_at',
			last_cursor_value TEXT,
			status TEXT NOT NULL DEFAULT 'idle',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`,
	CREATE_REPLICATION_RUNS: `
		CREATE TABLE IF NOT EXISTS tmp_replication_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			job_id INTEGER NOT NULL,
			rows_synced INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			error_message TEXT,
			started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			finished_at DATETIME,
			FOREIGN KEY(job_id) REFERENCES tmp_replication_jobs(id)
		)
	`,
}

export class PullReplicatorPlugin extends StarbasePlugin {
	private dataSource?: DataSource

	constructor() {
		super('starbasedb:pull-replicator')
	}

	override async register(app: StarbaseApp) {
		app.use(async (c, next) => {
			this.dataSource = c?.get('dataSource')
			await this.ensureTables(this.dataSource)
			await next()
		})

		app.get('/api/plugins/pull-replicator/health', (c) => {
			return c.json({
				ok: true,
				plugin: this.name,
				hasDataSource: !!this.dataSource,
			})
		})
	}

	private async ensureTables(dataSource?: DataSource) {
		if (!dataSource) return
		await dataSource.rpc.executeQuery({ sql: SQL.CREATE_REPLICATION_JOBS, params: [] })
		await dataSource.rpc.executeQuery({ sql: SQL.CREATE_REPLICATION_RUNS, params: [] })
	}
}
