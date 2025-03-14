import { describe, expect, it, vi, beforeEach } from 'vitest'
import { StarbaseDBDurableObject } from './do'

vi.mock('cloudflare:workers', () => {
    return {
        DurableObject: class MockDurableObject {},
    }
})

declare global {
    interface WebSocket {
        addEventListener(type: string, listener: (event: Event) => void): void
        removeEventListener(
            type: string,
            listener: (event: Event) => void
        ): void
    }
}

// Then define a separate interface for the mock
interface MockWebSocketInterface extends WebSocket {
    accept(): void
    serializeAttachment(): ArrayBuffer
    deserializeAttachment(): any
}

// Then use this interface for your mock class
class MockWebSocket implements MockWebSocketInterface {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3

    static readonly READY_STATE_CONNECTING = 0
    static readonly READY_STATE_OPEN = 1
    static readonly READY_STATE_CLOSING = 2
    static readonly READY_STATE_CLOSED = 3

    // Now reference the static properties after they're defined
    readonly CONNECTING = MockWebSocket.CONNECTING
    readonly OPEN = MockWebSocket.OPEN
    readonly CLOSING = MockWebSocket.CLOSING
    readonly CLOSED = MockWebSocket.CLOSED

    url: string
    protocol: string = ''
    readyState: number = MockWebSocket.CONNECTING
    binaryType: 'blob' | 'arraybuffer' = 'blob'
    bufferedAmount: number = 0
    extensions: string = ''
    onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null
    onerror: ((this: WebSocket, ev: Event) => any) | null = null
    onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null
    onopen: ((this: WebSocket, ev: Event) => any) | null = null

    constructor(url: string | URL, protocols?: string | string[]) {
        this.url = url.toString()
        this.readyState = MockWebSocket.OPEN
        if (this.onopen) {
            const openEvent = new Event('open')
            this.onopen.call(this, openEvent)
        }
    }

    close(code?: number, reason?: string): void {
        this.readyState = MockWebSocket.CLOSED
        if (this.onclose) {
            const closeEvent = new CloseEvent('close', { code, reason })
            this.onclose.call(this, closeEvent)
        }
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        console.log('Sending data:', data)
    }

    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?:
            | boolean
            | { capture?: boolean; once?: boolean; passive?: boolean }
    ): void {
        if (type === 'message' && typeof listener === 'function') {
            this.onmessage = listener as (ev: MessageEvent) => void
        } else if (type === 'open' && typeof listener === 'function') {
            this.onopen = listener as (ev: Event) => void
        } else if (type === 'close' && typeof listener === 'function') {
            this.onclose = listener as (ev: CloseEvent) => void
        } else if (type === 'error' && typeof listener === 'function') {
            this.onerror = listener as (ev: Event) => void
        }
    }

    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | { capture?: boolean }
    ): void {
        if (type === 'message' && this.onmessage === listener) {
            this.onmessage = null
        } else if (type === 'open' && this.onopen === listener) {
            this.onopen = null
        } else if (type === 'close' && this.onclose === listener) {
            this.onclose = null
        } else if (type === 'error' && this.onerror === listener) {
            this.onerror = null
        }
    }

    dispatchEvent(event: Event): boolean {
        return true
    }

    // Fix the method signatures to match exactly what Cloudflare expects
    accept(): void {}
    serializeAttachment(): ArrayBuffer {
        return new ArrayBuffer(0)
    }
    deserializeAttachment(): any {}
}

// Assign the mock to global.WebSocket
global.WebSocket = MockWebSocket as any

// Add WebSocketPair to the global type
declare global {
    interface WebSocket {
        addEventListener(type: string, listener: (event: Event) => void): void
        removeEventListener(
            type: string,
            listener: (event: Event) => void
        ): void
    }
}

// Define WebSocketPair directly
;(global as any).WebSocketPair = vi.fn(() => {
    const client = new global.WebSocket('ws://localhost')
    const server = new global.WebSocket('ws://localhost')
    server.accept = vi.fn()
    return { 0: client, 1: server }
})

// Redefine Response globally
global.Response = class {
    body: any
    status: any
    webSocket: any
    headers: any
    statusText: string
    ok: boolean
    redirected: boolean
    type: string
    url: string
    bodyUsed: boolean = false
    bytes: () => Promise<Uint8Array> = () => Promise.resolve(new Uint8Array())

    static error() {
        return new Response(null, { status: 500 })
    }

    static redirect(url: string, status = 302) {
        return new Response(null, { status, headers: { Location: url } })
    }

    static json(data: any, init?: any) {
        return new Response(JSON.stringify(data), {
            ...init,
            headers: { 'Content-Type': 'application/json' },
        })
    }

    constructor(body?: any, init?: any) {
        this.body = body
        this.status = init?.status ?? 200
        this.webSocket = init?.webSocket
        this.headers = init?.headers ?? {}
        this.statusText = init?.statusText ?? ''
        this.ok = this.status >= 200 && this.status < 300
        this.redirected = false
        this.type = 'basic'
        this.url = ''
    }

    clone() {
        return new Response(this.body, {
            status: this.status,
            headers: this.headers,
            statusText: this.statusText,
        })
    }

    arrayBuffer() {
        return Promise.resolve(new ArrayBuffer(0))
    }
    blob() {
        return Promise.resolve(new Blob())
    }
    formData() {
        return Promise.resolve(new FormData())
    }
    json() {
        return Promise.resolve({})
    }
    text() {
        return Promise.resolve('')
    }
} as any

const mockStorage = {
    sql: {
        exec: vi.fn().mockReturnValue({
            columnNames: ['id', 'name'],
            raw: vi.fn().mockReturnValue([
                [1, 'Alice'],
                [2, 'Bob'],
            ]),
            toArray: vi.fn().mockReturnValue([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ]),
            rowsRead: 2,
            rowsWritten: 1,
        }),
    },
}

const mockDurableObjectState = {
    storage: mockStorage,
    getTags: vi.fn().mockReturnValue(['session-123']),
} as any

const mockEnv = {} as any

let instance: StarbaseDBDurableObject

beforeEach(() => {
    instance = new StarbaseDBDurableObject(mockDurableObjectState, mockEnv)
    vi.clearAllMocks()
})

describe('StarbaseDBDurableObject Tests', () => {
    it('should initialize SQL storage', () => {
        expect(instance.sql).toBeDefined()
        expect(instance.storage).toBeDefined()
    })

    it('should execute a query and return results', async () => {
        const sql = 'SELECT * FROM users'
        const result = await instance.executeQuery({ sql })

        expect(mockStorage.sql.exec).toHaveBeenCalledWith(sql)
        expect(result).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
    })

    it('should execute a transaction and return results', async () => {
        const queries = [
            { sql: 'SELECT * FROM orders' },
            { sql: 'SELECT * FROM products' },
        ]
        const result = await instance.executeTransaction(queries, false)

        expect(mockStorage.sql.exec).toHaveBeenCalledTimes(2)
        expect(result.length).toBe(2)
    })

    it('should handle WebSocket connections', async () => {
        const response = await instance.clientConnected('session-123')

        expect(response.status).toBe(101)
        expect(instance.connections.has('session-123')).toBe(true)
    })

    it('should return 400 for unknown fetch requests', async () => {
        const request = new Request('https://example.com/unknown') as any
        const response = await instance.fetch(request)

        expect(response.status).toBe(400)
    })

    it('should handle errors in executeQuery', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {}) //  Suppress error logs

        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw new Error('Query failed')
        })

        await expect(
            instance.executeQuery({ sql: 'INVALID QUERY' })
        ).rejects.toThrow('Query failed')
    })
})
