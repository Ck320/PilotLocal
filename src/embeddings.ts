import * as vscode from 'vscode';

export interface IndexedChunk {
  filePath: string;
  content: string;
  embedding: number[];
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

function splitIntoChunks(text: string, chunkSize = 800, overlap = 120): string[] {
  if (text.length <= chunkSize) {
    return text.trim() ? [text] : [];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const slice = text.slice(start, end).trim();
    if (slice) {
      chunks.push(slice);
    }
    if (end === text.length) {
      break;
    }
    start += chunkSize - overlap;
  }
  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return -1;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return -1;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function embedTexts(host: string, model: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const res = await fetch(`${host}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts })
  });
  if (!res.ok) {
    throw new Error(`Falha ao gerar embeddings (${res.status} ${res.statusText})`);
  }
  const data = (await res.json()) as OllamaEmbedResponse;
  return data.embeddings || [];
}

export async function buildWorkspaceIndex(host: string, embeddingModel: string): Promise<IndexedChunk[]> {
  const exclude = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.venv/**,**/__pycache__/**,**/*.lock,**/*.png,**/*.jpg,**/*.vsix}';
  const uris = await vscode.workspace.findFiles('**/*', exclude, 150);
  const index: IndexedChunk[] = [];

  for (const uri of uris) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(bytes);
      // Ignora arquivos binários com bytes nulos
      if (text.includes('\0')) {
        continue;
      }
      const relPath = vscode.workspace.asRelativePath(uri, false);
      const chunks = splitIntoChunks(text);
      const vectors = await embedTexts(host, embeddingModel, chunks);

      for (let i = 0; i < chunks.length; i++) {
        if (vectors[i]) {
          index.push({
            filePath: relPath,
            content: chunks[i],
            embedding: vectors[i]
          });
        }
      }
    } catch {
      // Ignora arquivos ilegíveis
    }
  }

  return index;
}

export async function findRelevantChunks(
  host: string,
  embeddingModel: string,
  query: string,
  index: IndexedChunk[],
  topK = 5
): Promise<IndexedChunk[]> {
  if (index.length === 0) {
    return [];
  }
  const [queryVec] = await embedTexts(host, embeddingModel, [query]);
  if (!queryVec) {
    return [];
  }

  return index
    .map((item) => ({
      item,
      score: cosineSimilarity(queryVec, item.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => entry.item);
}