import { corsHeaders } from './cors'

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
    return Response.json(
        {
            result,
            error,
        },
        {
            status,
            headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
            },
        }
    )
}
