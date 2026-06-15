import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Resource, ResourceStatus, ResourceType } from "@/lib/types";

const globalForDb = globalThis as unknown as {
  knowledgeDb?: Database.Database;
};

function createDatabase() {
  const databasePath = path.join(process.cwd(), "data", "knowledge.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      source_url TEXT,
      file_name TEXT,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'processing',
      error TEXT,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_resource_id
      ON chunks(resource_id);
  `);

  return database;
}

export const db = globalForDb.knowledgeDb || createDatabase();

if (process.env.NODE_ENV !== "production") {
  globalForDb.knowledgeDb = db;
}

type ResourceRow = {
  id: string;
  name: string;
  type: ResourceType;
  source_url: string | null;
  file_name: string | null;
  status: ResourceStatus;
  error: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
};

export function mapResource(row: ResourceRow): Resource {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    sourceUrl: row.source_url,
    fileName: row.file_name,
    status: row.status,
    error: row.error,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listResources(): Resource[] {
  const rows = db
    .prepare(
      `SELECT id, name, type, source_url, file_name, status, error,
              chunk_count, created_at, updated_at
       FROM resources
       ORDER BY created_at DESC`,
    )
    .all() as ResourceRow[];

  return rows.map(mapResource);
}
