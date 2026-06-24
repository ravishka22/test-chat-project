import crypto from "node:crypto";
import { CheerioCrawler, log } from "crawlee";
import * as cheerio from "cheerio";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import type { Browser, BrowserContext } from "playwright";
import { embedDocuments } from "@/lib/ai";
import { chunkText, normalizeText } from "@/lib/chunk";
import { query, transaction, vectorLiteral } from "@/lib/db";
import { assertSafePublicUrl } from "@/lib/url-security";
import type { ResourceType } from "@/lib/types";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_URL_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 100;
const MAX_CRAWL_PAGES = 1000;

type CheerioSelector = (selector: string) => {
  attr(name: string): string | undefined;
  first(): { text(): string };
  length: number;
  text(): string;
};

type PageTextResult = {
  title: string;
  text: string;
  finalUrl: string;
  pageCount: number;
};

type RenderedPageResult = PageTextResult & {
  links: string[];
};

export interface IngestInput {
  id: string;
  name: string;
  type: ResourceType;
  sourceUrl?: string;
  fileName?: string;
  content?: string;
  fileBuffer?: Buffer;
  mimeType?: string;
  crawlSite?: boolean;
  maxPages?: number;
}

function validateExtractedText(text: string) {
  const normalized = normalizeText(text);
  if (normalized.length < 20) {
    throw new Error("The resource did not contain enough readable text.");
  }
  return normalized;
}

function decodeResponseBody(buffer: Buffer, contentType: string) {
  const charset = contentType.match(/charset=([^;]+)/i)?.[1]?.trim();
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function filenameTitle(url: URL) {
  const lastSegment = url.pathname.split("/").filter(Boolean).pop();
  if (!lastSegment) return url.hostname;
  return decodeURIComponent(lastSegment).replace(/\.[^.]+$/, "") || url.hostname;
}

function bestReadableText($: CheerioSelector) {
  return [
    $("article").first().text(),
    $("main").first().text(),
    $('[role="main"]').first().text(),
    $("#content").first().text(),
    $(".content").first().text(),
    $(".post-content").first().text(),
    $(".entry-content").first().text(),
    $("body").text(),
    $('meta[name="description"]').attr("content") || "",
    $('meta[property="og:description"]').attr("content") || "",
  ]
    .map(normalizeText)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || "";
}

function extractReadableText(html: string, fallbackTitle: string) {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, form, svg, noscript, iframe").remove();

  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").first().text().trim() ||
    fallbackTitle;

  return { title, text: validateExtractedText(bestReadableText($)) };
}

function isJavascriptAppShell(html: string) {
  const $ = cheerio.load(html);
  const bodyText = normalizeText($("body").text());
  return (
    bodyText.length < 120 &&
    $("#root, #app").length > 0 &&
    $('script[type="module"], script[src]').length > 0
  );
}

function javascriptRenderedPageError(url: URL) {
  return new Error(
    `The page at ${url.hostname} is rendered by JavaScript, but the browser renderer could not extract enough readable text.`,
  );
}

function playwrightInstallError(error: unknown) {
  if (!(error instanceof Error)) return null;
  if (
    /Executable doesn't exist|playwright install|browserType\.launch/i.test(
      error.message,
    )
  ) {
    return new Error(
      "JavaScript-rendered crawling requires the Playwright Chromium browser. Run `npx playwright install chromium`, then try again.",
    );
  }

  return null;
}

function createSafeBrowserRequestGuard() {
  const cache = new Map<string, Promise<boolean>>();

  return async function isSafeBrowserRequest(rawUrl: string) {
    if (
      rawUrl === "about:blank" ||
      rawUrl.startsWith("data:") ||
      rawUrl.startsWith("blob:")
    ) {
      return true;
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }

    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.username || url.password) return false;

    const key = url.origin;
    if (!cache.has(key)) {
      cache.set(
        key,
        assertSafePublicUrl(key)
          .then(() => true)
          .catch(() => false),
      );
    }

    return cache.get(key)!;
  };
}

async function withChromium<T>(
  callback: (browser: Browser) => Promise<T>,
): Promise<T> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      return await callback(browser);
    } finally {
      await browser.close();
    }
  } catch (error) {
    throw playwrightInstallError(error) || error;
  }
}

