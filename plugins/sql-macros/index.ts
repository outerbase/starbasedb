import {
    StarbaseApp,
    StarbaseContext,
    StarbaseDBConfiguration,
} from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'

const parser = new (require('node-sql-parser').Parser)()

export class SqlMacrosPlugin extends StarbasePlugin {
    config?: StarbaseDBConfiguration

    // Prevents SQL statements with `SELECT *` from being executed
    preventSelectStar?: boolean

    constructor(opts?: { preventSelectStar: boolean }) {
        super('starbasedb:sql-macros')
        this.preventSelectStar = opts?.preventSelectStar
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.config = c?.get('config')
            await next()
        })
    }

    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        let { dataSource, sql, params } = opts

        // A data source is required for this plugin to operate successfully
        if (!dataSource) {
            return Promise.resolve({
                sql,
                params,
            })
        }

        sql = await this.replaceExcludeColumns(dataSource, sql, params)

        // Prevention of `SELECT *` statements is only enforced on non-admin users
        // Admins should be able to continue running these statements in database
        // tools such as Outerbase Studio.
        if (this.preventSelectStar && this.config?.role !== 'admin') {
            sql = this.checkSelectStar(sql, params)
        }

        return Promise.resolve({
            sql,
            params,
        })
    }

    private checkSelectStar(sql: string, params?: unknown[]): string {
        try {
            const ast = parser.astify(sql)[0]

            // Only check SELECT statements
            if (ast.type === 'select') {
                const hasSelectStar = ast.columns.some(
                    (col: any) =>
                        col.expr.type === 'star' ||
                        (col.expr.type === 'column_ref' &&
                            col.expr.column === '*')
                )

                if (hasSelectStar) {
                    throw new Error(
                        'SELECT * is not allowed. Please specify explicit columns.'
                    )
                }
            }

            return sql
        } catch (error) {
            // If the error is our SELECT * error, rethrow it
            if (
                error instanceof Error &&
                error.message.includes('SELECT * is not allowed')
            ) {
                throw error
            }
            // For parsing errors or other issues, return original SQL
            return sql
        }
    }

    private async replaceExcludeColumns(
        dataSource: DataSource,
        sql: string,
        params?: unknown[]
    ): Promise<string> {
        // Only currently works for internal data source (Durable Object SQLite)
        if (dataSource.source !== 'internal') {
            return sql
        }

        // Special handling for pragma queries
        if (sql.toLowerCase().includes('pragma_table_info')) {
            return sql
        }

        try {
            // Add semicolon if missing
            const normalizedSql = sql.trim().endsWith(';') ? sql : `${sql};`

            // We allow users to write it `$_exclude` but convert it to `__exclude` so it can be
            // parsed with the AST library without throwing an error.
            const preparedSql = normalizedSql.replaceAll(
                '$_exclude',
                '__exclude'
            )
            const normalizedQuery = parser.astify(preparedSql)[0]

            // Only process SELECT statements
            if (normalizedQuery.type !== 'select') {
                return sql
            }

            // Find any columns using `__exclude`
            const columns = normalizedQuery.columns
            const excludeFnIdx = columns.findIndex(
                (col: any) =>
                    col.expr &&
                    col.expr.type === 'function' &&
                    col.expr.name === '__exclude'
            )

            if (excludeFnIdx === -1) {
                return sql
            }

            // Get the table name from the FROM clause
            const tableName = normalizedQuery.from[0].table
            let excludedColumns: string[] = []

            try {
                const excludeExpr = normalizedQuery.columns[excludeFnIdx].expr

                // Handle both array and single argument cases
                const args = excludeExpr.args.value

                // Extract column name(s) from arguments
                excludedColumns = Array.isArray(args)
                    ? args.map((arg: any) => arg.column)
                    : [args.column]
            } catch (error: any) {
                console.error('Error processing exclude arguments:', error)
                console.error(error.stack)
                return sql
            }

            // Query database for all columns in this table
            // This only works for the internal SQLite data source
            const schemaQuery = `
                SELECT name as column_name
                FROM pragma_table_info('${tableName}')
            `

            const allColumns = (await dataSource?.rpc.executeQuery({
                sql: schemaQuery,
            })) as QueryResult[]

            const includedColumns = allColumns
                .map((row: any) => row.column_name)
                .filter((col: string) => {
                    const shouldInclude = !excludedColumns.includes(
                        col.toLowerCase()
                    )
                    return shouldInclude
                })

            // Replace the __exclude function with explicit columns
            normalizedQuery.columns.splice(
                excludeFnIdx,
                1,
                ...includedColumns.map((col: string) => ({
                    expr: { type: 'column_ref', table: null, column: col },
                    as: null,
                }))
            )

            // Convert back to SQL and remove trailing semicolon to maintain original format
            return parser.sqlify(normalizedQuery).replace(/;$/, '')
        } catch (error) {
            console.error('SQL parsing error:', error)
            return sql
        }
    }
}
