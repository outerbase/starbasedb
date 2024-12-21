import { WorkerEntrypoint } from 'cloudflare:workers'
import { login as emailLogin, signup as emailSignup } from './email'
import { createResponse } from './utils'

const DURABLE_OBJECT_ID = 'sql-durable-object'

interface Env {
    DATABASE_DURABLE_OBJECT: DurableObjectNamespace
}

export default class AuthEntrypoint extends WorkerEntrypoint<Env> {
    private stub: any

    // Currently, entrypoints without a named handler are not supported
    async fetch() {
        return new Response(null, { status: 404 })
    }

    /**
     * Handles the auth requests, forwards to the appropriate handler
     * @param pathname
     * @param verb
     * @param body
     * @returns
     */
    async handleAuth(pathname: string, verb: string, body: any) {
        let id: DurableObjectId =
            this.env.DATABASE_DURABLE_OBJECT.idFromName(DURABLE_OBJECT_ID)
        this.stub = this.env.DATABASE_DURABLE_OBJECT.get(id)

        if (verb === 'POST' && pathname === '/auth/signup') {
            return await emailSignup(this.stub, this.env, body)
        } else if (verb === 'POST' && pathname === '/auth/login') {
            return await emailLogin(this.stub, body)
        } else if (verb === 'POST' && pathname === '/auth/logout') {
            return await this.handleLogout(body)
        }

        return new Response(null, { status: 405 })
    }

    /**
     * Handles logging out a user by invalidating all sessions for the user
     * @param request
     * @param body
     * @returns
     */
    async handleLogout(body: any) {
        await this.stub.executeExternalQuery(
            `UPDATE auth_sessions SET deleted_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
            [body.user_id]
        )
        return createResponse(
            JSON.stringify({
                success: true,
            }),
            undefined,
            200
        )
    }

    /**
     * Checks if a session is valid by checking if the session token exists and is not deleted
     * @param sessionToken
     * @returns
     */
    async isSessionValid(sessionToken: string) {
        let result = await this.stub.executeExternalQuery(
            `SELECT * FROM auth_sessions 
             WHERE session_token = ? 
             AND deleted_at IS NULL`,
            [sessionToken]
        )
        return result.result.length > 0
    }
}
