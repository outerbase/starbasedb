import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StarbaseDB, StarbaseDBConfiguration } from '../src/handler'
import { DataSource } from '../src/types'

// These tests construct the Configuration handler manually and execute
// requests against it rather than having the default Worker placed in
// front of it to handle them. With this structure users can manually
// define what features are toggled on & off so that select StarbaseDB
// functionality is not made available to users.
describe('Configuration Handler', () => {
    const baseUrl = 'http://127.0.0.1:8787'
    let mockDataSource: DataSource
    let mockRequest: Request
    let mockContext: ExecutionContext

    beforeEach(async () => {
        // Mock DurableObjectNamespace
        const mockDurableObjectNamespace = {
            idFromName: vi.fn(() => ({ id: 'mock-durable-object-id' })),
            get: vi.fn(() => ({
                init: vi.fn(async () => ({
                    executeQuery: vi.fn(async ({ sql }: { sql: string }) => {
                        if (sql === 'SELECT 1+1') {
                            return [{ result: 2 }]
                        }
                        throw new Error('Query not supported')
                    }),
                })),
            })),
        }

        // Mock the DataSource
        mockDataSource = {
            rpc: await mockDurableObjectNamespace.get().init(), // Assign mocked rpc
            source: 'internal',
            cache: false,
            context: {},
        }

        // Create a POST request to /query
        mockRequest = new Request(`${baseUrl}/query`, {
            method: 'POST',
            body: JSON.stringify({ sql: 'SELECT 1+1' }),
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ABC123',
            },
        })

        // Mock ExecutionContext
        mockContext = {
            waitUntil: vi.fn(),
        } as unknown as ExecutionContext
    })

    it('should handle query requests', async () => {
        const config: StarbaseDBConfiguration = {
            role: 'admin',
            features: {
                allowlist: true,
                rls: true,
                studio: false,
            },
        }

        const starbase = new StarbaseDB({
            dataSource: mockDataSource,
            config,
        })

        const response = await starbase.handle(mockRequest, mockContext)

        // Assert that the response status is 200
        expect(response.status).toBe(200)

        // Assert that the response contains the correct data
        const responseData = await response.json()
        expect(responseData).toEqual({ result: [{ result: 2 }] })

        // Ensure waitUntil was called (optional)
        expect(mockContext.waitUntil).toHaveBeenCalled()
    })
})
