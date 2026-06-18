import { embedQuery } from "@/lib/ai";
import { query, vectorLiteral } from "@/lib/db";
import type { ResourceType, RetrievedChunk } from "@/lib/types";

type ChunkRow = {
  id: string;
  resource_id: string;
  resource_name: string;
  resource_type: ResourceType;
  source_url: string | null;
  file_name: string | null;
  content: string;
  score: number | string;
};

function tokenize(text: string) {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((token) => token.length > 2) || [],
  );
}

function lexicalScore(queryText: string, content: string) {
  const queryTokens = tokenize(queryText);
  if (!queryTokens.size) return -1;

  const contentTokens = tokenize(content);
  let matches = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) matches += 1;
  }

  return matches / queryTokens.size;
}

function mapChunk(row: ChunkRow): RetrievedChunk {
  return {
    id: row.id,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    resourceType: row.resource_type,
    sourceUrl: row.source_url,
    fileName: row.file_name,
    content: row.content,
    score: Number(row.score),
  };
}

export async function retrieveRelevantChunks(queryText: string, limit = 6) {
  try {
    const embedding = await embedQuery(queryText);
    const result = await query<ChunkRow>(
      `SELECT c.id, c.resource_id, c.content,
              r.name AS resource_name, r.type AS resource_type,
              r.source_url, r.file_name,
              1 - (c.embedding <=> $1::vector) AS score
       FROM chunks c
       JOIN resources r ON r.id = c.resource_id
       WHERE r.status = 'ready'
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      [vectorLiteral(embedding), limit],
    );

    return result.rows.map(mapChunk);
  } catch {
    const fallback = await query<
      Omit<ChunkRow, "score"> & { chunk_index: number }
    >(
      `SELECT c.id, c.resource_id, c.content, c.chunk_index,
              r.name AS resource_name, r.type AS resource_type,
              r.source_url, r.file_name
       FROM chunks c
       JOIN resources r ON r.id = c.resource_id
       WHERE r.status = 'ready'
       ORDER BY r.created_at DESC, c.chunk_index ASC
       LIMIT 250`,
    );

    return fallback.rows
      .map<RetrievedChunk>((row) => ({
        id: row.id,
        resourceId: row.resource_id,
        resourceName: row.resource_name,
        resourceType: row.resource_type,
        sourceUrl: row.source_url,
        fileName: row.file_name,
        content: row.content,
        score: lexicalScore(queryText, row.content),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