async function createBrowserContext(browser: Browser) {
  const context = await browser.newContext({
    userAgent: "AtlasKnowledgeBot/1.0",
    viewport: { width: 1280, height: 900 },
  });
  const isSafeBrowserRequest = createSafeBrowserRequestGuard();

  await context.route("**/*", async (route) => {
    if (await isSafeBrowserRequest(route.request().url())) {
      await route.continue();
    } else {
      await route.abort();
    }
  });

  return context;
}

async function renderPublicPage(
  context: BrowserContext,
  rawUrl: string,
): Promise<RenderedPageResult> {
  const targetUrl = await assertSafePublicUrl(rawUrl);
  const page = await context.newPage();

  try {
    const response = await page.goto(targetUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    if (response && !response.ok()) {
      throw new Error(`The URL returned HTTP ${response.status()}.`);
    }

    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
      // Some modern sites keep analytics or live requests open. DOM text is
      // still usable after the additional settling delay below.
    });
    await page.waitForTimeout(1_500);

    const finalUrl = await assertSafePublicUrl(page.url());
    const html = await page.content();
    if (Buffer.byteLength(html, "utf8") > MAX_URL_BYTES) {
      throw new Error("The rendered URL content is larger than 10 MB.");
    }

    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "");
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, form, svg, noscript, iframe").remove();

    const title =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("title").first().text().trim() ||
      finalUrl.hostname;
    const text = validateExtractedText(bestReadableText($) || bodyText);
    const links = await page.$$eval("a[href]", (anchors) =>
      anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
    );

    return {
      title,
      text,
      finalUrl: finalUrl.toString(),
      pageCount: 1,
      links,
    };
  } finally {
    await page.close();
  }
}

async function fetchRenderedPage(rawUrl: string): Promise<PageTextResult> {
  return withChromium(async (browser) => {
    const context = await createBrowserContext(browser);
    try {
      const page = await renderPublicPage(context, rawUrl);
      return {
        title: page.title,
        text: page.text,
        finalUrl: page.finalUrl,
        pageCount: 1,
      };
    } finally {
      await context.close();
    }
  });
}

async function fetchPublicPage(rawUrl: string) {
  let currentUrl = await assertSafePublicUrl(rawUrl);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "User-Agent": "AtlasKnowledgeBot/1.0",
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The URL returned an invalid redirect.");
      currentUrl = await assertSafePublicUrl(
        new URL(location, currentUrl).toString(),
      );
      continue;
    }

    if (!response.ok) {
      throw new Error(`The URL returned HTTP ${response.status}.`);
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_URL_BYTES) {
      throw new Error("The URL content is larger than 10 MB.");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_URL_BYTES) {
      throw new Error("The URL content is larger than 10 MB.");
    }

    const contentType = response.headers.get("content-type") || "";
    const lowerContentType = contentType.toLowerCase();

    if (
      lowerContentType.includes("application/pdf") ||
      currentUrl.pathname.toLowerCase().endsWith(".pdf")
    ) {
      const result = await pdfParse(buffer);
      return {
        title: filenameTitle(currentUrl),
        text: validateExtractedText(result.text.replace(/\0/g, "")),
        finalUrl: currentUrl.toString(),
        pageCount: 1,
      };
    }

    if (
      contentType &&
      !lowerContentType.includes("text/html") &&
      !lowerContentType.includes("text/plain") &&
      !lowerContentType.includes("application/xhtml+xml")
    ) {
      throw new Error("The URL did not point to readable HTML, text, or PDF content.");
    }

    const body = decodeResponseBody(buffer, contentType);
    if (lowerContentType.includes("text/plain")) {
      return {
        title: filenameTitle(currentUrl),
        text: validateExtractedText(body),
        finalUrl: currentUrl.toString(),
        pageCount: 1,
      };
    }

    if (isJavascriptAppShell(body)) {
      return fetchRenderedPage(currentUrl.toString());
    }

    const page = extractReadableText(body, currentUrl.hostname);
    return {
      title: page.title,
      text: page.text,
      finalUrl: currentUrl.toString(),
      pageCount: 1,
    };
  }

  throw new Error("The URL redirected too many times.");
}

