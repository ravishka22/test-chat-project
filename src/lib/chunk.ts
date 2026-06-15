const DEFAULT_CHUNK_SIZE = 1400;
const DEFAULT_OVERLAP = 180;

export function normalizeText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findBoundary(text: string, target: number, minimum: number) {
  const candidates = [
    text.lastIndexOf("\n\n", target),
    text.lastIndexOf(". ", target),
    text.lastIndexOf("! ", target),
    text.lastIndexOf("? ", target),
    text.lastIndexOf(" ", target),
  ];

  return Math.max(minimum, ...candidates.filter((value) => value >= minimum));
}

export function chunkText(
  input: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
) {
  const text = normalizeText(input);
  if (!text) return [];
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const desiredEnd = Math.min(start + chunkSize, text.length);
    const minimumEnd = Math.min(start + Math.floor(chunkSize * 0.65), desiredEnd);
    const end =
      desiredEnd === text.length
        ? desiredEnd
        : findBoundary(text, desiredEnd, minimumEnd);

    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;

    start = Math.max(start + 1, end - overlap);
    while (start < end && /\S/.test(text[start - 1] || "")) start += 1;
  }

  return chunks;
}
