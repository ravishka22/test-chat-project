import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  getAdminSessionToken,
  isValidAdminPassword,
} from "@/lib/auth";

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD) {
    return NextResponse.json(
      { error: "Set ADMIN_PASSWORD in your environment before signing in." },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    password?: string;
  } | null;

  if (!body?.password || !isValidAdminPassword(body.password)) {
    return NextResponse.json(
      { error: "The password is incorrect." },
      { status: 401 },
    );
  }

  const token = getAdminSessionToken();
  const requestUrl = new URL(request.url);
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, token!, {
    httpOnly: true,
    sameSite: "strict",
    secure:
      requestUrl.protocol === "https:" ||
      forwardedProtocol?.split(",")[0]?.trim() === "https",
    maxAge: 60 * 60 * 12,
    path: "/",
  });
  return response;
}
