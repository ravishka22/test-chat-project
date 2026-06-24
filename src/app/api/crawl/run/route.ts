import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/auth";
import { processDueCrawls } from "@/lib/crawl-scheduler";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const cronSecret = process.env.CRAWL_CRON_SECRET;
  const bearer = request.headers.get("authorization");
  const cronAuthorized =
    Boolean(cronSecret) && bearer === `Bearer ${cronSecret}`;
  if (!cronAuthorized && !(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const results = await processDueCrawls(3);
  return NextResponse.json({ processed: results.length, results });
}
