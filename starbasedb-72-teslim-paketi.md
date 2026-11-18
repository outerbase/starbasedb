# outerbase/starbasedb #72 — Pull Replica Eklentisi Teslim Paketi

## Özet

Bu paket, `outerbase/starbasedb#72` görevi kapsamında geliştirilen **ReplicaPlugin** (`plugins/replica/index.ts`) eklentisini, dokümantasyonunu, Worker entegrasyonunu ve Vitest doğrulama testlerini içerir.

Eklenti, `wrangler.toml` / `dataSource.external` (veya Hyperdrive) üzerinden tanımlı dış veri kaynağından yapılandırılabilir tabloları sayfalayarak (`LIMIT` + `OFFSET`) çeker, dahili Durable Object SQLite veritabanında eksik tabloları `CREATE TABLE IF NOT EXISTS` ile oluşturur ve satırları `INSERT OR REPLACE` ile idempotent biçimde eşitler.

## Değişen ve Eklenen Dosyalar

- `plugins/replica/index.ts`: `ReplicaPlugin` sınıfı, şema keşfi/çıkarımı, sayfalı pull motoru, `POST /replica/sync` ve `GET /replica/status` uç noktaları, SQL tanımlayıcı doğrulama yardımcıları.
- `plugins/replica/index.test.ts`: 17 birim ve HTTP uç nokta testi.
- `plugins/replica/README.md`: Kurulum, yapılandırma ve API kullanım dokümantasyonu.
- `plugins/replica/meta.json`: Eklenti kaynak ve ortam değişkeni tanımları.
- `src/index.ts`: `REPLICA_TABLES`, `REPLICA_BATCH_SIZE` ortam değişkenleri ve `ReplicaPlugin` kaydı.
- `wrangler.toml`: İsteğe bağlı `REPLICA_TABLES` ve `REPLICA_BATCH_SIZE` değişken şablonları.
- `starbasedb-72.patch`: Tüm değişiklikleri içeren birleşik Git yaması.

## Doğrulama

- `corepack.cmd pnpm exec vitest run plugins/replica/index.test.ts` → **17/17 test geçti**.
- `corepack.cmd pnpm exec vitest run` → **19/20 dosya (168/172 test) geçti** (`src/rls/index.test.ts` içindeki 4 hata upstream repo'daki mevcut durumdur).
- `git apply --stat starbasedb-72.patch` → 6 dosya, 1328 satır ekleme doğrulandı.

## Platform Notu

Doğrulama **Windows** ortamında (`corepack.cmd pnpm exec vitest run`) yapılmıştır. Eklenti yalnızca Cloudflare Workers / Hono / SQLite standart API'lerini kullandığından Linux ve macOS ortamlarında da platforma özel bir fark olmaksızın çalışır.
