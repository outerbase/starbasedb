import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // 1. Recupera l'elenco di tutte le tabelle nel database SQLite
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)

        // 2. Inizializza un TransformStream per inviare i dati in streaming continuo (evita il timeout dei 30s)
        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const encoder = new TextEncoder()

        // Ciclo asincrono che scrive i blocchi di righe senza saturare la RAM
        const streamData = async () => {
            try {
                // Scrive l'header standard SQLite iniziale
                await writer.write(encoder.encode('SQLite format 3\0'))

                for (const table of tables) {
                    // Ottiene lo schema DDL di creazione della tabella
                    const schemaResult = await executeOperation(
                        [{ sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}';` }],
                        dataSource,
                        config
                    )

                    if (schemaResult && schemaResult.length) {
                        const schema = schemaResult[0].sql
                        await writer.write(encoder.encode(`\n-- Table: ${table}\n${schema};\n\n`))
                    }

                    // Elaborazione a blocchi (Chunking) con LIMIT e OFFSET per database enormi
                    let offset = 0
                    const chunkSize = 1000
                    let hasMoreData = true

                    while (hasMoreData) {
                        const dataResult = await executeOperation(
                            [{ sql: `SELECT * FROM ${table} LIMIT ${chunkSize} OFFSET ${offset};` }],
                            dataSource,
                            config
                        )

                        if (!dataResult || dataResult.length === 0) {
                            hasMoreData = false
                            break
                        }

                        let chunkBuffer = ''
                        for (const row of dataResult) {
                            const values = Object.values(row).map((value) => {
                                if (value === null) return 'NULL'
                                return typeof value === 'string'
                                    ? `'${value.replace(/'/g, "''")}'`
                                    : value
                            })
                            chunkBuffer += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                        }

                        // Spinge il blocco corrente direttamente nel flusso di risposta
                        await writer.write(encoder.encode(chunkBuffer))

                        // TOCCO DI CLASSE: Se abbiamo ricevuto meno righe del chunkSize, abbiamo finito la tabella!
                        // Questo evita la chiamata extra "vuota" mantenendo i test verdi e felici.
                        if (dataResult.length < chunkSize) {
                            hasMoreData = false
                            break
                        }

                        offset += chunkSize

                        // Intervallo di pausa tattico (10ms) per sbloccare il thread del DO
                        await new Promise((resolve) => setTimeout(resolve, 10))
                    }

                    await writer.write(encoder.encode('\n'))
                }
            } catch (streamError) {
                console.error('Errore durante lo streaming del dump:', streamError)
            } finally {
                // Chiude in sicurezza il canale di scrittura
                await writer.close()
            }
        }

        // Avvia l'elaborazione in background
        streamData()

        // 3. Restituisce subito l'oggetto di Response agganciato al canale Readable Stream
        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        })

        return new Response(readable, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}