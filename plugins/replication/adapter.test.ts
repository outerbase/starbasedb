import { describe, it, expect } from 'vitest'
import { PostgresSyncAdapter } from './adapters/postgres'
import { MySQLSyncAdapter } from './adapters/mysql'
import { GenericSyncAdapter } from './adapters/generic'

describe('PostgresSyncAdapter', () => {
    const adapter = new PostgresSyncAdapter()

    describe('buildIntrospectQuery', () => {
        it('should target information_schema.columns with schema and table params', () => {
            const query = adapter.buildIntrospectQuery('users', 'public')
            expect(query.sql).toContain('information_schema.columns')
            expect(query.sql).toContain('table_schema = ?')
            expect(query.sql).toContain('table_name = ?')
            expect(query.sql).toContain('ORDER BY ordinal_position')
            expect(query.params).toEqual(['public', 'users'])
        })
    })

    describe('parseIntrospectResult & mapType', () => {
        it('should map Postgres integer and boolean types to SQLite INTEGER', () => {
            const raw = [
                { column_name: 'id', data_type: 'bigint', is_nullable: 'NO' },
                {
                    column_name: 'age',
                    data_type: 'integer',
                    is_nullable: 'YES',
                },
                {
                    column_name: 'active',
                    data_type: 'boolean',
                    is_nullable: 'NO',
                },
                { column_name: 'seq', data_type: 'serial', is_nullable: 'NO' },
            ]
            const parsed = adapter.parseIntrospectResult(raw)
            expect(parsed[0]).toEqual({
                name: 'id',
                sourceType: 'bigint',
                sqliteType: 'INTEGER',
                nullable: false,
            })
            expect(parsed[1].sqliteType).toBe('INTEGER')
            expect(parsed[1].nullable).toBe(true)
            expect(parsed[2].sqliteType).toBe('INTEGER')
            expect(parsed[3].sqliteType).toBe('INTEGER')
        })

        it('should map Postgres floating-point types to SQLite REAL', () => {
            const raw = [
                {
                    column_name: 'price',
                    data_type: 'numeric',
                    is_nullable: 'YES',
                },
                {
                    column_name: 'score',
                    data_type: 'double precision',
                    is_nullable: 'YES',
                },
                { column_name: 'ratio', data_type: 'real', is_nullable: 'YES' },
            ]
            const parsed = adapter.parseIntrospectResult(raw)
            parsed.forEach((col) => expect(col.sqliteType).toBe('REAL'))
        })

        it('should map bytea to SQLite BLOB', () => {
            const raw = [
                { column_name: 'data', data_type: 'bytea', is_nullable: 'YES' },
            ]
            const parsed = adapter.parseIntrospectResult(raw)
            expect(parsed[0].sqliteType).toBe('BLOB')
        })

        it('should map json and jsonb to SQLite TEXT for compatibility with json() functions', () => {
            const raw = [
                {
                    column_name: 'metadata',
                    data_type: 'json',
                    is_nullable: 'YES',
                },
                {
                    column_name: 'settings',
                    data_type: 'jsonb',
                    is_nullable: 'YES',
                },
            ]
            const parsed = adapter.parseIntrospectResult(raw)
            expect(parsed[0].sqliteType).toBe('TEXT')
            expect(parsed[1].sqliteType).toBe('TEXT')
        })

        it('should map strings and timestamps to SQLite TEXT', () => {
            const raw = [
                {
                    column_name: 'name',
                    data_type: 'character varying',
                    is_nullable: 'YES',
                },
                { column_name: 'bio', data_type: 'text', is_nullable: 'YES' },
                {
                    column_name: 'created_at',
                    data_type: 'timestamp with time zone',
                    is_nullable: 'NO',
                },
            ]
            const parsed = adapter.parseIntrospectResult(raw)
            parsed.forEach((col) => expect(col.sqliteType).toBe('TEXT'))
            expect(parsed[2].nullable).toBe(false)
        })
    })

    describe('buildFetchQuery', () => {
        it('should generate an initial fetch query without WHERE when cursorValue is null', () => {
            const query = adapter.buildFetchQuery({
                table: 'users',
                schema: 'public',
                cursorColumn: 'id',
                cursorValue: null,
                limit: 100,
            })
            expect(query.sql).toContain('"public"."users"')
            expect(query.sql).toContain('ORDER BY "id" ASC LIMIT ?')
            expect(query.sql).not.toContain('WHERE')
            expect(query.params).toEqual([100])
        })

        it('should generate an incremental query with WHERE when cursorValue is present', () => {
            const query = adapter.buildFetchQuery({
                table: 'users',
                schema: 'public',
                cursorColumn: 'id',
                cursorValue: '1050',
                limit: 50,
            })
            expect(query.sql).toContain('WHERE "id" > ?')
            expect(query.sql).toContain('ORDER BY "id" ASC LIMIT ?')
            expect(query.params).toEqual(['1050', 50])
        })

        it('should select specific columns when provided', () => {
            const query = adapter.buildFetchQuery({
                table: 'users',
                schema: 'public',
                cursorColumn: 'created_at',
                cursorValue: '2026-01-01T00:00:00Z',
                columns: ['id', 'email', 'created_at'],
                limit: 10,
            })
            expect(query.sql).toContain('SELECT "id", "email", "created_at"')
            expect(query.sql).toContain('WHERE "created_at" > ?')
            expect(query.params).toEqual(['2026-01-01T00:00:00Z', 10])
        })

        it('should omit schema from table name when schema is empty', () => {
            const query = adapter.buildFetchQuery({
                table: 'items',
                schema: '',
                cursorColumn: 'id',
                cursorValue: null,
                limit: 25,
            })
            expect(query.sql).toContain('FROM "items"')
            expect(query.sql).not.toContain('"."')
        })
    })
})

