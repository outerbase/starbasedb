import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataSource } from '../../src/types'
import { TableMetadata, TableSyncConfig } from '../data-sync'
import { PostgresSync, PostgresSyncSource } from './index'

describe('PostgresSyncSource', () => {
    let postgresSyncSource: PostgresSyncSource
    let mockDataSource: DataSource
    let mockExecuteQuery: ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.clearAllMocks()

        mockExecuteQuery = vi.fn()
        mockDataSource = {
            source: 'internal',
            external: {
                dialect: 'postgresql',
                connection: {
                    host: 'localhost',
                    port: 5432,
                    database: 'test',
                    user: 'postgres',
                    password: 'password',
                },
            } as any,
            rpc: {
                executeQuery: mockExecuteQuery,
            } as any,
        }

        postgresSyncSource = new PostgresSyncSource({
            dialect: 'postgresql',
            schema: 'public',
        })
    })

    describe('Constructor and Dialect', () => {
        it('should initialize with default public schema and postgresql dialect', () => {
            const defaultSource = new PostgresSyncSource()
            expect(defaultSource.dialect).toBe('postgresql')
            expect(PostgresSync).toBe(PostgresSyncSource)
        })

        it('should accept a custom default schema', () => {
            const customSource = new PostgresSyncSource({
                dialect: 'postgresql',
                schema: 'analytics',
            })
            expect(customSource.dialect).toBe('postgresql')
        })
    })

    describe('Connection Validation', () => {
        it('should validate PostgreSQL connection successfully with tabular rows', async () => {
            mockExecuteQuery.mockResolvedValueOnce({
                rows: [['PostgreSQL 15.0']],
                columns: ['version'],
            })

            await postgresSyncSource.setDataSource(mockDataSource)
            const isValid = await postgresSyncSource.validateConnection()

            expect(isValid).toBe(true)
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'SELECT version()',
                params: [],
            })
        })

        it('should validate PostgreSQL connection successfully with @outerbase/sdk object rows', async () => {
            mockExecuteQuery.mockResolvedValueOnce([
                { version: 'PostgreSQL 16.2 on x86_64-pc-linux-gnu' },
            ])

            await postgresSyncSource.setDataSource(mockDataSource)
            const isValid = await postgresSyncSource.validateConnection()

            expect(isValid).toBe(true)
        })

        it('should fail validation when external data source is not configured', async () => {
            const invalidDataSource: DataSource = {
                source: 'internal',
                rpc: {
                    executeQuery: mockExecuteQuery,
                } as any,
            }

            await postgresSyncSource.setDataSource(invalidDataSource)
            const isValid = await postgresSyncSource.validateConnection()

            expect(isValid).toBe(false)
            expect(mockExecuteQuery).not.toHaveBeenCalled()
        })

        it('should fail validation when external dialect is not postgresql', async () => {
            const mysqlDataSource: DataSource = {
                source: 'internal',
                external: {
                    dialect: 'mysql',
                } as any,
                rpc: {
                    executeQuery: mockExecuteQuery,
                } as any,
            }

            await postgresSyncSource.setDataSource(mysqlDataSource)
            const isValid = await postgresSyncSource.validateConnection()

            expect(isValid).toBe(false)
            expect(mockExecuteQuery).not.toHaveBeenCalled()
        })

        it('should fail validation when connection query throws an error', async () => {
            mockExecuteQuery.mockRejectedValueOnce(
                new Error('Connection refused')
            )

            await postgresSyncSource.setDataSource(mockDataSource)
            const isValid = await postgresSyncSource.validateConnection()

            expect(isValid).toBe(false)
        })
    })

    describe('Schema Operations (getTableSchema)', () => {
        beforeEach(async () => {
            await postgresSyncSource.setDataSource(mockDataSource)
        })

        it('should retrieve table schema correctly from tabular rows', async () => {
            mockExecuteQuery.mockResolvedValueOnce({
                rows: [
                    [
                        'id',
                        'integer',
                        'int4',
                        'NO',
                        "nextval('users_id_seq'::regclass)",
                        null,
                    ],
                    ['name', 'character varying', 'varchar', 'YES', null, 255],
                    [
                        'created_at',
                        'timestamp with time zone',
                        'timestamptz',
                        'NO',
                        'now()',
                        null,
                    ],
                    ['tags', 'ARRAY', '_text', 'YES', null, null],
                    [
                        'status',
                        'character varying',
                        'varchar',
                        'NO',
                        "'active'::character varying",
                        50,
                    ],
                    ['score', 'integer', 'int4', 'NO', '0', null],
                ],
                columns: [
                    'column_name',
                    'data_type',
                    'udt_name',
                    'is_nullable',
                    'column_default',
                    'character_maximum_length',
                ],
            })

            const schema = await postgresSyncSource.getTableSchema('users')

            expect(schema).toEqual([
                {
                    name: 'id',
                    type: 'integer',
                    nullable: false,
                    defaultValue: undefined,
                },
                {
                    name: 'name',
                    type: 'character varying(255)',
                    nullable: true,
                    defaultValue: undefined,
                },
                {
                    name: 'created_at',
                    type: 'timestamp with time zone',
                    nullable: false,
                    defaultValue: undefined,
                },
                {
                    name: 'tags',
                    type: 'text[]',
                    nullable: true,
                    defaultValue: undefined,
                },
                {
                    name: 'status',
                    type: 'character varying(50)',
                    nullable: false,
                    defaultValue: "'active'",
                },
                {
                    name: 'score',
                    type: 'integer',
                    nullable: false,
                    defaultValue: '0',
                },
            ])

            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining('FROM information_schema.columns'),
                params: ['public', 'users'],
            })
        })

        it('should retrieve table schema correctly from @outerbase/sdk object rows', async () => {
            mockExecuteQuery.mockResolvedValueOnce([
                {
                    column_name: 'first_name',
                    data_type: 'text',
                    udt_name: 'text',
                    is_nullable: 'YES',
                    column_default: null,
                    character_maximum_length: null,
                },
                {
                    column_name: 'last_name',
                    data_type: 'text',
                    udt_name: 'text',
                    is_nullable: 'NO',
                    column_default: "'Doe'::text",
                    character_maximum_length: null,
                },
            ])

            const schema =
                await postgresSyncSource.getTableSchema('analytics.person')

            expect(schema).toEqual([
                {
                    name: 'first_name',
                    type: 'text',
                    nullable: true,
                    defaultValue: undefined,
                },
                {
                    name: 'last_name',
                    type: 'text',
                    nullable: false,
                    defaultValue: "'Doe'",
                },
            ])

            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining('FROM information_schema.columns'),
                params: ['analytics', 'person'],
            })
        })

        it('should strip tmp_ prefix when querying external information_schema', async () => {
            mockExecuteQuery.mockResolvedValueOnce({
                rows: [['id', 'integer', 'int4', 'NO', null, null]],
                columns: [
                    'column_name',
                    'data_type',
                    'udt_name',
                    'is_nullable',
                    'column_default',
                    'character_maximum_length',
                ],
            })

            await postgresSyncSource.getTableSchema('tmp_users')

            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining('FROM information_schema.columns'),
                params: ['public', 'users'],
            })
        })
    })

    describe('Data Type Mapping (mapDataType)', () => {
        it('should map PostgreSQL types to SQLite types accurately', () => {
            const testCases: [string, string][] = [
                ['integer', 'INTEGER'],
                ['int', 'INTEGER'],
                ['int2', 'INTEGER'],
                ['int4', 'INTEGER'],
                ['int8', 'INTEGER'],
                ['bigint', 'INTEGER'],
                ['smallint', 'INTEGER'],
                ['serial', 'INTEGER'],
                ['bigserial', 'INTEGER'],
                ['smallserial', 'INTEGER'],
                ['boolean', 'INTEGER'],
                ['bool', 'INTEGER'],
                ['bit', 'INTEGER'],
                ['bit varying', 'INTEGER'],
                ['numeric', 'REAL'],
                ['decimal(10,2)', 'REAL'],
                ['real', 'REAL'],
                ['double precision', 'REAL'],
                ['float4', 'REAL'],
                ['float8', 'REAL'],
                ['money', 'REAL'],
                ['character varying(255)', 'TEXT'],
                ['varchar', 'TEXT'],
                ['character(10)', 'TEXT'],
                ['char', 'TEXT'],
                ['text', 'TEXT'],
                ['bytea', 'BLOB'],
                ['timestamp with time zone', 'TEXT'],
                ['timestamp without time zone', 'TEXT'],
                ['timestamptz', 'TEXT'],
                ['date', 'TEXT'],
                ['time', 'TEXT'],
                ['interval', 'TEXT'],
                ['json', 'TEXT'],
                ['jsonb', 'TEXT'],
                ['uuid', 'TEXT'],
                ['inet', 'TEXT'],
                ['cidr', 'TEXT'],
                ['macaddr', 'TEXT'],
                ['xml', 'TEXT'],
                ['integer[]', 'TEXT'],
                ['text[]', 'TEXT'],
                ['varchar[]', 'TEXT'],
                ['custom_domain_type', 'TEXT'],
            ]

            for (const [pgType, expectedSqliteType] of testCases) {
                expect(postgresSyncSource.mapDataType(pgType)).toBe(
                    expectedSqliteType
                )
            }
        })
    })

    describe('Table Structure Validation (validateTableStructure)', () => {
        beforeEach(async () => {
            await postgresSyncSource.setDataSource(mockDataSource)
        })

        it('should validate existing table structure with standard created_at and id columns', async () => {
            mockExecuteQuery
                .mockResolvedValueOnce({
                    rows: [[true]],
                    columns: ['exists'],
                })
                .mockResolvedValueOnce({
                    rows: [
                        ['id', 'integer', 'int4', 'NO', null, null],
                        [
                            'created_at',
                            'timestamp with time zone',
                            'timestamptz',
                            'NO',
                            null,
                            null,
                        ],
                    ],
                    columns: [
                        'column_name',
                        'data_type',
                        'udt_name',
                        'is_nullable',
                        'column_default',
                        'character_maximum_length',
                    ],
                })

            const tableConfig: TableSyncConfig = {
                name: 'users',
                timestamp_column: 'created_at',
                id_column: 'id',
                hasExplicitSyncColumns: true,
            }

            const validation = await postgresSyncSource.validateTableStructure(
                'users',
                tableConfig
            )

            expect(validation.valid).toBe(true)
            expect(validation.errors).toHaveLength(0)
        })

        it('should validate table without created_at or id when configured via string name (hasExplicitSyncColumns: false)', async () => {
            mockExecuteQuery
                .mockResolvedValueOnce([{ exists: true }])
                .mockResolvedValueOnce([
                    {
                        column_name: 'first_name',
                        data_type: 'text',
                        udt_name: 'text',
                        is_nullable: 'YES',
                        column_default: null,
                        character_maximum_length: null,
                    },
                    {
                        column_name: 'last_name',
                        data_type: 'text',
                        udt_name: 'text',
                        is_nullable: 'YES',
                        column_default: null,
                        character_maximum_length: null,
                    },
                ])

            const tableConfig: TableSyncConfig = {
                name: 'person',
                timestamp_column: 'created_at',
                id_column: 'id',
                hasExplicitSyncColumns: false,
            }

            const validation = await postgresSyncSource.validateTableStructure(
                'person',
                tableConfig
            )

            expect(validation.valid).toBe(true)
            expect(validation.errors).toHaveLength(0)
        })

        it('should detect non-existent table', async () => {
            mockExecuteQuery.mockResolvedValueOnce({
                rows: [[false]],
                columns: ['exists'],
            })

            const tableConfig: TableSyncConfig = {
                name: 'non_existent',
                timestamp_column: 'created_at',
                id_column: 'id',
            }

            const validation = await postgresSyncSource.validateTableStructure(
                'non_existent',
                tableConfig
            )

            expect(validation.valid).toBe(false)
            expect(validation.errors).toContain(
                'Table public.non_existent does not exist'
            )
        })

        it('should detect missing explicitly required columns and invalid timestamp column types', async () => {
            mockExecuteQuery
                .mockResolvedValueOnce({
                    rows: [[true]],
                    columns: ['exists'],
                })
                .mockResolvedValueOnce({
                    rows: [
                        [
                            'name',
                            'character varying',
                            'varchar',
                            'YES',
                            null,
                            255,
                        ],
                        ['bad_ts', 'integer', 'int4', 'NO', null, null],
                    ],
                    columns: [
                        'column_name',
                        'data_type',
                        'udt_name',
                        'is_nullable',
                        'column_default',
                        'character_maximum_length',
                    ],
                })

            const tableConfig: TableSyncConfig = {
                name: 'users',
                timestamp_column: 'bad_ts',
                id_column: 'id',
                cursor_column: 'missing_cursor',
                hasExplicitSyncColumns: true,
            }

            const validation = await postgresSyncSource.validateTableStructure(
                'users',
                tableConfig
            )

            expect(validation.valid).toBe(false)
            expect(validation.errors).toContain(
                'Cursor column missing_cursor not found in table public.users'
            )
            expect(validation.errors).toContain(
                'Column bad_ts in table public.users is not a timestamp type (found: integer)'
            )
            expect(validation.errors).toContain(
                'ID column id not found in table public.users'
            )
        })
    })

    describe('Incremental Data Sync (getIncrementalData)', () => {
        beforeEach(async () => {
            await postgresSyncSource.setDataSource(mockDataSource)
        })

        it('should fetch initial data when no lastSyncTimestamp or lastSyncId exists', async () => {
            const mockResult = {
                rows: [
                    [1, 'John', '2023-01-01T00:00:00Z'],
                    [2, 'Jane', '2023-01-02T00:00:00Z'],
                ],
                columns: ['id', 'name', 'created_at'],
            }
            mockExecuteQuery.mockResolvedValueOnce(mockResult)

            const lastSync: TableMetadata = {
                lastSyncTimestamp: 0,
            }
            const tableConfig: TableSyncConfig = {
                name: 'users',
                timestamp_column: 'created_at',
                id_column: 'id',
                batch_size: 1000,
            }

            const result = await postgresSyncSource.getIncrementalData(
                'users',
                lastSync,
                tableConfig
            )

            expect(result).toEqual(mockResult)
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'SELECT * FROM public.users ORDER BY created_at, id ASC LIMIT 1000',
                params: [],
            })
        })

        it('should fetch incremental data using timestamp and id watermarks', async () => {
            const mockResult = {
                rows: [[3, 'Alice', '2023-01-03T00:00:00Z']],
                columns: ['id', 'name', 'created_at'],
            }
            mockExecuteQuery.mockResolvedValueOnce(mockResult)

            const lastSync: TableMetadata = {
                lastSyncTimestamp: 1640995200000, // 2022-01-01T00:00:00.000Z
                lastSyncId: '2',
            }
            const tableConfig: TableSyncConfig = {
                name: 'users',
                timestamp_column: 'created_at',
                id_column: 'id',
                batch_size: 500,
            }

            const result = await postgresSyncSource.getIncrementalData(
                'users',
                lastSync,
                tableConfig
            )

            expect(result).toEqual(mockResult)
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'SELECT * FROM public.users WHERE created_at > ? AND id > ? ORDER BY created_at, id ASC LIMIT 500',
                params: ['2022-01-01T00:00:00.000Z', '2'],
            })
        })

        it('should fetch incremental data using custom cursor_column', async () => {
            mockExecuteQuery.mockResolvedValueOnce([
                { seq_id: 105, payload: 'event-105' },
            ])

            const lastSync: TableMetadata = {
                lastSyncTimestamp: 1700000000000,
                lastCursorValue: 104,
                cursorColumn: 'seq_id',
            }
            const tableConfig: TableSyncConfig = {
                name: 'events',
                schema: 'analytics',
                cursor_column: 'seq_id',
                batch_size: 250,
            }

            const result = await postgresSyncSource.getIncrementalData(
                'events',
                lastSync,
                tableConfig
            )

            expect(result).toEqual({
                columns: ['seq_id', 'payload'],
                rows: [[105, 'event-105']],
            })
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'SELECT * FROM analytics.events WHERE seq_id > ? ORDER BY seq_id ASC LIMIT 250',
                params: [104],
            })
        })

        it('should fetch full batch without WHERE or ORDER BY when table has no cursor, timestamp, or id columns', async () => {
            mockExecuteQuery.mockResolvedValueOnce([
                { first_name: 'Brayden', last_name: 'Wilmoth' },
            ])

            const lastSync: TableMetadata = {
                lastSyncTimestamp: 1700000000000,
            }
            const tableConfig: TableSyncConfig = {
                name: 'person',
                timestamp_column: undefined,
                id_column: undefined,
                batch_size: 1000,
            }

            const result = await postgresSyncSource.getIncrementalData(
                'person',
                lastSync,
                tableConfig
            )

            expect(result).toEqual({
                columns: ['first_name', 'last_name'],
                rows: [['Brayden', 'Wilmoth']],
            })
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'SELECT * FROM public.person LIMIT 1000',
                params: [],
            })
        })
    })
})
