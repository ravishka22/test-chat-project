const EMBEDDING_BATCH_RETRIES = 3;

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CoordinatorAnswer = {
  title: string;
  body: string;
  suggestions: string[];
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /429|rate limit|quota|fetch failed|connect timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|503|502/i.test(
    error.message,
  );
}

async function withRetry<T>(operation: () => Promise<T>) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= EMBEDDING_BATCH_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === EMBEDDING_BATCH_RETRIES) {
        throw error;
      }
      await sleep(500 * 2 ** attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("The model provider failed.");
}

function ollamaBaseUrl() {
  return (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(
    /\/$/,
    "",
  );
}

function ollamaBaseUrlFallback(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      return url.toString().replace(/\/$/, "");
    }
    if (url.hostname === "127.0.0.1") {
      url.hostname = "localhost";
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    return null;
  }

  return null;
}

function embeddingModel() {
  return process.env.EMBEDDING_MODEL || "qwen3-embedding:0.6b";
}

function queryInstruction(query: string) {
  return `Instruct: Given a user question, retrieve relevant knowledge base passages that answer the question.\nQuery: ${query}`;
}

async function callOllamaEmbed(input: string | string[]) {
  const baseUrl = ollamaBaseUrl();
  const fallbackBaseUrl = ollamaBaseUrlFallback(baseUrl);
  const model = embeddingModel();
  let response: Response;

  try {
    response = await fetchOllamaEmbedding(baseUrl, model, input);
  } catch (error) {
    if (fallbackBaseUrl) {
      try {
        response = await fetchOllamaEmbedding(fallbackBaseUrl, model, input);
      } catch (fallbackError) {
        const detail =
          fallbackError instanceof Error ? ` ${fallbackError.message}` : "";
        throw new Error(
          `Could not reach Ollama at ${baseUrl} or ${fallbackBaseUrl}. Start Ollama and make sure the ${model} model is installed.${detail}`,
        );
      }
    } else {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      throw new Error(
        `Could not reach Ollama at ${baseUrl}. Start Ollama and make sure the ${model} model is installed.${detail}`,
      );
    }
  }

  const data = (await response.json().catch(() => null)) as
    | { embeddings?: number[][]; error?: string }
    | null;

  if (!response.ok) {
    throw new Error(
      data?.error ||
        `Ollama embedding request failed with HTTP ${response.status}.`,
    );
  }

  if (!data?.embeddings?.length) {
    throw new Error(
      `Ollama returned an empty embedding for ${model}. Make sure the model supports /api/embed.`,
    );
  }

  return data.embeddings;
}

async function fetchOllamaEmbedding(
  baseUrl: string,
  model: string,
  input: string | string[],
) {
  return fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model,
      input,
    }),
  });
}

export async function embedDocuments(
  documents: Array<{ content: string; title: string }>,
): Promise<number[][]> {
  if (!documents.length) return [];

  const inputs = documents.map(({ content, title }) =>
    title ? `title: ${title}\ntext: ${content}` : content,
  );
  const embeddings = await withRetry(() => callOllamaEmbed(inputs));
  if (embeddings.length !== documents.length) {
    const midpoint = Math.ceil(documents.length / 2);
    return [
      ...(await embedDocuments(documents.slice(0, midpoint))),
      ...(await embedDocuments(documents.slice(midpoint))),
    ];
  }

  return embeddings;
}

export async function embedQuery(query: string) {
  const embeddings = await withRetry(() => callOllamaEmbed(queryInstruction(query)));
  return embeddings[0];
}

function chatBaseUrl() {
  return (
    process.env.CHAT_BASE_URL || "https://openrouter.ai/api/v1"
  ).replace(/\/$/, "");
}

function chatModel() {
  return process.env.CHAT_MODEL || "openai/gpt-oss-120b:free";
}

function chatApiKey() {
  return process.env.CHAT_API_KEY || process.env.OPENROUTER_API_KEY || "";
}

