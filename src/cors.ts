export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
        'Authorization, Content-Type, X-Starbase-Source, X-Data-Source',
    'Access-Control-Max-Age': '86400',
}

export function corsPreflight(): Response {
    return new Response(null, {
        status: 204,
        headers: corsHeaders,
    })
}
