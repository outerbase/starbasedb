import { Parser } from 'node-sql-parser'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

const parser = new Parser()

type Policy = {
    table_name: string
    policy: string
}

let policies: Policy[] = []

// Rules on how RLS policies should work
// 1. If a table has _any_ rules applied to it, then each action needs to be explicitly defined or it should be automatically denied.
// For example, if I say "SELECT" on table "todos" has an RLS policy but no entry for "INSERT" then insert statements should fail.
// This is the equivalent of turning "on" RLS for a particular table.
// 2. For any actions of type "SELECT" we want to inject an additional WHERE clause wrapped in `(...)` which prevents overriding like `1=1`

// ----------

// Things to consider:
// 1. Do we need to always check `schema`.`table` instead of just `table` or whatever is entered in our policy table?
// 2. Perhaps we should automatically throw an error if there is an error querying (or zero results return) from the policy table?
// -> I say this because if an error occurs then it would entirely circumvent rules and over-expose data.
// -> If they really don't want any rules to exist, remove this power-up

function normalizeIdentifier(name: string): string {
    if (!name) return name
    if (
        (name.startsWith('"') && name.endsWith('"')) ||
        (name.startsWith('`') && name.endsWith('`'))
    ) {
        return name.slice(1, -1)
    }
    return name
}

export async function loadPolicies(dataSource: DataSource) {
    try {
        const result = await dataSource.rpc.executeQuery({
            sql: 'SELECT * FROM rls_policies',
        })
        return result || []
    } catch (error) {
        console.error('Error loading RLS policies:', error)
        return []
    }
}

export async function applyRLS({
    sql,
    isEnabled,
    dataSource,
    config,
}: {
    sql: string
    isEnabled: boolean
    dataSource: DataSource
    config: StarbaseDBConfiguration
}) {
    if (!isEnabled || config.role === 'admin') {
        return sql
    }

    try {
        const policies = await loadPolicies(dataSource)
        if (!policies.length) return sql

        const ast = parser.astify(sql)
        if (Array.isArray(ast)) return sql

        const tables = extractTables(ast)

        tables.forEach((table) => {
            const tablePolicy = policies.find(
                (p: Policy) => p.table_name === table
            )
            if (tablePolicy) {
                addWhereClause(ast, tablePolicy.policy, table)
            }
        })

        // Use a consistent format for the SQL output
        const result = parser.sqlify(ast)
        return result
    } catch (error) {
        console.error('Error applying RLS:', error)
        return sql
    }
}

function extractTables(ast: any): string[] {
    const tables: string[] = []

    if (ast.type === 'select') {
        ast.from?.forEach((item: any) => {
            if (item.table) tables.push(item.table)
        })
    } else if (ast.type === 'update') {
        if (ast.table?.[0]?.table) {
            tables.push(ast.table[0].table)
        }
    } else if (ast.type === 'delete') {
        if (ast.from?.[0]?.table) {
            tables.push(ast.from[0].table)
        }
    }

    return tables
}

function addWhereClause(ast: any, policy: string, tableName: string) {
    try {
        // Create a dummy query to parse the policy condition
        const dummyQuery = `SELECT * FROM ${tableName} WHERE ${policy}`
        const policyAst = parser.astify(dummyQuery) as any

        if (!policyAst || !policyAst.where) return

        if (!ast.where) {
            ast.where = policyAst.where
        } else {
            ast.where = {
                type: 'binary_expr',
                operator: 'AND',
                left: ast.where,
                right: policyAst.where,
            }
        }
    } catch (error) {
        console.error('Error parsing policy:', error)
    }
}