async function callOpenAiCompatibleChat(messages: ChatMessage[]) {
  const baseUrl = chatBaseUrl();
  const key = chatApiKey();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (key) headers.Authorization = `Bearer ${key}`;
  if (baseUrl.includes("openrouter.ai")) {
    if (!key) {
      throw new Error(
        "Chat is not configured. Add OPENROUTER_API_KEY or point CHAT_BASE_URL to a local OpenAI-compatible server.",
      );
    }
    headers["HTTP-Referer"] = process.env.APP_URL || "http://localhost:3000";
    headers["X-Title"] = "Atlas Knowledge Assistant";
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: chatModel(),
      messages,
      temperature: 0.2,
      max_tokens: 1200,
    }),
  });

  const data = (await response.json().catch(() => null)) as
    | {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string } | string;
      }
    | null;

  if (!response.ok) {
    const errorMessage =
      typeof data?.error === "string"
        ? data.error
        : data?.error?.message ||
          `Chat request failed with HTTP ${response.status}.`;
    throw new Error(errorMessage);
  }

  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("The chat model returned an empty answer.");
  }

  return content;
}

function parseCoordinatorAnswer(content: string): CoordinatorAnswer {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(cleaned) as Partial<CoordinatorAnswer>;
    const title = parsed.title?.trim();
    const body = parsed.body?.trim();
    if (title && body) {
      return {
        title,
        body,
        suggestions: Array.isArray(parsed.suggestions)
          ? parsed.suggestions
              .filter((suggestion): suggestion is string => typeof suggestion === "string")
              .map((suggestion) => suggestion.trim())
              .filter(Boolean)
              .slice(0, 4)
          : [],
      };
    }
  } catch {
    // Fall through to a resilient Markdown/text fallback.
  }

  const headingMatch = cleaned.match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*(?:\n|$)/);
  if (headingMatch) {
    const body = cleaned.slice(headingMatch[0].length).trim();
    return {
      title: headingMatch[1].trim(),
      body: body || cleaned,
      suggestions: [],
    };
  }

  return {
    title: "Here is what AES found for you",
    body: cleaned,
    suggestions: [],
  };
}

export async function generateGroundedAnswer({
  question,
  history,
  context,
}: {
  question: string;
  history: string;
  context: string;
}) {
  const content = await callOpenAiCompatibleChat([
    {
      role: "system",
      content: `You are an education coordinator from Academy of European Studies (AES), a Sri Lankan and UAE partner education agency for four main universities in Georgia: SEU, IBSU, ABMU, and East West.
Speak warmly, naturally, and helpfully, like a real coordinator guiding a student or parent.
Answer using only the supplied knowledge base excerpts for program, university, fee, admission, timeline, visa, and policy details.
When a claim comes from an excerpt, cite it with its bracketed number, for example [1].
If the excerpts do not contain the exact requested detail, say that AES does not have that exact detail in the current knowledge base, briefly share any related details that are available from the excerpts, and ask one or two focused follow-up questions to help guide the student using those related details.
Do not invent program facts, fees, policies, links, citations, or hidden reasoning.
Return only valid JSON with this exact shape:
{"title":"A warm title sentence for the large heading","body":"One friendly paragraph with the useful answer and citations where needed","suggestions":["short follow-up option 1","short follow-up option 2"]}
The title should sound human, for example: "Great choice. Here you have more details about Georgian National University SEU!"
The body should be concise and can use Markdown citations like [1], but it should read as a paragraph rather than a long report.
Suggestions should be simple button labels based on available related knowledge. Use 0 to 4 suggestions.`,
    },
    {
      role: "user",
      content: `KNOWLEDGE BASE EXCERPTS
${context}

RECENT CONVERSATION
${history || "No previous messages."}

CURRENT QUESTION
${question}`,
    },
  ]);

  return parseCoordinatorAnswer(content);
}