async function crawlPublicSite(rawUrl: string, maxPages: number) {
  const startUrl = await assertSafePublicUrl(rawUrl);
  const pageLimit = Math.max(1, Math.min(maxPages || 5, MAX_CRAWL_PAGES));
  const origin = startUrl.origin;
  const pages: Array<{ url: string; title: string; text: string }> = [];

  log.setLevel(log.LEVELS.ERROR);

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: pageLimit,
    maxRequestRetries: 1,
    requestHandlerTimeoutSecs: 45,
    preNavigationHooks: [
      async ({ request }) => {
        const url = await assertSafePublicUrl(request.url);
        if (url.origin !== origin) {
          throw new Error("Crawler attempted to leave the starting website.");
        }
      },
    ],
    async requestHandler({ request, $, enqueueLinks }) {
      const url = await assertSafePublicUrl(request.loadedUrl || request.url);
      if (url.origin !== origin) return;

      $("script, style, nav, footer, header, form, svg, noscript, iframe").remove();
      const title =
        $('meta[property="og:title"]').attr("content")?.trim() ||
        $("title").first().text().trim() ||
        url.hostname;
      const text = bestReadableText($);

      if (text.length >= 20) {
        pages.push({ url: url.toString(), title, text });
      }

      if (pages.length < pageLimit) {
        await enqueueLinks({
          strategy: "same-domain",
          transformRequestFunction: (requestOptions) => {
            try {
              const nextUrl = new URL(requestOptions.url);
              if (nextUrl.origin !== origin) return false;
              nextUrl.hash = "";
              requestOptions.url = nextUrl.toString();
              return requestOptions;
            } catch {
              return false;
            }
          },
        });
      }
    },
  });

  await crawler.run([startUrl.toString()]);

  if (!pages.length) {
    return crawlRenderedPublicSite(startUrl.toString(), pageLimit);
  }

  const orderedPages = [...pages].sort((a, b) => a.url.localeCompare(b.url));
  return {
    title: pages[0].title,
    finalUrl: startUrl.toString(),
    pageCount: pages.length,
    text: validateExtractedText(
      orderedPages
        .map((page, index) => `Page ${index + 1}: ${page.title}\nURL: ${page.url}\n${page.text}`)
        .join("\n\n"),
    ),
  };
}

async function crawlRenderedPublicSite(rawUrl: string, maxPages: number) {
  const startUrl = await assertSafePublicUrl(rawUrl);
  const pageLimit = Math.max(1, Math.min(maxPages || 5, MAX_CRAWL_PAGES));
  const origin = startUrl.origin;
  const pages: Array<{ url: string; title: string; text: string }> = [];

  await withChromium(async (browser) => {
    const context = await createBrowserContext(browser);
    const queue = [startUrl.toString()];
    const visited = new Set<string>();

    try {
      while (queue.length && pages.length < pageLimit) {
        const next = queue.shift()!;
        let url: URL;
        try {
          url = await assertSafePublicUrl(next);
        } catch {
          continue;
        }

        url.hash = "";
        const normalizedUrl = url.toString();
        if (url.origin !== origin || visited.has(normalizedUrl)) continue;
        visited.add(normalizedUrl);

        let rendered: RenderedPageResult;
        try {
          rendered = await renderPublicPage(context, normalizedUrl);
        } catch {
          continue;
        }

        pages.push({
          url: rendered.finalUrl,
          title: rendered.title,
          text: rendered.text,
        });

        for (const link of rendered.links) {
          if (visited.size + queue.length >= pageLimit * 3) break;
          try {
            const linkUrl = await assertSafePublicUrl(link);
            if (linkUrl.origin !== origin) continue;
            linkUrl.hash = "";
            const normalizedLink = linkUrl.toString();
            if (
              !visited.has(normalizedLink) &&
              !queue.includes(normalizedLink)
            ) {
              queue.push(normalizedLink);
            }
          } catch {
            // Ignore unsafe, malformed, or private links discovered in-page.
          }
        }
      }
    } finally {
      await context.close();
    }
  });

  if (!pages.length) {
    throw javascriptRenderedPageError(startUrl);
  }

  const orderedPages = [...pages].sort((a, b) => a.url.localeCompare(b.url));
  return {
    title: pages[0].title,
    finalUrl: startUrl.toString(),
    pageCount: pages.length,
    text: validateExtractedText(
      orderedPages
        .slice(0, pageLimit)
        .map((page, index) => `Page ${index + 1}: ${page.title}\nURL: ${page.url}\n${page.text}`)
        .join("\n\n"),
    ),
  };
}

