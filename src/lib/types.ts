export type ResourceType = "url" | "pdf" | "docx" | "text";
export type ResourceStatus = "processing" | "ready" | "failed";

export interface Resource {
  id: string;
  name: string;
  type: ResourceType;
  sourceUrl: string | null;
  fileName: string | null;
  status: ResourceStatus;
  error: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RetrievedChunk {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType;
  sourceUrl: string | null;
  fileName: string | null;
  content: string;
  score: number;
}

export interface Source {
  id: string;
  name: string;
  type: ResourceType;
  url: string | null;
  excerpt: string;
  score: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  title?: string;
  suggestions?: string[];
  sources?: Source[];
}
