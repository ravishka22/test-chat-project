import { CheerioCrawler, log } from "crawlee";
import * as cheerio from "cheerio";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { embedDocuments } from "@/lib/ai";
import { chunkText, normalizeText } from "@/lib/chunk";
import { query, transaction, vectorLiteral } from "@/lib/db";
import { assertSafePublicUrl } from "@/lib/url-security";
import type { ResourceType } from "@/lib/types";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_URL_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const MAX_CRAWL_PAGES = 25;

type CheerioSelector = (selector: string) => {
  attr(name: string): string | undefined;
  first(): { text(): string };
  text(): string;
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
      };
    }

    const page = extractReadableText(body, currentUrl.hostname);
    return {
      title: page.title,
      text: page.text,
      finalUrl: currentUrl.toString(),
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
    throw new Error("The crawler did not find enough readable text.");
  }

  return {
    title: pages[0].title,
    finalUrl: startUrl.toString(),
    text: validateExtractedText(
      pages
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
  let text: string;

  if (input.type === "url") {
    if (!input.sourceUrl) throw new Error("A URL is required.");
    const page = input.crawlSite
      ? await crawlPublicSite(input.sourceUrl, input.maxPages || 5)
      : await fetchPublicPage(input.sourceUrl);
    title = input.name || page.title;
    sourceUrl = page.finalUrl;
    text = page.text;
  } else if (input.type === "text") {
    text = validateExtractedText(input.content || "");
  } else {
    text = await extractFileText(input);
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

  const now = new Date();
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
           error = NULL, chunk_count = $4, updated_at = $5
       WHERE id = $6`,
      [title, sourceUrl, text, embeddedChunks.length, now, input.id],
    );
  });
}
