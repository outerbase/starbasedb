/// <reference types="@cloudflare/workers-types" />

import { DumpOptions, DumpState, DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

const CHUNK_SIZE = 1000
const BREATHING_INTERVAL = 5000 // 5 seconds

export class DatabaseDumper {
    private state: DumpState
    private startTime: number
    private r2: R2Bucket

    constructor(
        private dataSource: DataSource,
        private options: DumpOptions,
        private config: StarbaseDBConfiguration
    ) {
        this.startTime = Date.now()
        this.r2 = config.BUCKET
        this.state = {
            id: options.dumpId,
            status: 'pending',
            currentOffset: 0,
            totalRows: 0,
            format: options.format,
        }
    }

    public async start(): Promise<void> {
        try {
            this.state.status = 'processing'
            await this.saveState()
            await this.processNextChunk()
        } catch (error) {
            await this.handleError(error)
        }
    }

    private async processNextChunk(): Promise<void> {
        try {
            const chunk = await this.getNextChunk()

            if (!chunk || chunk.length === 0) {
                await this.complete()
                return
            }

            const formattedData = this.formatChunk(chunk)

            // Get existing content if any
            const existingObject = await this.r2.get(
                `${this.state.id}.${this.state.format}`
            )
            let existingContent = existingObject
                ? await existingObject.text()
                : ''

            // Append new content
            await this.r2.put(
                `${this.state.id}.${this.state.format}`,
                existingContent + formattedData
            )

            this.state.currentOffset += chunk.length
            await this.saveState()

            if (Date.now() - this.startTime > 25000) {
                await this.scheduleNextRun()
            } else {
                await this.processNextChunk()
            }
        } catch (error) {
            await this.handleError(error)
        }
    }

    private async getNextChunk(): Promise<any[]> {
        const result = await this.dataSource.rpc.executeQuery({
            sql: `SELECT * FROM sqlite_master WHERE type='table' LIMIT ${this.options.chunkSize || CHUNK_SIZE} OFFSET ${this.state.currentOffset}`,
            params: [],
        })
        return result || []
    }

    private formatChunk(chunk: any[]): string {
        if (chunk.length === 0) return ''

        switch (this.state.format) {
            case 'sql':
                return chunk.map((row) => row.sql || '').join(';\n') + ';\n'
            case 'csv':
                const headers = Object.keys(chunk[0]).join(',')
                const rows = chunk.map((row) => Object.values(row).join(','))
                return this.state.currentOffset === 0
                    ? [headers, ...rows].join('\n') + '\n'
                    : rows.join('\n') + '\n'
            case 'json':
                return this.state.currentOffset === 0
                    ? '[\n' +
                          chunk.map((row) => JSON.stringify(row)).join(',\n') +
                          ',\n'
                    : chunk.map((row) => JSON.stringify(row)).join(',\n') +
                          ',\n'
            default:
                throw new Error(`Unsupported format: ${this.state.format}`)
        }
    }

    private async complete(): Promise<void> {
        if (this.state.format === 'json') {
            // Get existing content
            const existingObject = await this.r2.get(
                `${this.state.id}.${this.state.format}`
            )
            let existingContent = existingObject
                ? await existingObject.text()
                : ''

            // Append closing bracket
            await this.r2.put(
                `${this.state.id}.${this.state.format}`,
                existingContent + ']'
            )
        }

        this.state.status = 'completed'
        await this.saveState()

        if (this.options.callbackUrl) {
            await fetch(this.options.callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'completed',
                    dumpId: this.state.id,
                    format: this.state.format,
                    url: `${this.state.id}.${this.state.format}`,
                }),
            })
        }
    }

    private async handleError(error: any): Promise<void> {
        this.state.status = 'failed'
        this.state.error = error.message || String(error)
        await this.saveState()

        if (this.options.callbackUrl) {
            await fetch(this.options.callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'failed',
                    dumpId: this.state.id,
                    error: this.state.error,
                }),
            })
        }
    }

    private async saveState(): Promise<void> {
        await this.dataSource.storage.put('dumpState', this.state)
    }

    private async scheduleNextRun(): Promise<void> {
        await this.saveState()
        await this.dataSource.rpc.executeQuery({
            sql: 'SELECT set_alarm(?)',
            params: [Date.now() + BREATHING_INTERVAL],
        })
    }

    public static async continueProcessing(
        dataSource: DataSource,
        config: StarbaseDBConfiguration
    ): Promise<void> {
        const state = (await dataSource.storage.get('dumpState')) as DumpState
        if (!state || state.status !== 'processing') return

        const dumper = new DatabaseDumper(
            dataSource,
            {
                format: state.format,
                dumpId: state.id,
                chunkSize: CHUNK_SIZE,
            },
            config
        )

        dumper.state = state
        await dumper.processNextChunk()
    }

    public static async getStatus(
        dataSource: DataSource,
        dumpId: string
    ): Promise<DumpState | null> {
        const state = await dataSource.storage.get(`dumpState_${dumpId}`)
        return (state as DumpState) || null
    }
}
