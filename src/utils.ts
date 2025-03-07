/// <reference types="@cloudflare/workers-types" />

import { corsHeaders } from './cors'
import { R2Bucket } from '@cloudflare/workers-types'
import { WebSocket as DurableWebSocket } from '@cloudflare/workers-types'

declare const DATABASE_DUMPS: R2Bucket

export type QueryTransactionRequest = {
    transaction?: QueryRequest[]
}

export type QueryRequest = {
    sql: string
    params?: any[]
}

export function createResponse(
    result: unknown,
    error: string | undefined,
    status: number
): Response {
    return new Response(JSON.stringify({ result, error }), {
        status,
        headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
        },
    })
}

export async function getR2Bucket(): Promise<R2Bucket> {
    const bucket = DATABASE_DUMPS as R2Bucket
    return bucket
}

export async function handleWebSocketMessage(
    ws: DurableWebSocket,
    message: string | ArrayBuffer
): Promise<void> {
    const data =
        typeof message === 'string'
            ? message
            : new TextDecoder().decode(message)
    const parsedMessage = JSON.parse(data)

    if (parsedMessage.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
    } else if (parsedMessage.type === 'echo') {
        ws.send(JSON.stringify({ type: 'echo', data: parsedMessage.data }))
    } else {
        ws.send(
            JSON.stringify({ type: 'error', message: 'Unknown message type' })
        )
    }
}

export async function encryptPassword(password: string): Promise<string> {
    try {
        const encoder = new TextEncoder()
        const data = encoder.encode(password)
        const hash = await crypto.subtle.digest('SHA-256', data)
        return btoa(String.fromCharCode(...new Uint8Array(hash)))
    } catch (error) {
        console.error('Encryption error:', error)
        throw new Error('Failed to encrypt password')
    }
}

export async function decryptPassword(
    encryptedPassword: string
): Promise<string> {
    try {
        const decoder = new TextDecoder()
        const data = new Uint8Array(
            atob(encryptedPassword)
                .split('')
                .map((c) => c.charCodeAt(0))
        )
        const hash = await crypto.subtle.digest('SHA-256', data)
        return decoder.decode(hash)
    } catch (error) {
        console.error('Decryption error:', error)
        throw new Error('Failed to decrypt password')
    }
}
