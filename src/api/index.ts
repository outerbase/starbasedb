// This file is a template for adding your own API endpoints.
// You can access these endpoints at the following URL:
// https://starbasedb.YOUR-IDENTIFIER.workers.dev/api/your/path/here

import { StarbaseContext } from '../handler'
import { DataSource } from '../types'

export async function handleApiRequest(
    request: Request,
    dataSource: DataSource
): Promise<Response> {
    const url = new URL(request.url)

    // EXAMPLE:
    // if (request.method === 'GET' && url.pathname === '/api/your/path/here') {
    //     return new Response('Success', { status: 200 });
    // }

    return new Response('Not found', { status: 404 })
}
