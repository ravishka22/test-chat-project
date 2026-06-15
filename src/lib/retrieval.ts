import { db } from "@/lib/db";
import { embedQuery } from "@/lib/gemini";
import type { ResourceType, RetrievedChunk } from "@/lib/types";

type ChunkRow = {
  id: string;
  resource_id: string;
  resource_name: string;
  resource_type: ResourceType;
  source_url: string | null;
  file_name: string | null;
  content: string;
  embedding: string;
};

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return -1;

  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    magnitudeA += a[index] * a[index];
    magnitudeB += b[index] * b[index];
  }

  if (!magnitudeA || !magnitudeB) return -1;
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

export async function retrieveRelevantChunks(query: string, limit = 6) {
  const queryEmbedding = await embedQuery(query);
  const rows = db
    .prepare(
      `SELECT c.id, c.resource_id, c.content, c.embedding,
              r.name AS resource_name, r.type AS resource_type,
              r.source_url, r.file_name
       FROM chunks c
       JOIN resources r ON r.id = c.resource_id
       WHERE r.status = 'ready'`,
    )
    .all() as ChunkRow[];

  return rows
    .map<RetrievedChunk>((row) => ({
      id: row.id,
      resourceId: row.resource_id,
      resourceName: row.resource_name,
      resourceType: row.resource_type,
      sourceUrl: row.source_url,
      fileName: row.file_name,
      content: row.content,
      score: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
