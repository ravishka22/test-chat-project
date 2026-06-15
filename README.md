# Atlas Knowledge Assistant

A full-stack knowledge base assistant built with Next.js, Node.js, SQLite,
open-source document parsers, and the Gemini API.

## Features

- Grounded chat with numbered source citations
- URL, PDF, DOCX, TXT, Markdown, and manual-text ingestion
- Local SQLite storage and cosine-similarity vector search
- Gemini Embedding 2 embeddings and Gemini 3.5 Flash responses
- Password-protected admin workspace
- URL validation, private-network blocking, file limits, and basic rate limiting

## Run locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env.local` and fill in:

   ```env
   GEMINI_API_KEY=your-key
   ADMIN_PASSWORD=your-admin-password
   SESSION_SECRET=a-long-random-value
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:3000` for chat and
   `http://localhost:3000/admin` to add knowledge.

The SQLite database is created automatically at `data/knowledge.db`.

## Architecture

Uploaded resources are parsed on the Node.js server, normalized, split into
overlapping passages, embedded with Gemini, and stored in SQLite. At question
time, Atlas embeds the query, ranks all passages using cosine similarity, and
sends the best evidence to Gemini with a strict grounded-answer prompt.

For a larger deployment, replace the local similarity scan with an open-source
vector database such as Qdrant or PostgreSQL with pgvector, and move ingestion
to a background job queue.
