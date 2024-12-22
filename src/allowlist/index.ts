import { StarbaseDBConfiguration } from '../handler'
import { DataSource, QueryResult } from '../types'

const parser = new (require('node-sql-parser').Parser)()

let allowlist: string[] | null = null
let normalizedAllowlist: any[] | null = null

function normalizeSQL(sql: string) {
    // Remove trailing semicolon. This allows a user to send a SQL statement that has
    // a semicolon where the allow list might not include it but both statements can
    // equate to being the same. AST seems to have an issue with matching the difference
    // when included in one query vs another.
    return sql.trim().replace(/;\s*$/, '')
}

async function loadAllowlist(dataSource: DataSource): Promise<string[]> {
    try {
        const statement =
            'SELECT sql_statement, source FROM tmp_allowlist_queries'
        const result = (await dataSource.rpc.executeQuery({
            sql: statement,
        })) as QueryResult[]
        return result
            .filter((row) => row.source === dataSource.source)
            .map((row) => String(row.sql_statement))
    } catch (error) {
        console.error('Error loading allowlist:', error)
        return []
    }
}

async function addRejectedQuery(
    query: string,
    dataSource: DataSource
): Promise<string[]> {
    try {
        const statement =
            'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)'
        const result = (await dataSource.rpc.executeQuery({
            sql: statement,
            params: [query, dataSource.source],
        })) as QueryResult[]
        return result.map((row) => String(row.sql_statement))
    } catch (error) {
        console.error('Error inserting rejected allowlist query:', error)
        return []
    }
}

export async function isQueryAllowed(opts: {
    sql: string
    isEnabled: boolean
    dataSource: DataSource
    config: StarbaseDBConfiguration
}): Promise<boolean | Error> {
    const { sql, isEnabled, dataSource, config } = opts

    // If the feature is not turned on then by default the query is allowed
    if (!isEnabled) return true

    // If we are using the administrative AUTHORIZATION token value, this request is allowed.
    // We want database UI's to be able to have more free reign to run queries so we can load
    // tables, run queries, and more. If you want to block queries with the allowlist then we
    // advise you to do so by implementing user authentication with JWT.
    if (config.role === 'admin') {
        return true
    }

    allowlist = await loadAllowlist(dataSource)
    normalizedAllowlist = allowlist.map((query) =>
        parser.astify(normalizeSQL(query))
    )

    try {
        if (!sql) {
            return Error('No SQL provided for allowlist check')
        }

        const normalizedQuery = parser.astify(normalizeSQL(sql))

        // Compare ASTs while ignoring specific values
        // const isCurrentAllowed = normalizedAllowlist?.some((allowedQuery) => {
        //     // Create deep copies to avoid modifying original ASTs
        //     const allowedAst = JSON.parse(JSON.stringify(allowedQuery))
        //     const queryAst = JSON.parse(JSON.stringify(normalizedQuery))

        //     // Remove or normalize value fields from both ASTs
        //     const normalizeAst = (ast: any) => {
        //         if (Array.isArray(ast)) {
        //             ast.forEach(normalizeAst)
        //         } else if (ast && typeof ast === 'object') {
        //             // Remove or normalize fields that contain specific values
        //             if ('value' in ast) {
        //                 // Preserve the value for specific clauses like LIMIT
        //                 if (ast.as === 'limit' || ast.type === 'limit') {
        //                     // Do not normalize LIMIT values
        //                     return;
        //                 }
        //                 ast.value = '?'; // Normalize other values
        //             }

        //             // Recursively normalize all other fields
        //             Object.values(ast).forEach(normalizeAst)
        //         }

        //         return ast;
        //     };

        //     normalizeAst(allowedAst)
        //     normalizeAst(queryAst)

        //     return JSON.stringify(allowedAst) === JSON.stringify(queryAst)
        // })

        const deepCompareAst = (allowedAst: any, queryAst: any): boolean => {
            if (typeof allowedAst !== typeof queryAst) return false

            if (Array.isArray(allowedAst) && Array.isArray(queryAst)) {
                if (allowedAst.length !== queryAst.length) return false
                return allowedAst.every((item, index) =>
                    deepCompareAst(item, queryAst[index])
                )
            } else if (
                typeof allowedAst === 'object' &&
                allowedAst !== null &&
                queryAst !== null
            ) {
                const allowedKeys = Object.keys(allowedAst)
                const queryKeys = Object.keys(queryAst)

                if (allowedKeys.length !== queryKeys.length) return false

                return allowedKeys.every((key) =>
                    deepCompareAst(allowedAst[key], queryAst[key])
                )
            }

            // Base case: Primitive value comparison
            return allowedAst === queryAst
        }

        const isCurrentAllowed = normalizedAllowlist?.some((allowedQuery) =>
            deepCompareAst(allowedQuery, normalizedQuery)
        )

        if (!isCurrentAllowed) {
            // For any rejected query, we can add it to a table of rejected queries
            // to act both as an audit log as well as an easy way to see recent queries
            // that may need to be added to the allowlist in an easy way via a user
            // interface.
            addRejectedQuery(sql, dataSource)

            // Then throw the appropriate error to the user.
            throw new Error('Query not allowed')
        }

        return true
    } catch (error: any) {
        throw new Error(error?.message ?? 'Error')
    }
}
