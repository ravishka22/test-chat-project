import { NextResponse } from "next/server";
import { z } from "zod";
import { getReadyResourceCount } from "@/lib/db";
import { generateGroundedAnswer } from "@/lib/ai";
import { retrieveRelevantChunks } from "@/lib/retrieval";
import type { Source } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(8000),
      }),
    )
    .min(1)
    .max(30),
});

const rateLimit = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  const key = forwarded?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const entry = rateLimit.get(key);

  if (!entry || entry.resetAt < now) {
    rateLimit.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }

  entry.count += 1;
  return entry.count > 20;
}

export async function POST(request: Request) {
  if (isRateLimited(request)) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429 },
    );
  }

  try {
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Send a valid question." },
        { status: 400 },
      );
    }

    const readyCount = await getReadyResourceCount();

    if (!readyCount) {
      return NextResponse.json({
        title: "The knowledge base is not ready yet",
        body:
          "The knowledge base is empty. An administrator needs to add at least one resource before I can answer questions.",
        answer:
          "The knowledge base is empty. An administrator needs to add at least one resource before I can answer questions.",
        suggestions: ["Add university details", "Add program details"],
        sources: [],
      });
    }

    const messages = parsed.data.messages;
    const question = messages.at(-1)!.content;
    const chunks = await retrieveRelevantChunks(question);
    const context = chunks
      .map(
        (chunk, index) =>
          `[${index + 1}] ${chunk.resourceName}\n${chunk.content}`,
      )
      .join("\n\n");
    const history = messages
      .slice(-9, -1)
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");

    const answer = await generateGroundedAnswer({
      question,
      history,
      context,
    });
    const sources: Source[] = chunks.map((chunk) => ({
      id: chunk.id,
      name: chunk.resourceName,
      type: chunk.resourceType,
      url: chunk.sourceUrl,
      excerpt:
        chunk.content.length > 220
          ? `${chunk.content.slice(0, 217).trim()}...`
          : chunk.content,
      score: chunk.score,
    }));

    return NextResponse.json({
      title: answer.title,
      body: answer.body,
      answer: `## ${answer.title}\n\n${answer.body}`,
      suggestions: answer.suggestions,
      sources,
    });
  } catch (error) {
    console.error(error);
    const message =
      error instanceof Error && error.message.includes("not configured")
        ? error.message
        : "I could not answer that right now. Please try again.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
