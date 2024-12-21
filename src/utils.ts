import { corsHeaders } from './cors'

export type QueryTransactionRequest = {
    transaction?: QueryRequest[]
}

export type QueryRequest = {
    sql: string
    params?: any[]
}

export type ServerResponse = {
    result?: any[]
    error?: string
    status: number
}

export function createJSONResponse(data: ServerResponse): Response {
    return new Response(
        JSON.stringify({
            result: data.result,
            error: data.error,
        }),
        {
            status: data.status,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders,
            },
        }
    )
}

export function createResponse(
    result: any,
    error: string | undefined,
    status: number
): Response {
    return createJSONResponse({
        result,
        error,
        status,
    })
}