describe('MySQLSyncAdapter', () => {
    const adapter = new MySQLSyncAdapter()

    describe('buildIntrospectQuery', () => {
        it('should target INFORMATION_SCHEMA.COLUMNS', () => {
            const query = adapter.buildIntrospectQuery('orders', 'store')
            expect(query.sql).toContain('INFORMATION_SCHEMA.COLUMNS')
            expect(query.sql).toContain('TABLE_SCHEMA = ?')
            expect(query.sql).toContain('TABLE_NAME = ?')
            expect(query.params).toEqual(['store', 'orders'])
        })
    })

    describe('parseIntrospectResult & mapType', () => {
        it('should map MySQL integer types to SQLite INTEGER', () => {
            const raw = [
                {
                    column_name: 'id',
                    data_type: 'bigint(20)',
                    is_nullable: 'NO',
                },
                {
                    column_name: 'active',
                    data_type: 'tinyint(1)',
                    is_nullable: 'NO',
                },
                { column_name: 'count', data_type: 'int', is_nullable: 'YES' },
            ]
            const parsed = adapter.parseIntrospectResult(raw)
            expect(parsed[0].sqliteType).toBe('INTEGER')
            expect(parsed[1].sqliteType).toBe('INTEGER')
            expect(parsed[2].sqliteType).toBe('INTEGER')
        })

        it('should map MySQL float and decimal types to SQLite REAL', () => {
            const raw = [
                {
                    column_name: 'price',
                    data_type: 'decimal(10,2)',
                    is_nullable: 'YES',
                },
                {
                    column_name: 'weight',
                    data_type: 'float',
                    is_nullable: 'YES',
                },
            ]
            const parsed = adapter.parseIntrospectResult(raw)
            expect(parsed[0].sqliteType).toBe('REAL')
            expect(parsed[1].sqliteType).toBe('REAL')
        })

        it('should map MySQL blob types to SQLite BLOB', () => {
            const raw = [
                {
                    column_name: 'payload',
                    data_type: 'blob',
                    is_nullable: 'YES',
                },
                {
                    column_name: 'binary_hash',
                    data_type: 'varbinary(64)',
                    is_nullable: 'YES',
                },
            ]
            const parsed = adapter.parseIntrospectResult(raw)
            expect(parsed[0].sqliteType).toBe('BLOB')
            expect(parsed[1].sqliteType).toBe('BLOB')
        })
    })

    describe('buildFetchQuery', () => {
        it('should use backticks for identifiers in MySQL queries', () => {
            const query = adapter.buildFetchQuery({
                table: 'orders',
                schema: 'shop',
                cursorColumn: 'id',
                cursorValue: '200',
                columns: ['id', 'amount'],
                limit: 100,
            })
            expect(query.sql).toContain(
                'SELECT `id`, `amount` FROM `shop`.`orders`'
            )
            expect(query.sql).toContain('WHERE `id` > ?')
            expect(query.sql).toContain('ORDER BY `id` ASC LIMIT ?')
            expect(query.params).toEqual(['200', 100])
        })
    })
})

