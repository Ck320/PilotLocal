import { OllamaModelCatalog } from '../types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode: any = require('vscode');

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

export interface OllamaSettings {
  host: string;
  model: string;
  embeddingModel: string;
  autocompleteModel: string;
}

export function isLikelyEmbeddingModel(modelName: string): boolean {
  return /(embed|bge-|e5-|minilm|snowflake-arctic-embed)/i.test(modelName);
}

export function getOllamaSettings(): OllamaSettings {
  const cfg = vscode.workspace.getConfiguration('ollamaLocal');
  const host = String(cfg.get('host') || 'http://localhost:11434').replace(/\/+$/, '');
  const model = String(cfg.get('model') || 'llama3.2');
  const embeddingModel = String(cfg.get('embeddingModel') || '');
  const autocompleteModel = String(cfg.get('autocompleteModel') || '');
  return { host, model, embeddingModel, autocompleteModel };
}

export async function updateOllamaSetting(
  key: 'model' | 'embeddingModel' | 'autocompleteModel',
  value: string
): Promise<void> {
  await vscode.workspace
    .getConfiguration('ollamaLocal')
    .update(key, value, vscode.ConfigurationTarget.Global);
}

export async function fetchOllamaModelCatalog(
  host: string,
  currentSettings: Pick<OllamaSettings, 'model' | 'embeddingModel' | 'autocompleteModel'>
): Promise<OllamaModelCatalog> {
  let allModels: string[] = [];

  try {
    const res = await fetch(`${host}/api/tags`);
    if (res.ok) {
      const data = (await res.json()) as OllamaTagsResponse;
      allModels = (data.models || []).map((m) => m.name);
    }
  } catch {
    // Ollama pode estar offline no momento da consulta
  }

  const generativeModels = allModels.filter((m) => !isLikelyEmbeddingModel(m));
  const detectedEmbeddings = allModels.filter((m) => isLikelyEmbeddingModel(m));

  const chatModels =
    generativeModels.length > 0
      ? [...generativeModels]
      : allModels.length > 0
        ? [...allModels]
        : currentSettings.model
          ? [currentSettings.model]
          : [];

  const embeddingModels =
    detectedEmbeddings.length > 0 ? [...detectedEmbeddings] : [...allModels];

  const autocompleteModels = [...chatModels];

  if (currentSettings.model && !chatModels.includes(currentSettings.model)) {
    chatModels.unshift(currentSettings.model);
  }
  if (currentSettings.embeddingModel && !embeddingModels.includes(currentSettings.embeddingModel)) {
    embeddingModels.unshift(currentSettings.embeddingModel);
  }
  if (
    currentSettings.autocompleteModel &&
    !autocompleteModels.includes(currentSettings.autocompleteModel)
  ) {
    autocompleteModels.unshift(currentSettings.autocompleteModel);
  }

  return {
    chatModels,
    embeddingModels,
    autocompleteModels
  };
}