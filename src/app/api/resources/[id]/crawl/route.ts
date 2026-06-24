import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/auth";
import {
  recrawlResource,
  updateCrawlSettings,
} from "@/lib/crawl-scheduler";

export const runtime = "nodejs";
export const maxDuration = 300;

async function unauthorized() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAdminAuthenticated())) return unauthorized();
  const { id } = await params;

  try {
    const result = await recrawlResource(id);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Website crawl failed.",
      },
      { status: 400 },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAdminAuthenticated())) return unauthorized();
  const { id } = await params;
  const body = (await request.json()) as {
    crawlSite?: boolean;
    maxPages?: number;
    crawlIntervalMinutes?: number | null;
  };
  const maxPages = Math.max(1, Math.min(Number(body.maxPages) || 1, 1000));
  const requestedInterval = Number(body.crawlIntervalMinutes || 0);
  const crawlIntervalMinutes =
    Number.isInteger(requestedInterval) && requestedInterval >= 15
      ? Math.min(requestedInterval, 43_200)
      : null;

  const resource = await updateCrawlSettings(id, {
    crawlSite: Boolean(body.crawlSite),
    maxPages,
    crawlIntervalMinutes,
  });
  if (!resource) {
    return NextResponse.json({ error: "Website not found." }, { status: 404 });
  }
  return NextResponse.json({ resource });
}
