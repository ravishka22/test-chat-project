import { listResources, query } from "@/lib/db";
import { ingestResource } from "@/lib/ingest";
import type { Resource } from "@/lib/types";

const SCHEDULER_INTERVAL_MS = 60_000;

const globalForScheduler = globalThis as unknown as {
  crawlSchedulerTimer?: NodeJS.Timeout;
  crawlSchedulerRunning?: boolean;
};

type CrawlResourceRow = {
  id: string;
  name: string;
  source_url: string;
  crawl_site: boolean;
  max_pages: number;
};

async function claimResource(id: string) {
  const result = await query<CrawlResourceRow>(
    `UPDATE resources
     SET crawl_status = 'crawling', crawl_error = NULL
     WHERE id = $1 AND type = 'url' AND status = 'ready'
       AND crawl_status <> 'crawling'
     RETURNING id, name, source_url, crawl_site, max_pages`,
    [id],
  );
  return result.rows[0] || null;
}

export async function recrawlResource(id: string) {
  const resource = await claimResource(id);
  if (!resource) {
    throw new Error("This website is already crawling or is not ready.");
  }

  try {
    const result = await ingestResource({
      id: resource.id,
      name: resource.name,
      type: "url",
      sourceUrl: resource.source_url,
      crawlSite: resource.crawl_site,
      maxPages: resource.max_pages,
    });
    const resources = await listResources();
    return {
      resource: resources.find((item) => item.id === id) || null,
      changed: result.changed,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Website crawl failed.";
    const now = new Date();
    await query(
      `UPDATE resources
       SET crawl_status = 'failed', crawl_error = $1, last_crawled_at = $2,
           next_crawl_at = CASE
             WHEN crawl_interval_minutes IS NULL THEN NULL
             ELSE $2 + crawl_interval_minutes * INTERVAL '1 minute'
           END,
           updated_at = $2
       WHERE id = $3`,
      [message, now, id],
    );
    throw error;
  }
}

export async function processDueCrawls(limit = 1) {
  const due = await query<{ id: string }>(
    `SELECT id
     FROM resources
     WHERE type = 'url' AND status = 'ready'
       AND crawl_interval_minutes IS NOT NULL
       AND next_crawl_at IS NOT NULL AND next_crawl_at <= NOW()
       AND crawl_status <> 'crawling'
     ORDER BY next_crawl_at ASC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 10))],
  );

  const results: Array<{ id: string; changed: boolean; error?: string }> = [];
  for (const row of due.rows) {
    try {
      const result = await recrawlResource(row.id);
      results.push({ id: row.id, changed: result.changed });
    } catch (error) {
      results.push({
        id: row.id,
        changed: false,
        error: error instanceof Error ? error.message : "Crawl failed.",
      });
    }
  }
  return results;
}

async function schedulerTick() {
  if (globalForScheduler.crawlSchedulerRunning) return;
  globalForScheduler.crawlSchedulerRunning = true;
  try {
    await processDueCrawls();
  } catch (error) {
    console.error("Automatic website crawl failed:", error);
  } finally {
    globalForScheduler.crawlSchedulerRunning = false;
  }
}

export function startCrawlScheduler() {
  if (globalForScheduler.crawlSchedulerTimer) return;
  const timer = setInterval(() => void schedulerTick(), SCHEDULER_INTERVAL_MS);
  timer.unref();
  globalForScheduler.crawlSchedulerTimer = timer;
  setTimeout(() => void schedulerTick(), 10_000).unref();
}

export async function updateCrawlSettings(
  id: string,
  settings: {
    crawlSite: boolean;
    maxPages: number;
    crawlIntervalMinutes: number | null;
  },
): Promise<Resource | null> {
  const now = new Date();
  const result = await query(
    `UPDATE resources
     SET crawl_site = $1, max_pages = $2, crawl_interval_minutes = $3,
         next_crawl_at = CASE
           WHEN $3::integer IS NULL THEN NULL
           ELSE $4::timestamptz + $3::integer * INTERVAL '1 minute'
         END,
         updated_at = $4
     WHERE id = $5 AND type = 'url'`,
    [
      settings.crawlSite,
      settings.crawlSite ? settings.maxPages : 1,
      settings.crawlIntervalMinutes,
      now,
      id,
    ],
  );
  if (!result.rowCount) return null;
  const resources = await listResources();
  return resources.find((resource) => resource.id === id) || null;
}
