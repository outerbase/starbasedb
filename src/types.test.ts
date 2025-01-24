import { describe, expectTypeOf, it, expect } from 'vitest'
import {
    PostgresSource,
    MySQLSource,
    CloudflareD1Source,
    StarbaseDBSource,
    TursoDBSource,
    ExternalDatabaseSource,
    RegionLocationHint,
} from './types'

describe('Database Source Type Tests', () => {
    it('should match the expected PostgresSource structure', () => {
        const pgSource: PostgresSource = {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'admin',
            password: 'securepass',
            database: 'testdb',
        }
        expectTypeOf(pgSource).toMatchTypeOf<PostgresSource>()
    })

    it('should match the expected MySQLSource structure', () => {
        const mysqlSource: MySQLSource = {
            dialect: 'mysql',
            host: 'localhost',
            port: 3306,
            user: 'admin',
            password: 'securepass',
            database: 'testdb',
        }
        expectTypeOf(mysqlSource).toMatchTypeOf<MySQLSource>()
    })

    it('should match the expected CloudflareD1Source structure', () => {
        const cloudflareSource: CloudflareD1Source = {
            dialect: 'sqlite',
            provider: 'cloudflare-d1',
            apiKey: 'abc123',
            accountId: 'acc123',
            databaseId: 'db123',
        }
        expectTypeOf(cloudflareSource).toMatchTypeOf<CloudflareD1Source>()
    })

    it('should match the expected StarbaseDBSource structure', () => {
        const starbaseSource: StarbaseDBSource = {
            dialect: 'sqlite',
            provider: 'starbase',
            apiKey: 'xyz456',
            token: 'token123',
        }
        expectTypeOf(starbaseSource).toMatchTypeOf<StarbaseDBSource>()
    })

    it('should match the expected TursoDBSource structure', () => {
        const tursoSource: TursoDBSource = {
            dialect: 'sqlite',
            provider: 'turso',
            uri: 'https://turso.example.com',
            token: 'turso-token',
        }
        expectTypeOf(tursoSource).toMatchTypeOf<TursoDBSource>()
    })

    it('should allow all ExternalDatabaseSource types', () => {
        const externalSource: ExternalDatabaseSource = {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'admin',
            password: 'securepass',
            database: 'testdb',
        }
        expectTypeOf(externalSource).toMatchTypeOf<ExternalDatabaseSource>()
    })
})

describe('RegionLocationHint Enum Tests', () => {
    it('should have valid enum values', () => {
        expect(RegionLocationHint.AUTO).toBe('auto')
        expect(RegionLocationHint.WNAM).toBe('wnam')
        expect(RegionLocationHint.ENAM).toBe('enam')
        expect(RegionLocationHint.SAM).toBe('sam')
        expect(RegionLocationHint.WEUR).toBe('weur')
        expect(RegionLocationHint.EEUR).toBe('eeur')
        expect(RegionLocationHint.APAC).toBe('apac')
        expect(RegionLocationHint.OC).toBe('oc')
        expect(RegionLocationHint.AFR).toBe('afr')
        expect(RegionLocationHint.ME).toBe('me')
    })
})
