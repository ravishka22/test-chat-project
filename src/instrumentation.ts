export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCrawlScheduler } = await import("@/lib/crawl-scheduler");
    startCrawlScheduler();
  }
}
