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

async function loadPolicies(dataSource: DataSource): Promise<Policy[]> {
    try {
        const statement =
            'SELECT "actions", "schema", "table", "column", "value", "value_type", "operator" FROM tmp_rls_policies'
        const result = (await dataSource.rpc.executeQuery({
            sql: statement,
        })) as QueryResult[]

        if (!result || result.length === 0) {
            // Discussion point to be had here. For safety precautions I am ejecting
            // out of the entire flow if no results are responded back with for example
            // the case where the database instance is not responding, we don't want to
            // simply assume that the incoming SQL should be processed. Instead, we need
            // to know that we received all the rules for us to enforce them. When no rules
            // exist we exit with an error.
            throw new Error(
                'Error fetching RLS policies. No policies may exist or there was an error fetching.'
            )
        }

        const policies = result.map((row: any) => {
            let value = row.value
            const valueType = row.value_type?.toLowerCase()

            // Currently we are supporting two `value_type` options for the time being. By
            // default values are assumed as `string` unless the type is expressed as another
            // in which we cast it to that type. We will need to handle scenarios where
            // the SQL statement itself will need the type casting.
            if (valueType === 'number') {
                value = Number(value)

                // For example, some databases may require casting like the commented out
                // string here below. We will want to come back and help cover those
                // particular situations.
                // value = `${value}::INT`
            }

            let tableName = row.schema
                ? `${row.schema}.${row.table}`
                : row.table
            tableName = normalizeIdentifier(tableName)
            const columnName = normalizeIdentifier(row.column)

            // If the policy value is context.id(), use a placeholder
            let rightNode
            if (value === 'context.id()') {
                rightNode = { type: 'string', value: '__CONTEXT_ID__' }
            } else {
                rightNode = { type: 'string', value: value }
            }

            // This policy will help construct clauses, such as a WHERE, for the criteria to be met.
            // For example the left side equals the qualifier table column and the right side equals
            // the value that column should be set to. So a basic example could be:
            // `WHERE (my_column = '1234')`
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
    if (!sql) {
        throw Error('No SQL query found in RLS plugin.')
    }

    // Do not apply RLS rules to the admin user
    if (config.role === 'admin') {
        return sql
    }

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

    // We are originally provided a SQL statement to evaluate. The first task we must
    // complete is converting it from SQL to an AST object we can breakdown and
    // understand the structure. By breaking down the structure this is where we can
    // begin applying our RLS policies by injecting items into the abstract syntax
    // tree which will later be converted back to an executable SQL statement.
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

    // After the query was converted into an AST and had any RLS policy rules
    // injected into the abstract syntax tree dynamically, now we are ready to
    // convert the AST object back into a SQL statement that the database can
    // execute.
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

    // Replace placeholder with the user's ID properly quoted
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

    // Handle WITH (CTE) queries as arrays
    if (ast.with && Array.isArray(ast.with)) {
        for (const cte of ast.with) {
            if (cte.stmt) {
                applyRLSToAst(cte.stmt)
            }
        }
    }

    // Set operations
    if (['union', 'intersect', 'except'].includes(ast.type)) {
        applyRLSToAst(ast.left)
        applyRLSToAst(ast.right)
        return
    }

    // Subqueries in INSERT/UPDATE/DELETE
    if (ast.type === 'insert' && ast.from) {
        applyRLSToAst(ast.from)
    }
    if (ast.type === 'update' && ast.where) {
        traverseWhere(ast.where)
    }
    if (ast.type === 'delete' && ast.where) {
        traverseWhere(ast.where)
    }

    const tablesWithRules: Record<string, string[]> = {}
    policies.forEach((policy) => {
        const tbl = normalizeIdentifier(policy.condition.left.table)
        if (!tablesWithRules[tbl]) {
            tablesWithRules[tbl] = []
        }
        tablesWithRules[tbl].push(policy.action)
    })

    const statementType = ast.type?.toUpperCase()
    if (!['SELECT', 'UPDATE', 'DELETE', 'INSERT'].includes(statementType)) {
        return
    }

    let tables: string[] = []
    if (statementType === 'INSERT') {
        let tableName = normalizeIdentifier(ast.table[0].table)
        if (tableName.includes('.')) {
            tableName = tableName.split('.')[1]
        }
        tables = [tableName]
    } else if (statementType === 'UPDATE') {
        tables = ast.table.map((tableRef: any) => {
            let tableName = normalizeIdentifier(tableRef.table)
            if (tableName.includes('.')) {
                tableName = tableName.split('.')[1]
            }
            return tableName
        })
    } else {
        // SELECT or DELETE
        tables =
            ast.from?.map((fromTable: any) => {
                let tableName = normalizeIdentifier(fromTable.table)
                if (tableName.includes('.')) {
                    tableName = tableName.split('.')[1]
                }
                return tableName
            }) || []
    }

    const restrictedTables = Object.keys(tablesWithRules)

    for (const table of tables) {
        if (restrictedTables.includes(table)) {
            const allowedActions = tablesWithRules[table]
            if (!allowedActions.includes(statementType)) {
                throw new Error(
                    `Unauthorized access: No matching rules for ${statementType} on restricted table ${table}`
                )
            }
        }
    }

    policies
        .filter(
            (policy) => policy.action === statementType || policy.action === '*'
        )
        .forEach(({ action, condition }) => {
            const targetTable = normalizeIdentifier(condition.left.table)
            const isTargetTable = tables.includes(targetTable)

            if (!isTargetTable) return

            if (action !== 'INSERT') {
                // Add condition to WHERE with parentheses
                if (ast.where) {
                    ast.where = {
                        type: 'binary_expr',
                        operator: 'AND',
                        parentheses: true,
                        left: {
                            ...ast.where,
                            parentheses: true,
                        },
                        right: {
                            ...condition,
                            parentheses: true,
                        },
                    }
                } else {
                    ast.where = {
                        ...condition,
                        parentheses: true,
                    }
                }
            } else {
                // For INSERT, enforce column values
                if (ast.values && ast.values.length > 0) {
                    const columnIndex = ast.columns.findIndex(
                        (col: any) =>
                            normalizeIdentifier(col) ===
                            normalizeIdentifier(condition.left.column)
                    )
                    if (columnIndex !== -1) {
                        ast.values.forEach((valueList: any) => {
                            if (
                                valueList.type === 'expr_list' &&
                                Array.isArray(valueList.value)
                            ) {
                                valueList.value[columnIndex] = {
                                    type: condition.right.type,
                                    value: condition.right.value,
                                }
                            } else {
                                valueList[columnIndex] = {
                                    type: condition.right.type,
                                    value: condition.right.value,
                                }
                            }
                        })
                    }
                }
            }
        })

    ast.from?.forEach((fromItem: any) => {
        if (fromItem.expr && fromItem.expr.type === 'select') {
            applyRLSToAst(fromItem.expr)
        }

        // Handle both single join and array of joins
        if (fromItem.join) {
            const joins = Array.isArray(fromItem.join)
                ? fromItem.join
                : [fromItem]
            joins.forEach((joinItem: any) => {
                if (joinItem.expr && joinItem.expr.type === 'select') {
                    applyRLSToAst(joinItem.expr)
                }
            })
        }
    })

    if (ast.where) {
        traverseWhere(ast.where)
    }

    ast.columns?.forEach((column: any) => {
        if (column.expr && column.expr.type === 'select') {
            applyRLSToAst(column.expr)
        }
    })
}

function traverseWhere(node: any): void {
    if (!node) return
    if (node.type === 'select') {
        applyRLSToAst(node)
    }
    if (node.left) traverseWhere(node.left)
    if (node.right) traverseWhere(node.right)
}
