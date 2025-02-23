import { corsHeaders } from './cors'
import { StarbaseDBConfiguration } from './handler'

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

export function getFeatureFromConfig(
    features: StarbaseDBConfiguration['features']
) {
    return function getFeature(
        key: keyof NonNullable<StarbaseDBConfiguration['features']>,
        defaultValue = true
    ): boolean {
        return features?.[key] ?? !!defaultValue
    }
}
