# Atlas Knowledge Assistant

A full-stack knowledge base assistant built with Next.js, Node.js,
PostgreSQL + pgvector, Crawlee, Ollama embeddings, and an OpenAI-compatible
open-source chat model endpoint.

## Recommended Model Setup

Default configuration:

- Embeddings: `qwen3-embedding:0.6b` through Ollama
- Chat: `openai/gpt-oss-120b:free` through OpenRouter
- Database: PostgreSQL with the `pgvector` extension
- Crawler: Crawlee `CheerioCrawler` for bounded same-site crawling

Your selected models are reasonable defaults:

- `qwen3-embedding:0.6b` is small, fast, multilingual, and has 1024-dimensional
  embeddings. It is a good starting point for local RAG.
- Qwen3 Embedding 4B or 8B should improve retrieval quality if you can afford
  the extra RAM/VRAM. Use `EMBEDDING_DIMENSIONS=2560` for 4B and `4096` for 8B
  before creating the database schema.
- `openai/gpt-oss-120b:free` is a strong free route, but free hosted routes can
  be rate-limited or temporarily unavailable. The app is provider-neutral, so
  you can point `CHAT_BASE_URL` at OpenRouter, vLLM, LM Studio, Ollama
  OpenAI-compatible mode, or any compatible server.

## Features

- Grounded chat with numbered source citations
- URL, bounded same-site crawl, PDF, DOCX, TXT, Markdown, and manual-text ingestion
- PostgreSQL + pgvector similarity search
- Ollama embedding support with Qwen3 defaults
- OpenRouter/OpenAI-compatible chat completion support
- Password-protected admin workspace
- URL validation, private-network blocking, file limits, and basic rate limiting

## Run Locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start PostgreSQL with pgvector:

   ```bash
   docker compose up -d
   ```

3. Install and run the embedding model in Ollama:

   ```bash
   ollama pull qwen3-embedding:0.6b
   ollama serve
   ```

4. Copy `.env.example` to `.env.local` and fill in:

   ```env
   DATABASE_URL=postgresql://atlas:atlas@localhost:5432/atlas_knowledge
   OLLAMA_BASE_URL=http://localhost:11434
   EMBEDDING_MODEL=qwen3-embedding:0.6b
   EMBEDDING_DIMENSIONS=1024
   OPENROUTER_API_KEY=your-openrouter-api-key
   CHAT_MODEL=openai/gpt-oss-120b:free
   ADMIN_PASSWORD=your-admin-password
   SESSION_SECRET=a-long-random-value
   ```

5. Start the app:

   ```bash
   npm run dev
   ```

6. Open `http://localhost:3000` for chat and `http://localhost:3000/admin` to
   add knowledge.

The app creates its PostgreSQL tables and pgvector extension automatically on
first use.

## Architecture

Uploaded resources are parsed on the Node.js server, normalized, split into
overlapping passages, embedded with Ollama, and stored in PostgreSQL as pgvector
vectors. At question time, Atlas embeds the query, ranks passages using pgvector
cosine distance, and sends the best evidence to the configured chat model with a
strict grounded-answer prompt.

For crawling, Atlas uses Crawlee in bounded same-site mode. Admins can index a
single URL or crawl linked pages from the same origin up to a configurable page
limit.