async function extractFileText(input: IngestInput) {
  if (!input.fileBuffer) throw new Error("No file was uploaded.");
  if (input.fileBuffer.length > MAX_FILE_BYTES) {
    throw new Error("Files must be 10 MB or smaller.");
  }

  if (input.type === "pdf") {
    const result = await pdfParse(input.fileBuffer);
    return validateExtractedText(result.text.replace(/\0/g, ""));
  }

  if (input.type === "docx") {
    const result = await mammoth.extractRawText({ buffer: input.fileBuffer });
    return validateExtractedText(result.value);
  }

  return validateExtractedText(input.fileBuffer.toString("utf8"));
}

export async function ingestResource(input: IngestInput) {
  let title = input.name;
  let sourceUrl = input.sourceUrl || null;
  let pageCount = 0;
  let text: string;

  if (input.type === "url") {
    if (!input.sourceUrl) throw new Error("A URL is required.");
    const page = input.crawlSite
      ? await crawlPublicSite(input.sourceUrl, input.maxPages || 5)
      : await fetchPublicPage(input.sourceUrl);
    title = input.name || page.title;
    sourceUrl = page.finalUrl;
    pageCount = page.pageCount;
    text = page.text;
  } else if (input.type === "text") {
    text = validateExtractedText(input.content || "");
  } else {
    text = await extractFileText(input);
  }

  const contentHash = crypto.createHash("sha256").update(text).digest("hex");
  const existing = await query<{ content_hash: string | null }>(
    "SELECT content_hash FROM resources WHERE id = $1",
    [input.id],
  );
  const unchanged =
    Boolean(existing.rows[0]?.content_hash) &&
    existing.rows[0]?.content_hash === contentHash;
  const now = new Date();

  if (unchanged) {
    await query(
      `UPDATE resources
       SET name = $1, source_url = $2, status = 'ready', error = NULL,
           page_count = $3, crawl_status = 'idle', crawl_error = NULL,
           last_crawled_at = $4, updated_at = $4,
           next_crawl_at = CASE
             WHEN crawl_interval_minutes IS NULL THEN NULL
             ELSE $4 + crawl_interval_minutes * INTERVAL '1 minute'
           END
       WHERE id = $5`,
      [title, sourceUrl, pageCount, now, input.id],
    );
    return { changed: false, pageCount };
  }

  const chunks = chunkText(text);
  if (!chunks.length) throw new Error("No searchable text could be extracted.");
  if (chunks.length > 500) {
    throw new Error("This resource is too large. Split it into smaller files.");
  }

  const embeddedChunks: Array<{
    id: string;
    index: number;
    content: string;
    embedding: number[];
  }> = [];

  const batchSize = 16;
  for (let startIndex = 0; startIndex < chunks.length; startIndex += batchSize) {
    const batch = chunks.slice(startIndex, startIndex + batchSize);
    const embeddings = await embedDocuments(
      batch.map((content) => ({ content, title })),
    );

    for (let offset = 0; offset < batch.length; offset += 1) {
      embeddedChunks.push({
        id: crypto.randomUUID(),
        index: startIndex + offset,
        content: batch[offset],
        embedding: embeddings[offset],
      });
    }
  }

  await transaction(async (client) => {
    await client.query("DELETE FROM chunks WHERE resource_id = $1", [input.id]);

    for (const chunk of embeddedChunks) {
      await client.query(
        `INSERT INTO chunks (id, resource_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [
          chunk.id,
          input.id,
          chunk.index,
          chunk.content,
          vectorLiteral(chunk.embedding),
        ],
      );
    }

    await client.query(
      `UPDATE resources
       SET name = $1, source_url = $2, content = $3, status = 'ready',
           error = NULL, chunk_count = $4, page_count = $5,
           content_hash = $6, crawl_status = 'idle', crawl_error = NULL,
           last_crawled_at = CASE WHEN type = 'url' THEN $7 ELSE last_crawled_at END,
           last_content_change_at = CASE
             WHEN type = 'url' THEN $7
             ELSE last_content_change_at
           END,
           next_crawl_at = CASE
             WHEN type <> 'url' OR crawl_interval_minutes IS NULL THEN NULL
             ELSE $7 + crawl_interval_minutes * INTERVAL '1 minute'
           END,
           updated_at = $7
       WHERE id = $8`,
      [
        title,
        sourceUrl,
        text,
        embeddedChunks.length,
        pageCount,
        contentHash,
        now,
        input.id,
      ],
    );
  });

  return { changed: true, pageCount };
}
