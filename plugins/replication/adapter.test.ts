import { describe, it, expect } from 'vitest'
import { PostgresSyncAdapter } from './adapters/postgres'
import { MySQLSyncAdapter } from './adapters/mysql'
import { GenericSyncAdapter } from './adapters/generic'

function createSyncAdapter(dialect: string) {
    switch (dialect) {
        case 'postgresql':
            return new PostgresSyncAdapter()
        case 'mysql':
            return new MySQLSyncAdapter()
        default:
            return new GenericSyncAdapter()
    }
}

describe('PostgresSyncAdapter', () => {
    const adapter = new PostgresSyncAdapter()

    describe('buildIntrospectQuery()', () => {
        it('should query information_schema with correct params', () => {
            const { sql, params } = adapter.buildIntrospectQuery(
                'users',
                'public'
            )
            expect(sql).toContain('information_schema.columns')
            expect(params).toEqual(['public', 'users'])
        })
    })

    describe('parseIntrospectResult()', () => {
        it('should map postgres integer to SQLite INTEGER', () => {
            const rows = [
                { column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('INTEGER')
            expect(defs[0].nullable).toBe(false)
        })

        it('should map jsonb explicitly to TEXT not BLOB', () => {
            const rows = [
                { column_name: 'meta', data_type: 'jsonb', is_nullable: 'YES' },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('TEXT')
        })

        it('should map json to TEXT', () => {
            const rows = [
                { column_name: 'data', data_type: 'json', is_nullable: 'YES' },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('TEXT')
        })

        it('should map bytea to BLOB', () => {
            const rows = [
                {
                    column_name: 'avatar',
                    data_type: 'bytea',
                    is_nullable: 'YES',
                },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('BLOB')
        })

        it('should map double precision to REAL', () => {
            const rows = [
                {
                    column_name: 'score',
                    data_type: 'double precision',
                    is_nullable: 'YES',
                },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('REAL')
        })

        it('should map uuid to TEXT', () => {
            const rows = [
                { column_name: 'uid', data_type: 'uuid', is_nullable: 'NO' },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('TEXT')
        })
    })

    describe('buildFetchQuery()', () => {
        it('should return full-table scan when cursorValue is null', () => {
            const { sql, params } = adapter.buildFetchQuery({
                table: 'users',
                schema: 'public',
                cursorColumn: 'id',
                cursorValue: null,
                limit: 1000,
            })
            expect(sql).toContain('"public"."users"')
            expect(sql).toContain('LIMIT ?')
            expect(sql).not.toContain('WHERE')
            expect(params).toEqual([1000])
        })

        it('should use cursor filter when cursorValue is set', () => {
            const { sql, params } = adapter.buildFetchQuery({
                table: 'users',
                schema: 'public',
                cursorColumn: 'id',
                cursorValue: '42',
                limit: 500,
            })
            expect(sql).toContain('WHERE')
            expect(sql).toContain('"id" > ?')
            expect(sql).toContain('LIMIT ?')
            expect(params).toEqual(['42', 500])
        })

        it('should select specific columns when provided', () => {
            const { sql } = adapter.buildFetchQuery({
                table: 'users',
                schema: 'public',
                cursorColumn: 'id',
                cursorValue: null,
                columns: ['id', 'email'],
                limit: 100,
            })
            expect(sql).toContain('"id", "email"')
        })

        it('should omit schema prefix when schema is empty', () => {
            const { sql } = adapter.buildFetchQuery({
                table: 'users',
                schema: '',
                cursorColumn: 'id',
                cursorValue: null,
                limit: 100,
            })
            expect(sql).toContain('"users"')
            expect(sql).not.toContain('"."')
        })
    })
})

describe('MySQLSyncAdapter', () => {
    const adapter = new MySQLSyncAdapter()

    describe('buildIntrospectQuery()', () => {
        it('should query INFORMATION_SCHEMA with ? params', () => {
            const { sql, params } = adapter.buildIntrospectQuery(
                'orders',
                'shop'
            )
            expect(sql).toContain('INFORMATION_SCHEMA.COLUMNS')
            expect(params).toEqual(['shop', 'orders'])
        })
    })

    describe('parseIntrospectResult()', () => {
        it('should map int to INTEGER', () => {
            const rows = [
                { column_name: 'id', data_type: 'int', is_nullable: 'NO' },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('INTEGER')
        })

        it('should map float to REAL', () => {
            const rows = [
                {
                    column_name: 'price',
                    data_type: 'float',
                    is_nullable: 'YES',
                },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('REAL')
        })

        it('should map blob to BLOB', () => {
            const rows = [
                { column_name: 'img', data_type: 'blob', is_nullable: 'YES' },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('BLOB')
        })

        it('should map varchar to TEXT', () => {
            const rows = [
                {
                    column_name: 'name',
                    data_type: 'varchar',
                    is_nullable: 'YES',
                },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].sqliteType).toBe('TEXT')
        })
    })

    describe('buildFetchQuery()', () => {
        it('should use backtick quoting and ? params', () => {
            const { sql, params } = adapter.buildFetchQuery({
                table: 'orders',
                schema: 'shop',
                cursorColumn: 'id',
                cursorValue: '10',
                limit: 200,
            })
            expect(sql).toContain('`shop`.`orders`')
            expect(sql).toContain('`id` > ?')
            expect(params).toEqual(['10', 200])
        })
    })
})

describe('GenericSyncAdapter', () => {
    const adapter = new GenericSyncAdapter()

    describe('buildIntrospectQuery()', () => {
        it('should use PRAGMA table_info', () => {
            const { sql, params } = adapter.buildIntrospectQuery('users', '')
            expect(sql).toContain('PRAGMA table_info')
            expect(params).toEqual(['users'])
        })
    })

    describe('parseIntrospectResult()', () => {
        it('should parse PRAGMA rows', () => {
            const rows = [
                { name: 'id', type: 'INTEGER', notnull: 1 },
                { name: 'name', type: 'TEXT', notnull: 0 },
            ]
            const defs = adapter.parseIntrospectResult(rows)
            expect(defs[0].name).toBe('id')
            expect(defs[0].sqliteType).toBe('INTEGER')
            expect(defs[0].nullable).toBe(false)
            expect(defs[1].nullable).toBe(true)
        })
    })
})

describe('SyncAdapter shared helpers', () => {
    const adapter = new PostgresSyncAdapter()

    describe('buildCreateTableSQL()', () => {
        it('should produce valid CREATE TABLE statement', () => {
            const sql = adapter.buildCreateTableSQL('public_users', [
                {
                    name: 'id',
                    sourceType: 'integer',
                    sqliteType: 'INTEGER',
                    nullable: false,
                },
                {
                    name: 'email',
                    sourceType: 'text',
                    sqliteType: 'TEXT',
                    nullable: true,
                },
                {
                    name: 'meta',
                    sourceType: 'jsonb',
                    sqliteType: 'TEXT',
                    nullable: true,
                },
            ])
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS "public_users"')
            expect(sql).toContain('"id" INTEGER NOT NULL')
            expect(sql).toContain('"email" TEXT')
            expect(sql).toContain('"meta" TEXT')
        })

        it('should add PRIMARY KEY clause when primaryKey is provided', () => {
            const sql = adapter.buildCreateTableSQL(
                'public_users',
                [{ name: 'id', sourceType: 'integer', sqliteType: 'INTEGER', nullable: false }],
                'id'
            )
            expect(sql).toContain('PRIMARY KEY ("id")')
        })
    })

    describe('buildUpsertSQL()', () => {
        it('should produce INSERT OR REPLACE for replace strategy', () => {
            const sql = adapter.buildUpsertSQL(
                'public_users',
                ['id', 'email'],
                'replace'
            )
            expect(sql).toContain('INSERT OR REPLACE INTO "public_users"')
            expect(sql).toContain('"id", "email"')
            expect(sql).toContain('?, ?')
        })

        it('should produce INSERT OR IGNORE for ignore strategy', () => {
            const sql = adapter.buildUpsertSQL(
                'public_users',
                ['id', 'email'],
                'ignore'
            )
            expect(sql).toContain('INSERT OR IGNORE INTO "public_users"')
        })
    })
})

describe('createSyncAdapter factory', () => {
    it('should return PostgresSyncAdapter for postgresql dialect', () => {
        const adapter = createSyncAdapter('postgresql')
        expect(adapter).toBeInstanceOf(PostgresSyncAdapter)
    })

    it('should return MySQLSyncAdapter for mysql dialect', () => {
        const adapter = createSyncAdapter('mysql')
        expect(adapter).toBeInstanceOf(MySQLSyncAdapter)
    })

    it('should return GenericSyncAdapter for unknown dialects', () => {
        const adapter = createSyncAdapter('sqlite')
        expect(adapter).toBeInstanceOf(GenericSyncAdapter)
    })
})
