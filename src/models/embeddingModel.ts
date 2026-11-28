import { getOllamaSettings } from './ollamaClient';

export async function generateEmbedding(
  text: string,
  chosenEmbeddingModel?: string
): Promise<number[] | undefined> {
  const { host, embeddingModel: configuredModel } = getOllamaSettings();
  const model = chosenEmbeddingModel ?? configuredModel;

  if (!model || !text) {
    return undefined;
  }

  const res = await fetch(`${host}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: text
    })
  });

  if (!res.ok) {
    throw new Error(`Erro ao gerar embedding (${res.status}):${res.statusText}`);
  }

  const data = (await res.json()) as { embedding?: number[] };
  return data.embedding;
}

export async function generateBatchEmbeddings(
  texts: string[],
  chosenEmbeddingModel?: string
): Promise<Array<number[] | undefined>> {
  const results: Array<number[] | undefined> = [];
  for (const item of texts) {
    results.push(await generateEmbedding(item, chosenEmbeddingModel));
  }
  return results;
}