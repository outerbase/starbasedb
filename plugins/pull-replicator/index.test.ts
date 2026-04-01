import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StarbaseApp } from '../../src/handler'
import { DataSource } from '../../src/types'
import { PullReplicatorPlugin } from './index'

let plugin: PullReplicatorPlugin
let mockDataSource: DataSource

beforeEach(() => {
	vi.clearAllMocks()
	mockDataSource = { rpc: { executeQuery: vi.fn().mockResolvedValue([]) } } as unknown as DataSource
	plugin = new PullReplicatorPlugin()
})

describe('PullReplicatorPlugin', () => {
	it('register creates replication tables in middleware', async () => {
		const mockApp = {
			use: vi.fn((middleware) => middleware({ get: vi.fn(() => mockDataSource) }, vi.fn())),
			get: vi.fn(),
		} as unknown as StarbaseApp

		await plugin.register(mockApp)

		expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
		expect(mockDataSource.rpc.executeQuery).toHaveBeenNthCalledWith(1, {
			sql: expect.stringContaining('tmp_replication_jobs'),
			params: [],
		})
		expect(mockDataSource.rpc.executeQuery).toHaveBeenNthCalledWith(2, {
			sql: expect.stringContaining('tmp_replication_runs'),
			params: [],
		})
	})
})
