import { StarbaseDBConfiguration } from "../handler";
import { DataSource, QueryResult } from "../types";

const parser = new (require("node-sql-parser").Parser)();

let allowlist: string[] | null = null;
let normalizedAllowlist: any[] | null = null;

function normalizeSQL(sql: string) {
  // Remove trailing semicolon. This allows a user to send a SQL statement that has
  // a semicolon where the allow list might not include it but both statements can
  // equate to being the same. AST seems to have an issue with matching the difference
  // when included in one query vs another.
  return sql.trim().replace(/;\s*$/, "");
}

async function loadAllowlist(dataSource: DataSource): Promise<string[]> {
  try {
    const statement = "SELECT sql_statement FROM tmp_allowlist_queries";
    const result = await dataSource.rpc.executeQuery({ sql: statement }) as QueryResult[]
    return result.map((row) => String(row.sql_statement));
  } catch (error) {
    console.error("Error loading allowlist:", error);
    return [];
  }
}

export async function isQueryAllowed(opts: {
  sql: string;
  isEnabled: boolean;
  dataSource: DataSource;
  config: StarbaseDBConfiguration;
}): Promise<boolean | Error> {
  const { sql, isEnabled, dataSource, config } = opts;

  // If the feature is not turned on then by default the query is allowed
  if (!isEnabled) return true;

  // If we are using the administrative AUTHORIZATION token value, this request is allowed.
  // We want database UI's to be able to have more free reign to run queries so we can load
  // tables, run queries, and more. If you want to block queries with the allowlist then we
  // advise you to do so by implementing user authentication with JWT.
  if (config.role === "admin") {
    return true;
  }

  allowlist = await loadAllowlist(dataSource);
  normalizedAllowlist = allowlist.map((query) =>
    parser.astify(normalizeSQL(query))
  );

  try {
    if (!sql) {
      return Error("No SQL provided for allowlist check");
    }

    const normalizedQuery = parser.astify(normalizeSQL(sql));

    // Compare ASTs while ignoring specific values
    const isCurrentAllowed = normalizedAllowlist?.some((allowedQuery) => {
      // Create deep copies to avoid modifying original ASTs
      const allowedAst = JSON.parse(JSON.stringify(allowedQuery));
      const queryAst = JSON.parse(JSON.stringify(normalizedQuery));

      // Remove or normalize value fields from both ASTs
      const normalizeAst = (ast: any) => {
        if (Array.isArray(ast)) {
          ast.forEach(normalizeAst);
        } else if (ast && typeof ast === "object") {
          // Remove or normalize fields that contain specific values
          if ("value" in ast) {
            ast.value = "?";
          }

          Object.values(ast).forEach(normalizeAst);
        }

        return ast;
      };

      normalizeAst(allowedAst);
      normalizeAst(queryAst);

      return JSON.stringify(allowedAst) === JSON.stringify(queryAst);
    });

    if (!isCurrentAllowed) {
      throw new Error("Query not allowed");
    }

    return true;
  } catch (error: any) {
    throw new Error(error?.message ?? "Error");
  }
}
