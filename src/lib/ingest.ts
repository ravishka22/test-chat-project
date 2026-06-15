import * as cheerio from "cheerio";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { chunkText, normalizeText } from "@/lib/chunk";
import { db } from "@/lib/db";
import { embedDocuments } from "@/lib/gemini";
import { assertSafePublicUrl } from "@/lib/url-security";
import type { ResourceType } from "@/lib/types";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_URL_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;

export interface IngestInput {
  id: string;
  name: string;
  type: ResourceType;
  sourceUrl?: string;
  fileName?: string;
  content?: string;
  fileBuffer?: Buffer;
  mimeType?: string;
}

function validateExtractedText(text: string) {
  const normalized = normalizeText(text);
  if (normalized.length < 20) {
    throw new Error("The resource did not contain enough readable text.");
  }
  return normalized;
}

async function fetchPublicPage(rawUrl: string) {
  let currentUrl = await assertSafePublicUrl(rawUrl);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
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
      throw new Error("The URL content is larger than 5 MB.");
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_URL_BYTES) {
      throw new Error("The URL content is larger than 5 MB.");
    }

    const contentType = response.headers.get("content-type") || "";
    const body = buffer.toString("utf8");
    if (contentType.includes("text/plain")) {
      return {
        title: currentUrl.hostname,
        text: validateExtractedText(body),
        finalUrl: currentUrl.toString(),
      };
    }

    const $ = cheerio.load(body);
    $("script, style, nav, footer, header, form, svg, noscript, iframe").remove();
    const title =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("title").first().text().trim() ||
      currentUrl.hostname;
    const main = $("article").first().text() || $("main").first().text() || $("body").text();

    return {
      title,
      text: validateExtractedText(main),
      finalUrl: currentUrl.toString(),
    };
  }

  throw new Error("The URL redirected too many times.");
}

async function extractFileText(input: IngestInput) {
  if (!input.fileBuffer) throw new Error("No file was uploaded.");
  if (input.fileBuffer.length > MAX_FILE_BYTES) {
    throw new Error("Files must be 10 MB or smaller.");
  }

  if (input.type === "pdf") {
    const result = await pdfParse(input.fileBuffer);
    return validateExtractedText(result.text);
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
    const page = await fetchPublicPage(input.sourceUrl);
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
  if (chunks.length > 250) {
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

  const now = new Date().toISOString();
  const save = db.transaction(() => {
    db.prepare("DELETE FROM chunks WHERE resource_id = ?").run(input.id);
    const insertChunk = db.prepare(
      `INSERT INTO chunks (id, resource_id, chunk_index, content, embedding)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (const chunk of embeddedChunks) {
      insertChunk.run(
        chunk.id,
        input.id,
        chunk.index,
        chunk.content,
        JSON.stringify(chunk.embedding),
      );
    }

    db.prepare(
      `UPDATE resources
       SET name = ?, source_url = ?, content = ?, status = 'ready',
           error = NULL, chunk_count = ?, updated_at = ?
       WHERE id = ?`,
    ).run(title, sourceUrl, text, embeddedChunks.length, now, input.id);
  });

  save();
}
