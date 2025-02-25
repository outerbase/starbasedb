import { StarbasePlugin } from '../../src/plugin'

export class SlackPlugin extends StarbasePlugin {
    // Prefix route
    prefix: string = '/slack'
    // Webhook URL to call to Slack
    webhookUrl?: string

    constructor(opts?: { webhookUrl: string }) {
        super('starbasedb:slack', {
            requiresAuth: true,
        })

        this.webhookUrl = opts?.webhookUrl
    }

    public async sendMessage(message: { text?: string; blocks?: any[] }) {
        if (!this.webhookUrl) {
            throw new Error(`Slack webhook URL was not provided.`)
        }

        try {
            const response = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(message),
            })

            if (!response.ok) {
                throw new Error(
                    `Failed to send Slack message: ${response.statusText}`
                )
            }

            return response
        } catch (error) {
            console.error('Error sending Slack message:', error)
            throw error
        }
    }
}
