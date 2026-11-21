import { AssistantMode, ChatMessage } from '../types';
import { getOllamaSettings } from './ollamaClient';

interface OllamaChatChunk {
  message?: { role: string; content: string };
  done?: boolean;
}

export function getModeSystemPrompt(mode: AssistantMode): string {
  switch (mode) {
    case 'plan':
      return (
        'Você está no modo PLAN. Não altere arquivos diretamente nem gere blocos ```file:...```. ' +
        'Analise os arquivos, pastas e trechos fornecidos, decomponha a tarefa em passos claros e objetivos, ' +
        'liste os arquivos que deverão ser criados/modificados, aponte dependências/riscos e sugira como validar cada etapa.'
      );
    case 'agent':
      return (
        'Você está no modo AGENT. Resolva a solicitação de forma prática e completa com base nos arquivos/pastas/trechos fornecidos. ' +
        'Sempre que criar ou modificar um arquivo, VOCÊ DEVE incluir o conteúdo completo do arquivo dentro de um bloco exatamente neste formato:\n' +
        '```file:caminho/relativo/do/arquivo.ext\n<código completo do arquivo, sem omitir partes>\n```\n' +
        'Não apenas mostre trechos soltos no texto quando o objetivo for criar ou atualizar arquivos.'
      );
    case 'chat':
    default:
      return (
        'Você está no modo CHAT. Responda de forma clara, técnica e objetiva com base no histórico ' +
        'e nos arquivos/pastas/trechos referenciados. Se o usuário pedir para criar ou alterar um arquivo, ' +
        'use o formato ```file:caminho/relativo/do/arquivo.ext```.'
      );
  }
}

export async function streamAgentChat(options: {
  mode: AssistantMode;
  history: ChatMessage[];
  chosenModel?: string;
  signal?: AbortSignal;
  onChunk: (chunk: string) => void;
}): Promise<string> {
  const { host, model: defaultModel } = getOllamaSettings();
  const model = options.chosenModel || defaultModel;

  const messagesToSend: ChatMessage[] = [
    { role: 'system', content: getModeSystemPrompt(options.mode) },
    ...options.history
  ];

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model,
      messages: messagesToSend,
      stream: true
    })
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullReply = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const clean = line.trim();
      if (!clean) {
        continue;
      }
      const chunk = JSON.parse(clean) as OllamaChatChunk;
      if (chunk.message?.content) {
        fullReply += chunk.message.content;
        options.onChunk(chunk.message.content);
      }
    }
  }

  return fullReply;
}