import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isAdminAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id } = await params;
  const result = db.prepare("DELETE FROM resources WHERE id = ?").run(id);
  if (!result.changes) {
    return NextResponse.json({ error: "Resource not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
