// src/types.ts
// This file will hold shared types for the project.

export interface Env {
  DATABASE_OBJECT: DurableObjectNamespace;
  DUMP_BUCKET: R2Bucket; // Add R2 bucket binding to Env
  // Add other environment variables/bindings as needed
}

export interface DumpState {
  dumpId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELED';
  format: 'sql' | 'csv' | 'json';
  r2Key: string; // The key in R2 where the dump is stored
  callbackUrl?: string;
  startedAt: number; // Timestamp
  completedAt?: number; // Timestamp
  error?: string; // Error message if failed
  downloadUrl?: string; // Signed URL for download (generated on demand)

  // Progress tracking for resumption
  currentTableIndex: number; // Index of the table being processed
  currentRowOffset: number; // Offset within the current table (e.g., last row ID or row number)
  multipartUploadId?: string; // For R2 multipart upload
  uploadedParts: { partNumber: number; etag: string }[]; // List of uploaded parts
  nextPartNumber: number; // Next part number to use for multipart upload
}

// Define a simple interface for database interaction within the DO
// This would typically be an existing class/interface in your project
export interface Database {
  getTables(): Promise<string[]>;
  getRows(tableName: string, offset: number, limit: number): Promise<any[]>;
  getSchema(tableName: string): Promise<string>; // Returns CREATE TABLE statement
  countRows(tableName: string): Promise<number>;
}

// Mock Database implementation for demonstration
export class MockDatabase implements Database {
  private data: { [tableName: string]: any[] } = {
    users: Array.from({ length: 100000 }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      email: `user${i + 1}@example.com`,
      created_at: new Date().toISOString(),
    })),
    products: Array.from({ length: 50000 }, (_, i) => ({
      id: i + 1,
      name: `Product ${i + 1}`,
      price: (Math.random() * 100).toFixed(2),
      description: `Description for product ${i + 1}`,
    })),
  };

  private schemas: { [tableName: string]: string } = {
    users: `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT
);`,
    products: `CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price REAL,
  description TEXT
);`,
  };

  async getTables(): Promise<string[]> {
    return Object.keys(this.data);
  }

  async getRows(tableName: string, offset: number, limit: number): Promise<any[]> {
    const tableData = this.data[tableName];
    if (!tableData) {
      return [];
    }
    // Simulate some delay for large datasets
    await new Promise(resolve => setTimeout(resolve, 10));
    return tableData.slice(offset, offset + limit);
  }

  async getSchema(tableName: string): Promise<string> {
    return this.schemas[tableName] || `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY);`;
  }

  async countRows(tableName: string): Promise<number> {
    return this.data[tableName]?.length || 0;
  }
}
