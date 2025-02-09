import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StarbaseDBDurableObject } from './do'

vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'mock-uuid') })

const mockSqlStorage = {
    exec: vi.fn(),
    databaseSize: 1024,
}
const mockStorage = {
    sql: mockSqlStorage,
}

class MockWebSocket {
    sentMessages: any[]
    readyState: number
    constructor() {
        this.sentMessages = []
        this.readyState = 1
    }

    accept = vi.fn()
    send = vi.fn((msg) => this.sentMessages.push(msg))
    close = vi.fn()
    addEventListener = vi.fn()
}

const mockEnv = {}

const mockCtx = {
    storage: mockStorage,
    getTags: vi.fn(() => ['mock-uuid']),
    waitUntil: vi.fn(),
    id: { name: 'mock-id', toString: vi.fn(() => 'mock-id') },
    blockConcurrencyWhile: vi.fn(),
    acceptWebSocket: vi.fn(),
    fetch: vi.fn(),
    dispose: vi.fn(),
}

let durableObjectInstance: StarbaseDBDurableObject

beforeEach(() => {
    vi.clearAllMocks()
    durableObjectInstance = new StarbaseDBDurableObject(mockCtx, mockEnv)
})

describe('StarbaseDBDurableObject', () => {
    it('should initialize the SQL storage and execute table creation queries', async () => {
        expect(mockSqlStorage.exec).toHaveBeenCalledTimes(4)
    })

    it('should return 400 for unknown fetch routes', async () => {
        const request = new Request('http://localhost/unknown-route', { method: 'GET' })
        const response = await durableObjectInstance.fetch(request)

        expect(response.status).toBe(400)
        const jsonResponse = await response.text()
        expect(jsonResponse).toBe('Unknown operation')
    })

    it('should establish WebSocket connection and store it', async () => {
        global.WebSocketPair = vi.fn(() => ({ 0: new MockWebSocket(), 1: new MockWebSocket() }))

        const request = new Request('http://localhost/socket', {
            headers: { upgrade: 'websocket' },
        })
        const response = await durableObjectInstance.fetch(request)

        expect(response.status).toBe(101)
        expect(durableObjectInstance.connections.size).toBe(1)
    })

    it('should process WebSocket query messages', async () => {
        const mockWebSocket = new MockWebSocket()
        const mockExecuteTransaction = vi.spyOn(durableObjectInstance, 'executeTransaction').mockResolvedValue([{ result: 'mock-result' }])

        durableObjectInstance.connections.set('mock-uuid', mockWebSocket)

        await durableObjectInstance.webSocketMessage(mockWebSocket, JSON.stringify({ sql: 'SELECT * FROM users', action: 'query' }))

        expect(mockExecuteTransaction).toHaveBeenCalledWith([{ sql: 'SELECT * FROM users', params: undefined }], false)
        expect(mockWebSocket.send).toHaveBeenCalledWith(JSON.stringify([{ result: 'mock-result' }]))
    })

    it('should remove WebSocket connection on close', async () => {
        const mockWebSocket = new MockWebSocket()
        durableObjectInstance.connections.set('mock-uuid', mockWebSocket)

        await durableObjectInstance.webSocketClose(mockWebSocket, 1000, 'Closed by client', true)

        expect(durableObjectInstance.connections.has('mock-uuid')).toBe(false)
    })

    it('should return database statistics', async () => {
        const mockExecuteQuery = vi.spyOn(durableObjectInstance, 'executeQuery').mockResolvedValue([{ count: 5 }])

        const stats = await durableObjectInstance.getStatistics()

        expect(stats.databaseSize).toBe(1024)
        expect(stats.activeConnections).toBe(0)
        expect(stats.recentQueries).toBe(5)
        expect(mockExecuteQuery).toHaveBeenCalled()
    })

    it('should execute SQL query and return results', async () => {
        mockSqlStorage.exec.mockReturnValueOnce({ toArray: () => [{ id: 1, name: 'Alice' }] })

        const result = await durableObjectInstance.executeQuery({ sql: 'SELECT * FROM users' })

        expect(result).toEqual([{ id: 1, name: 'Alice' }])
    })

    it('should execute a transaction of queries', async () => {
        const mockExecuteQuery = vi.spyOn(durableObjectInstance, 'executeQuery').mockResolvedValue([{ id: 1, name: 'Alice' }])

        const queries = [{ sql: 'INSERT INTO users (id, name) VALUES (1, "Alice")' }]
        const results = await durableObjectInstance.executeTransaction(queries, false)

        expect(results).toEqual([{ id: 1, name: 'Alice' }])
        expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
    })

    it('should broadcast messages to all connected WebSockets', async () => {
        const mockWebSocket1 = new MockWebSocket()
        const mockWebSocket2 = new MockWebSocket()
        durableObjectInstance.connections.set('uuid-1', mockWebSocket1)
        durableObjectInstance.connections.set('uuid-2', mockWebSocket2)

        const request = new Request('http://localhost/socket/broadcast', {
            method: 'POST',
            body: JSON.stringify({ event: 'update', data: { message: 'New data' } }),
        })

        const response = await durableObjectInstance.fetch(request)

        expect(response.status).toBe(200)
        expect(mockWebSocket1.send).toHaveBeenCalledWith(JSON.stringify({ event: 'update', data: { message: 'New data' } }))
        expect(mockWebSocket2.send).toHaveBeenCalledWith(JSON.stringify({ event: 'update', data: { message: 'New data' } }))
    })

    it('should handle SQL execution errors gracefully', async () => {
        mockSqlStorage.exec.mockImplementation(() => {
            throw new Error('SQL error')
        })

        await expect(durableObjectInstance.executeQuery({ sql: 'SELECT * FROM invalid_table' })).rejects.toThrow('SQL error')
    })

    it('should handle transaction execution errors gracefully', async () => {
        const mockExecuteQuery = vi.spyOn(durableObjectInstance, 'executeQuery').mockRejectedValue(new Error('Transaction failed'))

        const queries = [{ sql: 'DELETE FROM users WHERE id = 1' }]
        await expect(durableObjectInstance.executeTransaction(queries, false)).rejects.toThrow('Transaction failed')

        expect(mockExecuteQuery).toHaveBeenCalled()
    })
})
