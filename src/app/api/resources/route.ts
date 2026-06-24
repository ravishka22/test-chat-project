import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/auth";
import { listResources, query } from "@/lib/db";
import { ingestResource } from "@/lib/ingest";
import type { ResourceType } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

async function unauthorized() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

export async function GET() {
  if (!(await isAdminAuthenticated())) return unauthorized();
  return NextResponse.json({ resources: await listResources() });
}

function inferFileType(file: File): ResourceType | null {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf" || file.type === "application/pdf") return "pdf";
  if (
    extension === "docx" ||
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (["txt", "md", "markdown"].includes(extension || "")) return "text";
  if (file.type.startsWith("text/")) return "text";
  return null;
}

export async function POST(request: Request) {
  if (!(await isAdminAuthenticated())) return unauthorized();

  let resourceId: string | null = null;
  try {
    const formData = await request.formData();
    const mode = String(formData.get("mode") || "");
    const suppliedName = String(formData.get("name") || "").trim();
    const now = new Date().toISOString();
    resourceId = crypto.randomUUID();

    let type: ResourceType;
    let name = suppliedName;
    let sourceUrl: string | undefined;
    let fileName: string | undefined;
    let content: string | undefined;
    let fileBuffer: Buffer | undefined;
    let mimeType: string | undefined;
    let crawlSite = false;
    let maxPages = 5;
    let crawlIntervalMinutes: number | null = null;

    if (mode === "url") {
      type = "url";
      sourceUrl = String(formData.get("url") || "").trim();
      crawlSite = String(formData.get("crawlSite") || "") === "true";
      maxPages = Number(formData.get("maxPages") || 5);
      const requestedInterval = Number(
        formData.get("crawlIntervalMinutes") || 0,
      );
      crawlIntervalMinutes =
        Number.isInteger(requestedInterval) && requestedInterval >= 15
          ? Math.min(requestedInterval, 43_200)
          : null;
      if (!sourceUrl) throw new Error("A URL is required.");
      if (!name) {
        try {
          name = new URL(sourceUrl).hostname;
        } catch {
          name = "Web resource";
        }
      }
    } else if (mode === "text") {
      type = "text";
      content = String(formData.get("content") || "");
      if (!name) throw new Error("A title is required for manual text.");
    } else if (mode === "file") {
      const file = formData.get("file");
      if (!(file instanceof File) || !file.size) {
        throw new Error("Choose a file to upload.");
      }
      const inferredType = inferFileType(file);
      if (!inferredType) {
        throw new Error("Supported files are PDF, DOCX, TXT, and Markdown.");
      }
      type = inferredType;
      fileName = file.name;
      mimeType = file.type;
      fileBuffer = Buffer.from(await file.arrayBuffer());
      name = name || file.name.replace(/\.[^.]+$/, "");
    } else {
      throw new Error("Choose a resource type.");
    }

    await query(
      `INSERT INTO resources
       (id, name, type, source_url, file_name, status, crawl_site, max_pages,
        crawl_interval_minutes, next_crawl_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7, $8,
         CASE WHEN $8::integer IS NULL THEN NULL
              ELSE $9::timestamptz + $8::integer * INTERVAL '1 minute' END,
         $9, $10)`,
      [
        resourceId,
        name,
        type,
        sourceUrl || null,
        fileName || null,
        crawlSite,
        crawlSite ? Math.max(1, Math.min(maxPages || 5, 1000)) : 1,
        crawlIntervalMinutes,
        now,
        now,
      ],
    );

    try {
      await ingestResource({
        id: resourceId,
        name,
        type,
        sourceUrl,
        fileName,
        content,
        fileBuffer,
        mimeType,
        crawlSite,
        maxPages,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Resource processing failed.";
      await query(
        `UPDATE resources
         SET status = 'failed', error = $1, crawl_status = 'failed',
             crawl_error = $1, last_crawled_at = CASE
               WHEN type = 'url' THEN $2
               ELSE last_crawled_at
             END,
             next_crawl_at = CASE
               WHEN crawl_interval_minutes IS NULL THEN NULL
               ELSE $2 + crawl_interval_minutes * INTERVAL '1 minute'
             END,
             updated_at = $2
         WHERE id = $3`,
        [message, new Date(), resourceId],
      );
      throw error;
    }

    const resources = await listResources();
    return NextResponse.json(
      { resource: resources.find((resource) => resource.id === resourceId) },
      { status: 201 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not add the resource.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
