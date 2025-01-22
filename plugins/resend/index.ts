import { StarbasePlugin } from '../../src/plugin'

export class ResendPlugin extends StarbasePlugin {
    apiKey?: string

    constructor(opts?: { apiKey: string }) {
        super('starbasedb:resend', {
            requiresAuth: false,
        })
        this.apiKey = opts?.apiKey
    }

    async sendEmail(from: string, to: string[], subject: string, html: string) {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from,
                to,
                subject,
                html,
            }),
        })

        const data: Record<string, any> = await response.json()

        if (!response.ok) {
            throw new Error(data.message || 'Failed to send email')
        }

        return data
    }
}
