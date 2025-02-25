import { parse } from 'cookie'
import { jwtVerify, importSPKI, JWTPayload } from 'jose'
import { Webhook } from 'svix'
import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'
import CREATE_USER_TABLE from './sql/create-user-table.sql'
import CREATE_SESSION_TABLE from './sql/create-session-table.sql'
import UPSERT_USER from './sql/upsert-user.sql'
import GET_USER_INFORMATION from './sql/get-user-information.sql'
import DELETE_USER from './sql/delete-user.sql'
import UPSERT_SESSION from './sql/upsert-session.sql'
import DELETE_SESSION from './sql/delete-session.sql'
import GET_SESSION from './sql/get-session.sql'

type ClerkEvent = {
    instance_id: string
} & (
    | {
          type: 'user.created' | 'user.updated'
          data: {
              id: string
              first_name: string
              last_name: string
              email_addresses: Array<{
                  id: string
                  email_address: string
              }>
              primary_email_address_id: string
          }
      }
    | {
          type: 'user.deleted'
          data: { id: string }
      }
    | {
          type: 'session.created' | 'session.ended' | 'session.removed' | 'session.revoked'
          data: {
              id: string
              user_id: string
          }
      }
)

const SQL_QUERIES = {
    CREATE_USER_TABLE,
    CREATE_SESSION_TABLE,
    UPSERT_USER,
    GET_USER_INFORMATION, // Currently not used, but can be turned into an endpoint
    DELETE_USER,
    UPSERT_SESSION,
    DELETE_SESSION,
    GET_SESSION,
}

export class ClerkPlugin extends StarbasePlugin {
    private dataSource?: DataSource
    pathPrefix: string = '/clerk'
    clerkInstanceId?: string
    clerkSigningSecret: string
    clerkSessionPublicKey?: string
    permittedOrigins: string[]
    verifySessions: boolean
    constructor(opts?: {
        clerkInstanceId?: string
        clerkSigningSecret: string
        clerkSessionPublicKey?: string
        verifySessions?: boolean
        permittedOrigins?: string[]
        dataSource: DataSource
    }) {
        super('starbasedb:clerk', {
            // The `requiresAuth` is set to false to allow for the webhooks sent by Clerk to be accessible
            requiresAuth: false,
        })

        if (!opts?.clerkSigningSecret) {
            throw new Error('A signing secret is required for this plugin.')
        }

        this.clerkInstanceId = opts.clerkInstanceId
        this.clerkSigningSecret = opts.clerkSigningSecret
        this.clerkSessionPublicKey = opts.clerkSessionPublicKey
        this.verifySessions = opts.verifySessions ?? true
        this.permittedOrigins = opts.permittedOrigins ?? []
        this.dataSource = opts.dataSource
    }

