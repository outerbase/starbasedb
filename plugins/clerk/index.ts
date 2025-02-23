import { Webhook } from 'svix'
import { StarbaseApp, StarbaseContext } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { createResponse } from '../../src/utils'
import CREATE_TABLE from './sql/create-table.sql'
import UPSERT_USER from './sql/upsert-user.sql'
import GET_USER_INFORMATION from './sql/get-user-information.sql'
import DELETE_USER from './sql/delete-user.sql'

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
)

const SQL_QUERIES = {
    CREATE_TABLE,
    UPSERT_USER,
    GET_USER_INFORMATION, // Currently not used, but can be turned into an endpoint
    DELETE_USER,
}

export class ClerkPlugin extends StarbasePlugin {
    context?: StarbaseContext
    pathPrefix: string = '/clerk'
    clerkInstanceId?: string
    clerkSigningSecret: string

    constructor(opts?: {
        clerkInstanceId?: string
        clerkSigningSecret: string
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
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.context = c
            const dataSource = c?.get('dataSource')

            // Create user table if it doesn't exist
            await dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.CREATE_TABLE,
                params: [],
            })

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
            const dataSource = this.context?.get('dataSource')

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

                    await dataSource?.rpc.executeQuery({
                        sql: SQL_QUERIES.DELETE_USER,
                        params: [id],
                    })
                } else if (
                    event.type === 'user.updated' ||
                    event.type === 'user.created'
                ) {
                    const { id, first_name, last_name, email_addresses, primary_email_address_id } = event.data

                    const email = email_addresses.find(
                        (email: any) => email.id === primary_email_address_id
                    )?.email_address

                    await dataSource?.rpc.executeQuery({
                        sql: SQL_QUERIES.UPSERT_USER,
                        params: [id, email, first_name, last_name],
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
}
