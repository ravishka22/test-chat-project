import { Pool, type QueryResultRow } from "pg";
import type {
  CrawlStatus,
  Resource,
  ResourceStatus,
  ResourceType,
} from "@/lib/types";

const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const SCHEMA_VERSION = "2026-06-24-crawl-scheduling";

const globalForDb = globalThis as unknown as {
  knowledgePool?: Pool;
  schemaReady?: Promise<void>;
  schemaVersion?: string;
};

export function embeddingDimensions() {
  const configured = Number(process.env.EMBEDDING_DIMENSIONS || 0);
  if (Number.isInteger(configured) && configured > 0 && configured <= 4096) {
    return configured;
  }
  return DEFAULT_EMBEDDING_DIMENSIONS;
}

function getPool() {
  if (globalForDb.knowledgePool) return globalForDb.knowledgePool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "PostgreSQL is not configured. Add DATABASE_URL to your environment.",
    );
  }

  const pool = new Pool({
    connectionString,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });

  if (process.env.NODE_ENV !== "production") {
    globalForDb.knowledgePool = pool;
  }

  return pool;
}

export async function ensureSchema() {
  if (
    globalForDb.schemaReady &&
    globalForDb.schemaVersion === SCHEMA_VERSION
  ) {
    return globalForDb.schemaReady;
  }

  const dimensions = embeddingDimensions();
  globalForDb.schemaVersion = SCHEMA_VERSION;
  globalForDb.schemaReady = (async () => {
    const pool = getPool();
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resources (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        source_url TEXT,
        file_name TEXT,
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'processing',
        error TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        page_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        crawl_site BOOLEAN NOT NULL DEFAULT FALSE,
        max_pages INTEGER NOT NULL DEFAULT 1,
        crawl_status TEXT NOT NULL DEFAULT 'idle',
        crawl_error TEXT,
        crawl_interval_minutes INTEGER,
        last_crawled_at TIMESTAMPTZ,
        next_crawl_at TIMESTAMPTZ,
        last_content_change_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      ALTER TABLE resources
        ADD COLUMN IF NOT EXISTS page_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS content_hash TEXT,
        ADD COLUMN IF NOT EXISTS crawl_site BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS max_pages INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS crawl_status TEXT NOT NULL DEFAULT 'idle',
        ADD COLUMN IF NOT EXISTS crawl_error TEXT,
        ADD COLUMN IF NOT EXISTS crawl_interval_minutes INTEGER,
        ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS next_crawl_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_content_change_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS chunks (
        id UUID PRIMARY KEY,
        resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding vector(${dimensions}) NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_resource_id
        ON chunks(resource_id);

      CREATE INDEX IF NOT EXISTS idx_resources_status
        ON resources(status);

      CREATE INDEX IF NOT EXISTS idx_resources_next_crawl
        ON resources(next_crawl_at)
        WHERE type = 'url' AND crawl_interval_minutes IS NOT NULL;
    `);
  })().catch((error) => {
    globalForDb.schemaReady = undefined;
    globalForDb.schemaVersion = undefined;
    throw error;
  });

  return globalForDb.schemaReady;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
) {
  await ensureSchema();
  return getPool().query<T>(text, params);
}

export async function transaction<T>(
  callback: (client: Pick<Pool, "query">) => Promise<T>,
) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  page_count: number;
  crawl_site: boolean;
  max_pages: number;
  crawl_status: CrawlStatus;
  crawl_error: string | null;
  crawl_interval_minutes: number | null;
  last_crawled_at: Date | string | null;
  next_crawl_at: Date | string | null;
  last_content_change_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function asIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asNullableIso(value: Date | string | null) {
  return value ? asIso(value) : null;
}

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
    pageCount: row.page_count,
    crawlSite: row.crawl_site,
    maxPages: row.max_pages,
    crawlStatus: row.crawl_status,
    crawlError: row.crawl_error,
    crawlIntervalMinutes: row.crawl_interval_minutes,
    lastCrawledAt: asNullableIso(row.last_crawled_at),
    nextCrawlAt: asNullableIso(row.next_crawl_at),
    lastContentChangeAt: asNullableIso(row.last_content_change_at),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

export async function listResources(): Promise<Resource[]> {
  const result = await query<ResourceRow>(
    `SELECT id, name, type, source_url, file_name, status, error,
            chunk_count, page_count, crawl_site, max_pages, crawl_status,
            crawl_error, crawl_interval_minutes, last_crawled_at,
            next_crawl_at, last_content_change_at, created_at, updated_at
     FROM resources
     ORDER BY created_at DESC`,
  );

  return result.rows.map(mapResource);
}

export async function getReadyResourceCount() {
  const result = await query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM resources WHERE status = 'ready'",
  );
  return Number(result.rows[0]?.count || 0);
}

export function vectorLiteral(values: number[]) {
  return `[${values.map((value) => Number(value).toFixed(8)).join(",")}]`;
}
