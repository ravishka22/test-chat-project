import { GoogleGenAI } from "@google/genai";

const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_BATCH_RETRIES = 3;
const FALLBACK_EMBEDDING_MODELS = ["gemini-embedding-001"];

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Gemini is not configured. Add GEMINI_API_KEY to your environment.",
    );
  }
  return new GoogleGenAI({ apiKey });
}

function embeddingModel() {
  return process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2";
}

function embeddingModels() {
  return [embeddingModel(), ...FALLBACK_EMBEDDING_MODELS].filter(
    (model, index, models) => models.indexOf(model) === index,
  );
}

function isQuotaError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(error.message);
}

async function withEmbeddingRetry<T>(operation: () => Promise<T>) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= EMBEDDING_BATCH_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isQuotaError(error) || attempt === EMBEDDING_BATCH_RETRIES) {
        throw error;
      }

      const delay = 500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to embed content.");
}

async function embed(input: string, mode: "document" | "query") {
  return embedWithModelFallback(input, mode);
}

export function embedDocument(content: string, title: string) {
  const input = embeddingModel().includes("embedding-2")
    ? `title: ${title || "none"} | text: ${content}`
    : content;
  return embedWithModelFallback(input, "document");
}

export async function embedDocuments(
  documents: Array<{ content: string; title: string }>,
  mode: "document" | "query" = "document",
): Promise<number[][]> {
  if (!documents.length) return [];
  if (documents.length === 1) {
    const model = embeddingModel();
    const input =
      mode === "document" && model.includes("embedding-2")
        ? `title: ${documents[0].title || "none"} | text: ${documents[0].content}`
        : documents[0].content;

    return [await embedWithModelFallback(input, mode)];
  }

  const contents = documents.map(({ content, title }) => {
    const model = embeddingModel();
    return mode === "document" && model.includes("embedding-2")
      ? `title: ${title || "none"} | text: ${content}`
      : content;
  });

  const response = await embedBatchWithModelFallback(contents, mode);
  const embeddings = response.embeddings || [];
  if (embeddings.length !== documents.length) {
    const midpoint = Math.ceil(documents.length / 2);
    const leftEmbeddings = await embedDocuments(documents.slice(0, midpoint), mode);
    const rightEmbeddings = await embedDocuments(documents.slice(midpoint), mode);
    return [...leftEmbeddings, ...rightEmbeddings];
  }

  return embeddings.map((embedding) => {
    if (!embedding.values?.length) {
      throw new Error("Gemini returned an empty embedding.");
    }

    return embedding.values;
  });
}

async function embedWithModelFallback(
  input: string,
  mode: "document" | "query",
) {
  for (const model of embeddingModels()) {
    const isEmbedding2 = model.includes("embedding-2");
    const contents = isEmbedding2
      ? mode === "document"
        ? input
        : `task: question answering | query: ${input}`
      : input;

    try {
      const response = await withEmbeddingRetry(() =>
        getClient().models.embedContent({
          model,
          contents,
          config: isEmbedding2
            ? { outputDimensionality: EMBEDDING_DIMENSIONS }
            : {
                outputDimensionality: EMBEDDING_DIMENSIONS,
                taskType:
                  mode === "document"
                    ? "RETRIEVAL_DOCUMENT"
                    : "RETRIEVAL_QUERY",
              },
        }),
      );

      const values = response.embeddings?.[0]?.values;
      if (!values?.length) {
        throw new Error("Gemini returned an empty embedding.");
      }

      return values;
    } catch (error) {
      if (!isQuotaError(error) || model === embeddingModels().at(-1)) {
        throw error;
      }
    }
  }

  throw new Error("Gemini embedding models are temporarily unavailable.");
}

async function embedBatchWithModelFallback(
  contents: string[],
  mode: "document" | "query",
) {
  for (const model of embeddingModels()) {
    const isEmbedding2 = model.includes("embedding-2");

    try {
      const response = await withEmbeddingRetry(() =>
        getClient().models.embedContent({
          model,
          contents,
          config: isEmbedding2
            ? { outputDimensionality: EMBEDDING_DIMENSIONS }
            : {
                outputDimensionality: EMBEDDING_DIMENSIONS,
                taskType:
                  mode === "document"
                    ? "RETRIEVAL_DOCUMENT"
                    : "RETRIEVAL_QUERY",
              },
        }),
      );

      if ((response.embeddings || []).length) {
        return response;
      }
    } catch (error) {
      if (!isQuotaError(error) || model === embeddingModels().at(-1)) {
        throw error;
      }
    }
  }

  throw new Error("Gemini embedding models are temporarily unavailable.");
}

export function embedQuery(query: string) {
  return embed(query, "query");
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
  const model = process.env.GEMINI_CHAT_MODEL || "gemini-3.5-flash";
  const response = await getClient().models.generateContent({
    model,
    contents: `KNOWLEDGE BASE EXCERPTS
${context}

RECENT CONVERSATION
${history || "No previous messages."}

CURRENT QUESTION
${question}`,
    config: {
      systemInstruction: `You are Atlas, a precise knowledge base assistant.
Answer using only the supplied knowledge base excerpts.
When a claim comes from an excerpt, cite it with its bracketed number, for example [1].
If the excerpts do not contain enough information, say that clearly and suggest what information is missing.
Do not invent policies, facts, links, or citations.
Use concise Markdown and a helpful, professional tone.`,
      maxOutputTokens: 1200,
    },
  });

  return (
    response.text?.trim() ||
    "I could not generate an answer from the available knowledge base."
  );
}