    override async register(app: StarbaseApp) {
        app.use(async (_, next) => {
            // Create user table if it doesn't exist
            await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.CREATE_USER_TABLE,
                params: [],
            })

            if (this.verifySessions) {
                // Create session table if it doesn't exist
                await this.dataSource?.rpc.executeQuery({
                    sql: SQL_QUERIES.CREATE_SESSION_TABLE,
                    params: [],
                })
            }

            await next()
        })

        // Webhook to handle Clerk events
        app.post(`${this.pathPrefix}/webhook`, async (c) => {
            const wh = new Webhook(this.clerkSigningSecret)
            const svix_id = c.req.header('svix-id')
            const svix_signature = c.req.header('svix-signature')
            const svix_timestamp = c.req.header('svix-timestamp')

            if (!svix_id || !svix_signature || !svix_timestamp) {
                return createResponse(
                    undefined,
                    'Missing required headers: svix-id, svix-signature, svix-timestamp',
                    400
                )
            }

            const body = await c.req.text()

            try {
                const event = wh.verify(body, {
                    'svix-id': svix_id,
                    'svix-timestamp': svix_timestamp,
                    'svix-signature': svix_signature,
                }) as ClerkEvent

                if (this.clerkInstanceId && 'instance_id' in event && event.instance_id !== this.clerkInstanceId) {
                    return createResponse(
                        undefined,
                        'Invalid instance ID',
                        401
                    )
                }
                
                if (event.type === 'user.deleted') {
                    const { id } = event.data

                    await this.dataSource?.rpc.executeQuery({
                        sql: SQL_QUERIES.DELETE_USER,
                        params: [id],
                    })

                    // todo if user is deleted, delete all sessions for that user
                } else if (
                    event.type === 'user.updated' ||
                    event.type === 'user.created'
                ) {
                    const { id, first_name, last_name, email_addresses, primary_email_address_id } = event.data

                    const email = email_addresses.find(
                        (email: any) => email.id === primary_email_address_id
                    )?.email_address

                    await this.dataSource?.rpc.executeQuery({
                        sql: SQL_QUERIES.UPSERT_USER,
                        params: [id, email, first_name, last_name],
                    })
                } else if (event.type === 'session.created') {
                    const { id, user_id } = event.data

                    await this.dataSource?.rpc.executeQuery({
                        sql: SQL_QUERIES.UPSERT_SESSION,
                        params: [id, user_id],
                    })
                } else if (event.type === 'session.ended' || event.type === 'session.removed' || event.type === 'session.revoked') {
                    const { id, user_id } = event.data

                    await this.dataSource?.rpc.executeQuery({
                        sql: SQL_QUERIES.DELETE_SESSION,
                        params: [id, user_id],
                    })
                }

                return createResponse({ success: true }, undefined, 200)
            } catch (error: any) {
                console.error('Webhook processing error:', error)
                return createResponse(
                    undefined,
                    `Webhook processing failed: ${error.message}`,
                    400
                )
            }
        })
    }

    /**
     * Authenticates a request using the Clerk session public key.
     * heavily references https://clerk.com/docs/backend-requests/handling/manual-jwt
     * @param cookie The cookie to authenticate.
     * @param token The token to authenticate.
     * @returns {JWTPayload | false} The decoded payload if authenticated, false if not.
     */
    public async authenticate({ cookie, token: tokenCrossOrigin }: { cookie?: string | null, token?: string }) {
        if (!this.verifySessions || !this.clerkSessionPublicKey) {
            console.error('Public key or session verification is not enabled.')
            return false
        }

        const COOKIE_NAME = "__session"
        const tokenSameOrigin = cookie ? parse(cookie)[COOKIE_NAME] : undefined
        if (!tokenSameOrigin && !tokenCrossOrigin) return false

        try {
            const publicKey = await importSPKI(this.clerkSessionPublicKey, 'RS256')
            const token = tokenSameOrigin || tokenCrossOrigin
            const decoded = await jwtVerify<{ sid: string; sub: string }>(token!, publicKey)

            const currentTime = Math.floor(Date.now() / 1000)
            if (
                (decoded.payload.exp && decoded.payload.exp < currentTime)
                || (decoded.payload.nbf && decoded.payload.nbf > currentTime)
            ) {
                console.error('Token is expired or not yet valid')
                return false
            }

            if (this.permittedOrigins.length > 0 && decoded.payload.azp
                && !this.permittedOrigins.includes(decoded.payload.azp as string)
            ) {
                console.error("Invalid 'azp' claim")
                return false
            }

            const sessionExists = await this.sessionExistsInDb(decoded.payload)
            if (!sessionExists) {
                console.error("Session not found")
                return false
            }

            return decoded.payload
        } catch (error) {
            console.error('Authentication error:', error)
            return false
        }
    }

    /**
     * Checks if a user session exists in the database.
     * @param sessionId The session ID to check.
     * @param userId The user ID to check.
     * @param dataSource The data source to use for the check.
     * @returns {boolean} True if the session exists, false if not.
     */
    public async sessionExistsInDb(payload: { sub: string, sid: string }): Promise<boolean> {        
        try {
            const result: any = await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.GET_SESSION,
                params: [payload.sid, payload.sub],
            })
            
            return result?.length > 0
        } catch (error) {
            console.error('db error while fetching session:', error)
            return false
        }
    }
}
