import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import { createResponse } from '../utils'

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    bucket: any // R2Bucket (Cloudflare R2)
) {
    try {
        // 1. Güvenlik Kontrolü: R2 sepeti tanımlı mı?
        if (!bucket) {
            throw new Error('R2 bucket (DUMP_BUCKET) is not bound to this worker.')
        }

        // 2. Tüm tabloların listesini çek (sqlite_ iç sistem tablolarını hariç tut)
        const tablesResponse = await dataSource.rpc.executeQuery({
            sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            params: []
        })

        const tables = tablesResponse.results as { name: string }[]
        let fullDump = `-- StarbaseDB Backup\n-- Date: ${new Date().toISOString()}\n\n`
        fullDump += "PRAGMA foreign_keys=OFF;\n"

        // 3. Her tablo için döngü başlat
        for (const table of tables) {
            const tableName = table.name
            
            // Tabloyu oluşturma kodunu (DDL) al
            const schema = await dataSource.rpc.executeQuery({
                sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}'`,
                params: []
            })
            
            if (schema.results.length > 0) {
                fullDump += `\n-- Table: ${tableName}\n`
                fullDump += `${(schema.results[0] as any).sql};\n`
            }

            // Tablo verilerini çek
            const data = await dataSource.rpc.executeQuery({
                sql: `SELECT * FROM ${tableName}`,
                params: []
            })

            // Verileri INSERT formatına çevir
            for (const row of data.results) {
                const columns = Object.keys(row).join(', ')
                const values = Object.values(row).map(v => {
                    if (v === null) return 'NULL'
                    if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
                    if (typeof v === 'boolean') return v ? '1' : '0'
                    return v
                }).join(', ')
                
                fullDump += `INSERT INTO ${tableName} (${columns}) VALUES (${values});\n`
            }
        }

        fullDump += "\nPRAGMA foreign_keys=ON;"

        // 4. Dosya adını oluştur ve R2'ye yükle
        const fileName = `backups/dump_${Date.now()}.sql`
        
        // R2'ye dosyayı yazıyoruz (Content-Type belirterek)
        await bucket.put(fileName, fullDump, {
            httpMetadata: { contentType: 'application/sql' }
        })

        // 5. Başarılı yanıt dön
        return createResponse(
            { 
                success: true, 
                message: 'Database dump created and uploaded to R2', 
                file: fileName,
                size: `${(fullDump.length / 1024).toFixed(2)} KB`
            }, 
            undefined, 
            200
        )

    } catch (error: any) {
        console.error('Dump Error:', error)
        return createResponse(undefined, `Dump failed: ${error.message}`, 500)
    }
}