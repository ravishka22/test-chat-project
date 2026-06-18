import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/auth";
import { listResources, query } from "@/lib/db";
import { ingestResource } from "@/lib/ingest";
import type { ResourceType } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

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

    if (mode === "url") {
      type = "url";
      sourceUrl = String(formData.get("url") || "").trim();
      crawlSite = String(formData.get("crawlSite") || "") === "true";
      maxPages = Number(formData.get("maxPages") || 5);
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
       (id, name, type, source_url, file_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7)`,
      [resourceId, name, type, sourceUrl || null, fileName || null, now, now],
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
         SET status = 'failed', error = $1, updated_at = $2
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
