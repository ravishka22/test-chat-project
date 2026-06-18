const EMBEDDING_BATCH_RETRIES = 3;

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
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

function embeddingModel() {
  return process.env.EMBEDDING_MODEL || "qwen3-embedding:0.6b";
}

function queryInstruction(query: string) {
  return `Instruct: Given a user question, retrieve relevant knowledge base passages that answer the question.\nQuery: ${query}`;
}

async function callOllamaEmbed(input: string | string[]) {
  const response = await fetch(`${ollamaBaseUrl()}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: embeddingModel(),
      input,
    }),
  });

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
    throw new Error("Ollama returned an empty embedding.");
  }

  return data.embeddings;
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

export async function generateGroundedAnswer({
  question,
  history,
  context,
}: {
  question: string;
  history: string;
  context: string;
}) {
  return callOpenAiCompatibleChat([
    {
      role: "system",
      content: `You are Atlas, a precise knowledge base assistant.
Answer using only the supplied knowledge base excerpts.
When a claim comes from an excerpt, cite it with its bracketed number, for example [1].
If the excerpts do not contain enough information, say that clearly and suggest what information is missing.
Do not invent policies, facts, links, citations, or hidden reasoning.
Use concise Markdown and a helpful, professional tone.`,
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
}
