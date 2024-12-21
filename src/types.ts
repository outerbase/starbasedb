import { StarbaseDBDurableObject } from "./do";

export type QueryResult = Record<string, SqlStorageValue>;

export type RemoteSource = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  defaultSchema?: string;
};

export type PostgresSource = {
  dialect: "postgresql";
} & RemoteSource;

export type MySQLSource = {
  dialect: "mysql";
} & RemoteSource;

export type CloudflareD1Source = {
  dialect: "sqlite";
  provider: "cloudflare-d1";
  apiKey: string;
  accountId: string;
  databaseId: string;
} & Pick<RemoteSource, "defaultSchema">;

export type StarbaseDBSource = {
  dialect: "sqlite";
  provider: "starbase";
  apiKey: string;
  token: string;
} & Pick<RemoteSource, "defaultSchema">;

export type TursoDBSource = {
  dialect: "sqlite";
  provider: "turso";
  uri: string;
  token: string;
} & Pick<RemoteSource, "defaultSchema">;

export type ExternalDatabaseSource =
  | PostgresSource
  | MySQLSource
  | CloudflareD1Source
  | StarbaseDBSource
  | TursoDBSource;

export type DataSource = {
  rpc: Awaited<ReturnType<DurableObjectStub<StarbaseDBDurableObject>["init"]>>;
  source: "internal" | "external";
  external?: ExternalDatabaseSource;
  context?: Record<string, unknown>;
  cache?: boolean;
  cacheTTL?: number;
};

// export interface InternalConnection {
//   durableObject: DatabaseStub;
// }

// export type DatabaseStub = DurableObjectStub & {
//   fetch: (init?: RequestInit | Request) => Promise<Response>;
//   executeQuery(
//     sql: string,
//     params: any[] | undefined,
//     isRaw: boolean
//   ): QueryResponse;
//   executeTransaction(
//     queries: { sql: string; params?: any[] }[],
//     isRaw: boolean
//   ): any[];
// };

export enum RegionLocationHint {
  AUTO = "auto",
  WNAM = "wnam", // Western North America
  ENAM = "enam", // Eastern North America
  SAM = "sam", // South America
  WEUR = "weur", // Western Europe
  EEUR = "eeur", // Eastern Europe
  APAC = "apac", // Asia Pacific
  OC = "oc", // Oceania
  AFR = "afr", // Africa
  ME = "me", // Middle East
}