describe('GenericSyncAdapter', () => {
    const adapter = new GenericSyncAdapter()

    it('should build PRAGMA table_info query', () => {
        const query = adapter.buildIntrospectQuery('products', '')
        expect(query.sql).toBe('PRAGMA table_info("products")')
    })

    it('should parse PRAGMA table_info result correctly', () => {
        const raw = [
            { name: 'id', type: 'INTEGER', notnull: 1 },
            { name: 'title', type: 'TEXT', notnull: 0 },
            { name: 'rating', type: 'REAL', notnull: 0 },
        ]
        const parsed = adapter.parseIntrospectResult(raw)
        expect(parsed[0]).toEqual({
            name: 'id',
            sourceType: 'INTEGER',
            sqliteType: 'INTEGER',
            nullable: false,
        })
        expect(parsed[1]).toEqual({
            name: 'title',
            sourceType: 'TEXT',
            sqliteType: 'TEXT',
            nullable: true,
        })
        expect(parsed[2]).toEqual({
            name: 'rating',
            sourceType: 'REAL',
            sqliteType: 'REAL',
            nullable: true,
        })
    })
})

describe('SyncAdapter Base Class Methods', () => {
    const adapter = new PostgresSyncAdapter()

    describe('resolveTargetTableName', () => {
        it('should prefix schema name with an underscore when schema is provided', () => {
            expect(adapter.resolveTargetTableName('users', 'public')).toBe(
                'public_users'
            )
            expect(adapter.resolveTargetTableName('accounts', 'auth')).toBe(
                'auth_accounts'
            )
        })

        it('should return sourceTable unchanged when schema is empty or omitted', () => {
            expect(adapter.resolveTargetTableName('users', '')).toBe('users')
            expect(adapter.resolveTargetTableName('users', undefined)).toBe(
                'users'
            )
        })

        it('should allow customTargetTable to override schema prefixing', () => {
            expect(
                adapter.resolveTargetTableName(
                    'users',
                    'public',
                    'edge_users_replica'
                )
            ).toBe('edge_users_replica')
        })
    })

    describe('buildCreateTableSQL', () => {
        it('should generate valid SQLite CREATE TABLE statement with types and primary key', () => {
            const columns = [
                {
                    name: 'id',
                    sourceType: 'integer',
                    sqliteType: 'INTEGER' as const,
                    nullable: false,
                },
                {
                    name: 'email',
                    sourceType: 'varchar',
                    sqliteType: 'TEXT' as const,
                    nullable: false,
                },
                {
                    name: 'metadata',
                    sourceType: 'jsonb',
                    sqliteType: 'TEXT' as const,
                    nullable: true,
                },
            ]
            const sql = adapter.buildCreateTableSQL(
                'public_users',
                columns,
                'id'
            )
            expect(sql).toBe(
                'CREATE TABLE IF NOT EXISTS "public_users" ("id" INTEGER NOT NULL, "email" TEXT NOT NULL, "metadata" TEXT, PRIMARY KEY ("id"))'
            )
        })

        it('should omit PRIMARY KEY clause when primaryKey argument is omitted', () => {
            const columns = [
                {
                    name: 'log_line',
                    sourceType: 'text',
                    sqliteType: 'TEXT' as const,
                    nullable: true,
                },
            ]
            const sql = adapter.buildCreateTableSQL('logs', columns)
            expect(sql).toBe(
                'CREATE TABLE IF NOT EXISTS "logs" ("log_line" TEXT)'
            )
        })
    })

    describe('buildUpsertSQL', () => {
        it('should generate INSERT OR REPLACE statement for replace strategy', () => {
            const sql = adapter.buildUpsertSQL(
                'public_users',
                ['id', 'email', 'name'],
                'replace'
            )
            expect(sql).toBe(
                'INSERT OR REPLACE INTO "public_users" ("id", "email", "name") VALUES (?, ?, ?)'
            )
        })

        it('should generate INSERT OR IGNORE statement for ignore strategy', () => {
            const sql = adapter.buildUpsertSQL(
                'public_users',
                ['id', 'email'],
                'ignore'
            )
            expect(sql).toBe(
                'INSERT OR IGNORE INTO "public_users" ("id", "email") VALUES (?, ?)'
            )
        })
    })
})
