import { StarbaseDBConfiguration } from '../handler'
import { DataSource, QueryResult } from '../types'

const parser = new (require('node-sql-parser').Parser)()

type Policy = {
    action: string
    condition: {
        type: string
        operator: string
        left: {
            type: string
            table: string
            column: string
        }
        right: {
            type: string
            value: string
        }
    }
}

let policies: Policy[] = []

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

export async function loadPolicies(dataSource: DataSource): Promise<Policy[]> {
    try {
        const statement =
            'SELECT "actions", "schema", "table", "column", "value", "value_type", "operator" FROM tmp_rls_policies'
        const result = (await dataSource.rpc.executeQuery({
            sql: statement,
        })) as QueryResult[]

        if (!result || result.length === 0) {
            throw new Error(
                'Error fetching RLS policies. No policies may exist or there was an error fetching.'
            )
        }

        const policies = result.map((row: any) => {
            let value = row.value
            const valueType = row.value_type?.toLowerCase()
            if (valueType === 'number') {
                value = Number(value)
            }

            let tableName = row.schema
                ? `${row.schema}.${row.table}`
                : row.table
            tableName = normalizeIdentifier(tableName)
            const columnName = normalizeIdentifier(row.column)

            let rightNode
            if (value === 'context.id()') {
                rightNode = { type: 'string', value: '__CONTEXT_ID__' }
            } else {
                rightNode = { type: 'string', value: value }
            }

            return {
                action: row.actions.toUpperCase(),
                condition: {
                    type: 'binary_expr',
                    operator: row.operator,
                    left: {
                        type: 'column_ref',
                        table: tableName,
                        column: columnName,
                    },
                    right: rightNode,
                },
            }
        })

        return policies
    } catch (error) {
        console.error('Error loading RLS policies:', error)
        return []
    }
}

export async function applyRLS(opts: {
    sql: string
    isEnabled: boolean
    dataSource: DataSource
    config: StarbaseDBConfiguration
}): Promise<string> {
    const { sql, isEnabled, dataSource, config } = opts
    if (!isEnabled) return sql
    if (!sql) throw Error('No SQL query found in RLS plugin.')
    if (config.role === 'admin') return sql

    policies = await loadPolicies(dataSource)

    const dialect =
        dataSource.source === 'external'
            ? dataSource.external!.dialect
            : 'sqlite'

    let context: Record<string, any> = dataSource?.context ?? {}
    let ast
    let modifiedSql
    const sqlifyOptions = {
        database: dialect,
        quote: '',
    }

    try {
        ast = parser.astify(sql, { database: dialect })
        if (Array.isArray(ast)) {
            ast.forEach((singleAst) => applyRLSToAst(singleAst))
        } else {
            applyRLSToAst(ast)
        }
    } catch (error) {
        console.error('Error parsing SQL:', error)
        throw error as Error
    }

    try {
        if (Array.isArray(ast)) {
            modifiedSql = ast
                .map((singleAst) => parser.sqlify(singleAst, sqlifyOptions))
                .join('; ')
        } else {
            modifiedSql = parser.sqlify(ast, sqlifyOptions)
        }
    } catch (error) {
        console.error('Error generating SQL from AST:', error)
        throw error as Error
    }

    if (context?.sub) {
        modifiedSql = modifiedSql.replace(
            /'__CONTEXT_ID__'/g,
            `'${context.sub}'`
        )
    }

    return modifiedSql
}

function applyRLSToAst(ast: any): void {
    if (!ast) return

    const statementType = ast.type?.toUpperCase()
    if (!['SELECT', 'UPDATE', 'DELETE', 'INSERT'].includes(statementType))
        return

    // 1. Extract all tables
    const tables: string[] = []

    // Check ast.table (used in INSERT, UPDATE, DELETE)
    if (ast.table) {
        const tableArr = Array.isArray(ast.table) ? ast.table : [ast.table]
        tableArr.forEach((t: any) => {
            if (t.table) tables.push(normalizeIdentifier(t.table))
        })
    }

    // Check ast.from (used in SELECT, DELETE)
    if (ast.from && Array.isArray(ast.from)) {
        ast.from.forEach((f: any) => {
            if (f.table) tables.push(normalizeIdentifier(f.table))
            if (f.expr && f.expr.ast) applyRLSToAst(f.expr.ast)
        })
    }

    const tablesWithRules: Record<string, string[]> = {}
    policies.forEach((policy) => {
        const tbl = normalizeIdentifier(policy.condition.left.table)
        if (!tablesWithRules[tbl]) tablesWithRules[tbl] = []
        tablesWithRules[tbl].push(policy.action)
    })

    const restrictedTables = Object.keys(tablesWithRules)
    for (const table of tables) {
        const matchingPolicyKey = restrictedTables.find(
            (rt) =>
                rt === table || (rt.includes('.') && rt.split('.')[1] === table)
        )

        if (matchingPolicyKey) {
            const allowedActions = tablesWithRules[matchingPolicyKey] || []
            if (
                allowedActions.length > 0 &&
                !allowedActions.includes(statementType) &&
                !allowedActions.includes('*')
            ) {
                throw new Error(
                    `Unauthorized access: No matching rules for ${statementType} on restricted table ${table}`
                )
            }
        }
    }

    // 2. Inject RLS
    policies
        .filter((p) => p.action === statementType || p.action === '*')
        .forEach(({ action, condition }) => {
            const policyTable = normalizeIdentifier(condition.left.table)
            const isMatch = tables.some(
                (t) =>
                    t === policyTable ||
                    (policyTable.includes('.') &&
                        t === policyTable.split('.')[1])
            )

            if (!isMatch) return

            if (action !== 'INSERT') {
                const newCondition = JSON.parse(JSON.stringify(condition))
                newCondition.parentheses = true

                if (ast.where) {
                    // Check for duplicate
                    if (
                        JSON.stringify(ast.where).includes(
                            JSON.stringify(condition.left)
                        )
                    )
                        return

                    ast.where = {
                        type: 'binary_expr',
                        operator: 'AND',
                        parentheses: true,
                        left: ast.where,
                        right: newCondition,
                    }
                } else {
                    ast.where = newCondition
                }
            } else {
                // INSERT logic: Enforce column value
                if (ast.values && ast.values.length > 0) {
                    const columnIndex = ast.columns.findIndex(
                        (col: any) =>
                            normalizeIdentifier(col) ===
                            normalizeIdentifier(condition.left.column)
                    )
                    if (columnIndex !== -1) {
                        ast.values.forEach((valueList: any) => {
                            const valTarget =
                                valueList.type === 'expr_list'
                                    ? valueList.value
                                    : valueList
                            valTarget[columnIndex] = {
                                type: condition.right.type,
                                value: condition.right.value,
                            }
                        })
                    }
                }
            }
        })

    // Recursive checks
    if (ast.where) traverseWhere(ast.where)
    if (ast.columns) {
        ast.columns.forEach((col: any) => {
            if (col.expr && col.expr.type === 'select') applyRLSToAst(col.expr)
        })
    }
}

function traverseWhere(node: any): void {
    if (!node) return
    if (node.type === 'select') applyRLSToAst(node)
    if (node.left) traverseWhere(node.left)
    if (node.right) traverseWhere(node.right)
}
