import * as path from 'path';
import { getMarkdownStyles, getMarkdownClientScript } from './markdownFormatter';

// Carrega a API do VSCodium/VS Code em tempo de execução sem depender de @types/vscode na compilação
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode: any = require('vscode');

type AssistantMode = 'chat' | 'plan' | 'agent';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

interface OllamaChatChunk {
  message?: { role: string; content: string };
  done?: boolean;
}

interface ProposedFileEdit {
  filePath: string;
  content: string;
}

interface MentionSuggestion {
  kind: 'file' | 'folder';
  label: string;
  insertValue: string;
}

interface ResolvedMentionContext {
  attachedMentions: string[];
  sections: string[];
}

interface CodeSnippetAttachment {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  languageId: string;
  code: string;
}

interface PendingComposerPayload {
  mode: AssistantMode;
  appendMentions?: string[];
  snippet?: CodeSnippetAttachment;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  'build',
  '.idea',
  '.vscode-test'
]);

const EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/.next/**,**/build/**,**/*.lock,**/*.vsix,**/*.png,**/*.jpg,**/*.jpeg,**/*.webp,**/*.gif,**/*.ico,**/*.pdf,**/*.zip,**/*.tar,**/*.gz}';

const MAX_FOLDER_FILES = 15;
const MAX_FILE_CHARS = 12000;
const MAX_TOTAL_CONTEXT_CHARS = 45000;

function isLikelyEmbeddingModel(modelName: string): boolean {
  return /(embed|bge-|e5-|minilm|snowflake-arctic-embed)/i.test(modelName);
}

function getOllamaConfig() {
  const cfg = vscode.workspace.getConfiguration('ollamaLocal');
  const host = (cfg.get('host') || 'http://localhost:11434').replace(/\/+$/, '');
  const model = cfg.get('model') || 'llama3.2';
  const embeddingModel = cfg.get('embeddingModel') || '';
  const autocompleteModel = cfg.get('autocompleteModel') || '';
  return { host, model, embeddingModel, autocompleteModel };
}

export async function generateEmbedding(text: string): Promise<number[] | undefined> {
  const { host, embeddingModel } = getOllamaConfig();
  if (!embeddingModel) {
    return undefined;
  }

  const res = await fetch(`${host}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: embeddingModel,
      prompt: text
    })
  });

  if (!res.ok) {
    throw new Error(`Erro ao gerar embedding (${res.status}): ${res.statusText}`);
  }

  const data = (await res.json()) as { embedding?: number[] };
  return data.embedding;
}

function getModeSystemPrompt(mode: AssistantMode): string {
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

function normalizeRelativeFilePath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^(?:\/\/|#|\/\*|--)\s*/, '')
    .replace(/\s*\*\/$/, '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function resolveSafeWorkspacePath(workspaceRoot: string, relativePath: string): string | undefined {
  if (!workspaceRoot) {
    return undefined;
  }

  const cleanPath = normalizeRelativeFilePath(relativePath);
  const parts = cleanPath.split('/').filter(Boolean);

  if (parts.length === 0 || parts.includes('..')) {
    return undefined;
  }

  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedTarget = path.resolve(normalizedRoot, ...parts);

  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(normalizedRoot + path.sep)
  ) {
    return undefined;
  }

  return normalizedTarget;
}

function extractProposedEdits(text: string): ProposedFileEdit[] {
  const editsByPath = new Map<string, string>();
  const fenceRegex = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    const infoString = (match[1] || '').trim();
    const content = match[2].replace(/\r?\n$/, '');

    // 1. Formato explícito: ```file:caminho/do/arquivo.ext
    const filePrefixMatch = infoString.match(/^file:(.+)$/i);
    if (filePrefixMatch) {
      const cleanPath = normalizeRelativeFilePath(filePrefixMatch[1]);
      if (cleanPath && !cleanPath.split('/').includes('..')) {
        editsByPath.set(cleanPath, content);
      }
      continue;
    }

    // 2. Fallback: ```ts src/foo.ts ou ```python # src/foo.py (exige extensão clara)
    const tokens = infoString.split(/\s+/).filter(Boolean);
    const candidateToken = tokens.slice(1).join(' ') || tokens[0] || '';
    const candidatePath = normalizeRelativeFilePath(candidateToken);
    const hasFileExtension = /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,10}$/.test(candidatePath);

    if (hasFileExtension && !candidatePath.split('/').includes('..')) {
      editsByPath.set(candidatePath, content);
    }
  }

  return Array.from(editsByPath.entries()).map(([filePath, content]) => ({
    filePath,
    content
  }));
}

function getTargetFileUri(relativePath: string): any | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const rootUri = folders[0].uri;
  const safeFsPath = resolveSafeWorkspacePath(rootUri.fsPath, relativePath);
  if (!safeFsPath) {
    vscode.window.showWarningMessage(`Caminho inválido ou fora do workspace ignorado: ${relativePath}`);
    return undefined;
  }

  return vscode.Uri.file(safeFsPath);
}

async function openDiffPreview(relativePath: string, newContent: string) {
  const targetUri = getTargetFileUri(relativePath);
  if (!targetUri) {
    vscode.window.showErrorMessage('Nenhuma pasta aberta no workspace ou caminho inválido.');
    return;
  }

  const previewUri = targetUri.with({
    scheme: 'untitled',
    path: `${targetUri.path}.ollama-suggested${path.extname(targetUri.path)}`
  });

  const doc = await vscode.workspace.openTextDocument(previewUri);
  const edit = new vscode.WorkspaceEdit();
  edit.delete(previewUri, new vscode.Range(0, 0, doc.lineCount, 0));
  edit.insert(previewUri, new vscode.Position(0, 0), newContent);
  await vscode.workspace.applyEdit(edit);

  let fileExists = true;
  try {
    await vscode.workspace.fs.stat(targetUri);
  } catch {
    fileExists = false;
  }

  if (fileExists) {
    await vscode.commands.executeCommand(
      'vscode.diff',
      targetUri,
      previewUri,
      `${path.basename(relativePath)} (Atual ↔ Ollama)`
    );
  } else {
    await vscode.window.showTextDocument(doc, { preview: true });
  }
}

async function applyFileEdit(relativePath: string, newContent: string, showNotification = true): Promise<boolean> {
  const targetUri = getTargetFileUri(relativePath);
  if (!targetUri) {
    vscode.window.showErrorMessage('Nenhuma pasta aberta no workspace ou caminho inválido.');
    return false;
  }

  const edit = new vscode.WorkspaceEdit();
  let fileExists = true;

  try {
    await vscode.workspace.fs.stat(targetUri);
  } catch {
    fileExists = false;
  }

  if (!fileExists) {
    edit.createFile(targetUri, { overwrite: true, ignoreIfExists: false });
    edit.insert(targetUri, new vscode.Position(0, 0), newContent);
  } else {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const lastLine = doc.lineAt(doc.lineCount - 1);
    const fullRange = new vscode.Range(0, 0, doc.lineCount - 1, lastLine.text.length);
    edit.replace(targetUri, fullRange, newContent);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage(`Não foi possível aplicar alterações em ${relativePath}.`);
    return false;
  }

  const savedDoc = await vscode.workspace.openTextDocument(targetUri);
  await savedDoc.save();
  if (showNotification) {
    await vscode.window.showTextDocument(savedDoc);
    vscode.window.showInformationMessage(`Alterações aplicadas em ${relativePath}`);
  }
  return true;
}

async function collectWorkspaceEntries(
  rootUri: any,
  maxDepth = 5,
  maxEntries = 600
): Promise<{ folders: string[]; files: string[] }> {
  const folders: string[] = [];
  const files: string[] = [];

  async function walk(currentUri: any, prefix: string, depth: number) {
    if (depth > maxDepth || folders.length + files.length >= maxEntries) {
      return;
    }

    let entries: [string, number][];
    try {
      entries = await vscode.workspace.fs.readDirectory(currentUri);
    } catch {
      return;
    }

    entries.sort((a, b) => a[0].localeCompare(b[0]));

    for (const [name, type] of entries) {
      if (folders.length + files.length >= maxEntries) {
        break;
      }

      const relPath = prefix ? `${prefix}/${name}` : name;

      if ((type & vscode.FileType.Directory) !== 0) {
        if (IGNORED_DIRS.has(name)) {
          continue;
        }
        folders.push(relPath);
        await walk(vscode.Uri.joinPath(currentUri, name), relPath, depth + 1);
      } else if ((type & vscode.FileType.File) !== 0) {
        files.push(relPath);
      }
    }
  }

  await walk(rootUri, '', 0);
  return { folders, files };
}

class OllamaInlineCompletionProvider {
  private lastRequestTime = 0;

  public async provideInlineCompletionItems(
    document: any,
    position: any,
    _context: any,
    token: any
  ): Promise<any[]> {
    const { host, autocompleteModel } = getOllamaConfig();
    if (!autocompleteModel) {
      return [];
    }

    // Debounce simples para evitar disparos excessivos enquanto digita rápido
    const requestTime = Date.now();
    this.lastRequestTime = requestTime;
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (token.isCancellationRequested || this.lastRequestTime !== requestTime) {
      return [];
    }

    const startLine = Math.max(0, position.line - 60);
    const endLine = Math.min(document.lineCount - 1, position.line + 25);

    const prefix = document.getText(new vscode.Range(startLine, 0, position.line, position.character));
    const suffix = document.getText(
      new vscode.Range(position.line, position.character, endLine, document.lineAt(endLine).text.length)
    );

    if (!prefix.trim()) {
      return [];
    }

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    try {
      const res = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: autocompleteModel,
          prompt: prefix,
          suffix,
          stream: false,
          options: {
            num_predict: 128,
            temperature: 0.2,
            stop: ['\n\n', '```']
          }
        })
      });

      if (!res.ok || token.isCancellationRequested) {
        return [];
      }

      const data = (await res.json()) as { response?: string };
      const suggestion = data.response || '';
      if (!suggestion.trim()) {
        return [];
      }

      return [
        new vscode.InlineCompletionItem(
          suggestion,
          new vscode.Range(position, position)
        )
      ];
    } catch {
      return [];
    }
  }
}

class OllamaChatViewProvider {
  public static readonly viewType = 'ollamaChatView';
  private view?: any;
  private isWebviewReady = false;
  private pendingPayloads: PendingComposerPayload[] = [];
  private history: ChatMessage[] = [];
  private abortController?: AbortController;
  private currentMode: AssistantMode = 'chat';

  constructor(private readonly extensionUri: any) {}

  public clearHistory() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
    this.history = [];
    this.view?.webview.postMessage({ type: 'clearMessages' });
  }

  public async revealAndInjectContext(payload: PendingComposerPayload) {
    this.currentMode = payload.mode;
    await vscode.commands.executeCommand('ollamaChatView.focus');

    if (this.view && this.isWebviewReady) {
      this.view.webview.postMessage({
        type: 'injectContext',
        payload
      });
    } else {
      this.pendingPayloads.push(payload);
    }
  }

  public resolveWebviewView(webviewView: any) {
    this.view = webviewView;
    this.isWebviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml();

    webviewView.onDidDispose(() => {
      this.isWebviewReady = false;
      this.view = undefined;
    });

    webviewView.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg.type) {
        case 'ready':
          this.isWebviewReady = true;
          await this.sendInitialState();
          while (this.pendingPayloads.length > 0) {
            const next = this.pendingPayloads.shift();
            if (next) {
              this.view?.webview.postMessage({
                type: 'injectContext',
                payload: next
              });
            }
          }
          break;
        case 'refreshModels':
          await this.sendInitialState();
          break;
        case 'selectModel':
          await vscode.workspace
            .getConfiguration('ollamaLocal')
            .update('model', msg.model, vscode.ConfigurationTarget.Global);
          break;
        case 'selectEmbeddingModel':
          await vscode.workspace
            .getConfiguration('ollamaLocal')
            .update('embeddingModel', msg.model || '', vscode.ConfigurationTarget.Global);
          break;
        case 'selectAutocompleteModel':
          await vscode.workspace
            .getConfiguration('ollamaLocal')
            .update('autocompleteModel', msg.model || '', vscode.ConfigurationTarget.Global);
          break;
        case 'selectMode':
          if (msg.mode === 'chat' || msg.mode === 'plan' || msg.mode === 'agent') {
            this.currentMode = msg.mode;
          }
          break;
        case 'searchMentions':
          await this.handleMentionSearch(msg.query || '', msg.requestId);
          break;
        case 'sendMessage':
          await this.handleUserMessage(
            msg.text || '',
            msg.model,
            msg.mode,
            Array.isArray(msg.snippets) ? msg.snippets : []
          );
          break;
        case 'stopGeneration':
          if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
          }
          break;
        case 'previewEdit':
          await openDiffPreview(msg.filePath, msg.content);
          break;
        case 'applyEdit': {
          const ok = await applyFileEdit(msg.filePath, msg.content, true);
          this.view?.webview.postMessage({
            type: 'editStatus',
            filePath: msg.filePath,
            applied: ok
          });
          break;
        }
        case 'applyAllEdits': {
          const edits: ProposedFileEdit[] = Array.isArray(msg.edits) ? msg.edits : [];
          for (const editItem of edits) {
            const ok = await applyFileEdit(editItem.filePath, editItem.content, false);
            this.view?.webview.postMessage({
              type: 'editStatus',
              filePath: editItem.filePath,
              applied: ok
            });
          }
          if (edits.length > 0) {
            vscode.window.showInformationMessage(`${edits.length} arquivo(s) processado(s) pelo Ollama.`);
          }
          break;
        }
      }
    });
  }

  private async sendInitialState() {
    const { host, model, embeddingModel, autocompleteModel } = getOllamaConfig();
    let allModels: string[] = [];
    try {
      const res = await fetch(`${host}/api/tags`);
      if (res.ok) {
        const data = (await res.json()) as OllamaTagsResponse;
        allModels = (data.models || []).map((m) => m.name);
      }
    } catch {
      // Ollama pode estar offline
    }

    const chatModels = allModels.filter((m) => !isLikelyEmbeddingModel(m));
    const embeddingModels = allModels.filter((m) => isLikelyEmbeddingModel(m));

    const effectiveChatModels = chatModels.length > 0 ? chatModels : allModels.length > 0 ? allModels : model ? [model] : [];
    const effectiveEmbeddingModels = embeddingModels.length > 0 ? embeddingModels : allModels;
    const effectiveAutocompleteModels = effectiveChatModels;

    if (model && !effectiveChatModels.includes(model)) {
      effectiveChatModels.unshift(model);
    }
    if (embeddingModel && !effectiveEmbeddingModels.includes(embeddingModel)) {
      effectiveEmbeddingModels.unshift(embeddingModel);
    }
    if (autocompleteModel && !effectiveAutocompleteModels.includes(autocompleteModel)) {
      effectiveAutocompleteModels.unshift(autocompleteModel);
    }

    this.view?.webview.postMessage({
      type: 'init',
      chatModels: effectiveChatModels,
      selectedModel: effectiveChatModels.includes(model) ? model : effectiveChatModels[0] || model,
      embeddingModels: effectiveEmbeddingModels,
      selectedEmbeddingModel: embeddingModel,
      autocompleteModels: effectiveAutocompleteModels,
      selectedAutocompleteModel: autocompleteModel,
      mode: this.currentMode
    });
  }

  private async handleMentionSearch(query: string, requestId?: number) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this.view?.webview.postMessage({
        type: 'mentionSuggestions',
        requestId,
        suggestions: [],
        emptyReason: 'Abra uma pasta no VSCodium (File > Open Folder) para listar arquivos.'
      });
      return;
    }

    const { folders, files } = await collectWorkspaceEntries(workspaceFolders[0].uri);
    const normalizedQuery = query.toLowerCase().replace(/\\/g, '/').replace(/^\/+/, '');

    const suggestions: MentionSuggestion[] = [];

    for (const folder of folders) {
      const folderToken = `${folder}/`;
      if (
        !normalizedQuery ||
        folder.toLowerCase().includes(normalizedQuery) ||
        folderToken.toLowerCase().includes(normalizedQuery)
      ) {
        suggestions.push({
          kind: 'folder',
          label: `📁 ${folder}/`,
          insertValue: `${folder}/`
        });
      }
    }

    for (const file of files) {
      if (!normalizedQuery || file.toLowerCase().includes(normalizedQuery)) {
        suggestions.push({
          kind: 'file',
          label: `📄 ${file}`,
          insertValue: file
        });
      }
    }

    suggestions.sort((a, b) => {
      if (normalizedQuery) {
        const aStarts = a.insertValue.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        const bStarts = b.insertValue.toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
        if (aStarts !== bStarts) {
          return aStarts - bStarts;
        }
      }
      return a.insertValue.length - b.insertValue.length;
    });

    this.view?.webview.postMessage({
      type: 'mentionSuggestions',
      requestId,
      suggestions: suggestions.slice(0, 30),
      emptyReason: suggestions.length === 0 ? `Nenhum arquivo ou pasta encontrado para "${query}".` : undefined
    });
  }

  private async readFileForContext(fileUri: any, relPath: string): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      let content = new TextDecoder('utf-8').decode(bytes);
      if (content.includes('\0')) {
        return undefined;
      }
      let truncatedNote = '';
      if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS);
        truncatedNote = `\n... [truncado em ${MAX_FILE_CHARS} caracteres]`;
      }
      const ext = path.extname(relPath).replace('.', '') || 'txt';
      return `Arquivo: \`${relPath}\`\n\`\`\`${ext}\n${content}${truncatedNote}\n\`\`\``;
    } catch {
      return undefined;
    }
  }

  private async resolveSingleMention(
    rawToken: string,
    rootUri: any,
    allWorkspaceFiles: string[],
    alreadyIncluded: Set<string>,
    totalCharsRef: { count: number }
  ): Promise<ResolvedMentionContext> {
    const cleanToken = rawToken.replace(/\\/g, '/').replace(/^\/+/, '');
    const endsWithSlash = cleanToken.endsWith('/');
    const normalizedPath = cleanToken.replace(/\/+$/, '');

    if (!normalizedPath) {
      return { attachedMentions: [], sections: [] };
    }

    const targetUri = vscode.Uri.joinPath(rootUri, ...normalizedPath.split('/'));
    let isDirectory = endsWithSlash;
    let isFile = false;

    try {
      const stat = await vscode.workspace.fs.stat(targetUri);
      isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
      isFile = (stat.type & vscode.FileType.File) !== 0;
    } catch {
      const prefix = `${normalizedPath}/`;
      isDirectory = allWorkspaceFiles.some((f) => f.startsWith(prefix));
    }

    if (isDirectory) {
      const prefix = `${normalizedPath}/`;
      const matchingFiles = allWorkspaceFiles
        .filter((f) => f.startsWith(prefix))
        .sort()
        .slice(0, MAX_FOLDER_FILES);

      const sections: string[] = [];
      for (const relFile of matchingFiles) {
        if (alreadyIncluded.has(relFile) || totalCharsRef.count >= MAX_TOTAL_CONTEXT_CHARS) {
          continue;
        }
        const fUri = vscode.Uri.joinPath(rootUri, ...relFile.split('/'));
        const section = await this.readFileForContext(fUri, relFile);
        if (section) {
          alreadyIncluded.add(relFile);
          totalCharsRef.count += section.length;
          sections.push(section);
        }
      }

      const mentionLabel = `${normalizedPath}/ (${matchingFiles.length} arq.)`;
      return {
        attachedMentions: matchingFiles.length > 0 ? [mentionLabel] : [],
        sections
      };
    }

    if (isFile && !alreadyIncluded.has(normalizedPath) && totalCharsRef.count < MAX_TOTAL_CONTEXT_CHARS) {
      const section = await this.readFileForContext(targetUri, normalizedPath);
      if (section) {
        alreadyIncluded.add(normalizedPath);
        totalCharsRef.count += section.length;
        return {
          attachedMentions: [normalizedPath],
          sections: [section]
        };
      }
    }

    return { attachedMentions: [], sections: [] };
  }

  private async buildPromptWithContext(
    rawText: string,
    mode: AssistantMode,
    snippets: CodeSnippetAttachment[]
  ): Promise<{
    enrichedPrompt: string;
    attachedBadges: string[];
  }> {
    const attachedBadges: string[] = [];
    const sections: string[] = [];

    for (const snip of snippets) {
      const label = `${snip.filePath}:${snip.startLine}-${snip.endLine}`;
      attachedBadges.push(label);
      sections.push(
        `Trecho selecionado de \`${snip.filePath}\` (linhas ${snip.startLine} a ${snip.endLine}):\n` +
          `\`\`\`${snip.languageId || 'txt'}\n${snip.code}\n\`\`\``
      );
    }

    const mentionRegex = /(?:^|[\s([{"'])@([^\s@)\]}"',;]+)/g;
    const matches = [...rawText.matchAll(mentionRegex)];
    const uniqueTokens = Array.from(new Set(matches.map((m) => m[1])));

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (uniqueTokens.length > 0 && workspaceFolders && workspaceFolders.length > 0) {
      const rootUri = workspaceFolders[0].uri;
      const uris: any[] = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, 500);
      const allWorkspaceFiles = uris.map((u) => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/'));

      const alreadyIncluded = new Set<string>();
      const totalCharsRef = { count: 0 };

      for (const token of uniqueTokens) {
        const resolved = await this.resolveSingleMention(
          token,
          rootUri,
          allWorkspaceFiles,
          alreadyIncluded,
          totalCharsRef
        );
        attachedBadges.push(...resolved.attachedMentions);
        sections.push(...resolved.sections);
      }
    }

    if (sections.length === 0) {
      return { enrichedPrompt: rawText, attachedBadges: [] };
    }

    const modeHint =
      mode === 'agent'
        ? '\nLembre-se: no modo AGENT, escreva blocos ```file:caminho/do/arquivo.ext``` para os arquivos que você alterar ou criar.'
        : mode === 'plan'
          ? '\nLembre-se: no modo PLAN, apresente apenas o plano estruturado sem alterar arquivos.'
          : '';

    const enrichedPrompt =
      `${rawText}${modeHint}\n\n---\nContexto anexado:\n\n${sections.join('\n\n')}`;

    return { enrichedPrompt, attachedBadges };
  }

  private async handleUserMessage(
    rawText: string,
    chosenModel?: string,
    chosenMode?: AssistantMode,
    snippets: CodeSnippetAttachment[] = []
  ) {
    const trimmed = rawText.trim();
    if (!trimmed && snippets.length === 0) {
      return;
    }

    const effectiveText = trimmed || 'Analise o trecho de código anexado.';
    const { host, model: defaultModel } = getOllamaConfig();
    const model = chosenModel || defaultModel;
    const mode: AssistantMode =
      chosenMode === 'chat' || chosenMode === 'plan' || chosenMode === 'agent' ? chosenMode : this.currentMode;
    this.currentMode = mode;

    const { enrichedPrompt, attachedBadges } = await this.buildPromptWithContext(effectiveText, mode, snippets);

    this.view?.webview.postMessage({
      type: 'userMessage',
      text: effectiveText,
      attachedMentions: attachedBadges,
      mode
    });

    this.history.push({
      role: 'user',
      content: enrichedPrompt
    });

    const messagesToSend: ChatMessage[] = [
      { role: 'system', content: getModeSystemPrompt(mode) },
      ...this.history
    ];

    this.view?.webview.postMessage({ type: 'assistantStart', mode });

    this.abortController = new AbortController();
    let assistantReply = '';

    try {
      const res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this.abortController.signal,
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
            assistantReply += chunk.message.content;
            this.view?.webview.postMessage({
              type: 'assistantChunk',
              chunk: chunk.message.content
            });
          }
        }
      }

      if (assistantReply) {
        this.history.push({
          role: 'assistant',
          content: assistantReply
        });

        if (mode !== 'plan') {
          const proposedEdits = extractProposedEdits(assistantReply);
          if (proposedEdits.length > 0) {
            this.view?.webview.postMessage({
              type: 'proposedEdits',
              edits: proposedEdits
            });
          }
        }
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        if (assistantReply) {
          this.history.push({ role: 'assistant', content: assistantReply });
          if (mode !== 'plan') {
            const proposedEdits = extractProposedEdits(assistantReply);
            if (proposedEdits.length > 0) {
              this.view?.webview.postMessage({
                type: 'proposedEdits',
                edits: proposedEdits
              });
            }
          }
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.view?.webview.postMessage({
          type: 'assistantError',
          error: `Falha ao conectar ao Ollama (${host}): ${message}`
        });
        this.history.pop();
      }
    } finally {
      this.abortController = undefined;
      this.view?.webview.postMessage({ type: 'assistantEnd' });
    }
  }

  private getHtml(): string {
    const nonce = String(Date.now());
    const markdownStyles = getMarkdownStyles();
    const markdownScript = getMarkdownClientScript();

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .topbar {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .model-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .model-label {
      font-size: 11px;
      opacity: 0.8;
      width: 74px;
      flex-shrink: 0;
    }
    select {
      flex: 1;
      min-width: 0;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 4px 6px;
      border-radius: 4px;
      outline: none;
      font-size: 12px;
    }
    .icon-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 3px 7px;
      cursor: pointer;
      font-size: 12px;
      flex-shrink: 0;
    }
    .icon-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .extra-models {
      display: none;
      flex-direction: column;
      gap: 5px;
      padding-top: 2px;
    }
    .extra-models.open {
      display: flex;
    }
    .mode-switcher {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4px;
    }
    .mode-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      text-align: center;
    }
    .mode-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      padding: 8px 10px;
      border-radius: 6px;
      line-height: 1.45;
      word-break: break-word;
    }
    .msg.user {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      align-self: flex-end;
      max-width: 94%;
      white-space: pre-wrap;
    }
    .msg.assistant {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      align-self: stretch;
    }
    .msg.error {
      border-color: var(--vscode-inputValidation-errorBorder);
      background: var(--vscode-inputValidation-errorBackground);
      white-space: pre-wrap;
    }
    .msg-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      font-size: 11px;
      opacity: 0.85;
    }
    .mode-tag {
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.4px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 6px;
    }
    .badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .edits-box {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .edits-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      opacity: 0.9;
    }
    .edit-card {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 6px 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    .edit-path {
      font-family: var(--vscode-editor-font-family);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .edit-actions {
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .composer {
      position: relative;
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .snippet-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 6px;
    }
    .snippet-chips:empty {
      display: none;
    }
    .snippet-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      max-width: 100%;
    }
    .snippet-chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .snippet-chip button {
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0 2px;
      font-weight: 700;
      font-size: 12px;
      line-height: 1;
    }
    .autocomplete {
      position: absolute;
      bottom: calc(100% - 4px);
      left: 8px;
      right: 8px;
      max-height: 220px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background, var(--vscode-editor-background));
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border));
      border-radius: 4px;
      box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.45);
      display: none;
      z-index: 999;
    }
    .autocomplete.visible {
      display: block;
    }
    .ac-header {
      padding: 4px 8px;
      font-size: 11px;
      opacity: 0.75;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .ac-item {
      padding: 6px 8px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ac-item:hover, .ac-item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .ac-empty {
      padding: 8px;
      font-size: 12px;
      opacity: 0.8;
    }
    textarea {
      width: 100%;
      min-height: 68px;
      max-height: 160px;
      resize: vertical;
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: inherit;
      outline: none;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    .actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 6px;
      gap: 6px;
    }
    .hint {
      font-size: 11px;
      opacity: 0.75;
    }
    button.primary-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button.primary-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    ${markdownStyles}
  </style>
</head>
<body>
  <div class="topbar">
    <div class="model-row">
      <span class="model-label" title="Modelo principal (Chat/Plan/Agent)">Chat:</span>
      <select id="modelSelect" title="Modelo local do Ollama para Chat/Agent"></select>
      <button type="button" id="toggleExtraModelsBtn" class="icon-btn" title="Configurar modelos de Embedding e Autocomplete">⚙️</button>
      <button type="button" id="refreshModelsBtn" class="icon-btn" title="Atualizar lista de modelos do Ollama">↻</button>
    </div>
    <div class="extra-models" id="extraModelsPanel">
      <div class="model-row">
        <span class="model-label" title="Modelo usado para gerar vetores/embeddings">Embedding:</span>
        <select id="embeddingModelSelect" title="Modelo de Embedding"></select>
      </div>
      <div class="model-row">
        <span class="model-label" title="Modelo usado para sugestões inline no editor">Autocomplete:</span>
        <select id="autocompleteModelSelect" title="Modelo de Autocomplete (FIM)"></select>
      </div>
    </div>
    <div class="mode-switcher" role="tablist" aria-label="Modo do assistente">
      <button type="button" class="mode-btn active" data-mode="chat" title="Conversa e análise de código">Chat</button>
      <button type="button" class="mode-btn" data-mode="plan" title="Planejamento passo a passo sem editar arquivos">Plan</button>
      <button type="button" class="mode-btn" data-mode="agent" title="Execução e edição direta de arquivos">Agent</button>
    </div>
  </div>

  <div class="messages" id="messages"></div>

  <div class="composer">
    <div class="autocomplete" id="autocomplete"></div>
    <div class="snippet-chips" id="snippetChips"></div>
    <textarea id="promptInput" placeholder="Ex: Compare @src/utils/ e @src/extension.ts (Enter envia, Shift+Enter quebra linha)"></textarea>
    <div class="actions">
      <span class="hint" id="modeHint"><strong>@</strong> arquivo ou pasta • múltiplos <strong>@</strong></span>
      <div>
        <button id="stopBtn" class="secondary-btn" style="display:none;">Parar</button>
        <button id="sendBtn" class="primary-btn">Enviar</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    ${markdownScript}

    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const promptInput = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
    const modelSelect = document.getElementById('modelSelect');
    const embeddingModelSelect = document.getElementById('embeddingModelSelect');
    const autocompleteModelSelect = document.getElementById('autocompleteModelSelect');
    const toggleExtraModelsBtn = document.getElementById('toggleExtraModelsBtn');
    const refreshModelsBtn = document.getElementById('refreshModelsBtn');
    const extraModelsPanel = document.getElementById('extraModelsPanel');
    const autocompleteEl = document.getElementById('autocomplete');
    const snippetChipsEl = document.getElementById('snippetChips');
    const modeButtons = Array.from(document.querySelectorAll('.mode-btn'));
    const modeHintEl = document.getElementById('modeHint');

    let selectedMode = 'chat';
    let attachedSnippets = [];
    let currentAssistantEl = null;
    let currentAssistantTextEl = null;
    let currentAssistantRawText = '';
    let isGenerating = false;
    let acItems = [];
    let acIndex = 0;
    let activeMentionStart = -1;
    let latestSearchRequestId = 0;

    toggleExtraModelsBtn.addEventListener('click', () => {
      extraModelsPanel.classList.toggle('open');
    });

    refreshModelsBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshModels' });
    });

    function populateModelSelect(selectEl, models, selectedValue, allowEmptyLabel) {
      selectEl.innerHTML = '';
      if (allowEmptyLabel) {
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = allowEmptyLabel;
        if (!selectedValue) emptyOpt.selected = true;
        selectEl.appendChild(emptyOpt);
      }
      (models || []).forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === selectedValue) opt.selected = true;
        selectEl.appendChild(opt);
      });
    }

    function renderSnippetChips() {
      snippetChipsEl.innerHTML = '';
      attachedSnippets.forEach((snip) => {
        const chip = document.createElement('div');
        chip.className = 'snippet-chip';

        const label = document.createElement('span');
        label.textContent = '✂️ ' + snip.filePath + ':' + snip.startLine + '-' + snip.endLine;
        label.title = snip.filePath + ' (linhas ' + snip.startLine + ' a ' + snip.endLine + ')';

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remover trecho';
        removeBtn.addEventListener('click', () => {
          attachedSnippets = attachedSnippets.filter((s) => s.id !== snip.id);
          renderSnippetChips();
        });

        chip.appendChild(label);
        chip.appendChild(removeBtn);
        snippetChipsEl.appendChild(chip);
      });
    }

    function updateModeUi(mode) {
      selectedMode = mode;
      modeButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
      });
      if (mode === 'plan') {
        modeHintEl.innerHTML = 'Modo <strong>Plan</strong>: monta o plano sem alterar arquivos';
      } else if (mode === 'agent') {
        modeHintEl.innerHTML = 'Modo <strong>Agent</strong>: gera alterações aplicáveis nos arquivos';
      } else {
        modeHintEl.innerHTML = '<strong>@</strong> arquivo ou pasta • múltiplos <strong>@</strong>';
      }
    }

    modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        updateModeUi(mode);
        vscode.postMessage({ type: 'selectMode', mode });
      });
    });

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addUserBubble(text, attachedMentions, mode) {
      const div = document.createElement('div');
      div.className = 'msg user';

      const header = document.createElement('div');
      header.className = 'msg-header';
      const tag = document.createElement('span');
      tag.className = 'mode-tag';
      tag.textContent = mode || 'chat';
      header.appendChild(tag);
      div.appendChild(header);

      if (attachedMentions && attachedMentions.length > 0) {
        const badges = document.createElement('div');
        badges.className = 'badges';
        attachedMentions.forEach((m) => {
          const b = document.createElement('span');
          b.className = 'badge';
          b.textContent = m.startsWith('@') ? m : '@' + m;
          badges.appendChild(b);
        });
        div.appendChild(badges);
      }

      const content = document.createElement('div');
      content.textContent = text;
      div.appendChild(content);

      messagesEl.appendChild(div);
      scrollToBottom();
    }

    function renderProposedEdits(containerEl, edits) {
      if (!edits || edits.length === 0) return;

      const box = document.createElement('div');
      box.className = 'edits-box';

      const toolbar = document.createElement('div');
      toolbar.className = 'edits-toolbar';
      const countLabel = document.createElement('span');
      countLabel.textContent = edits.length + ' arquivo(s) sugerido(s)';
      toolbar.appendChild(countLabel);

      if (edits.length > 1) {
        const applyAllBtn = document.createElement('button');
        applyAllBtn.className = 'primary-btn';
        applyAllBtn.textContent = 'Aplicar Todos';
        applyAllBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'applyAllEdits', edits });
        });
        toolbar.appendChild(applyAllBtn);
      }

      box.appendChild(toolbar);

      edits.forEach((edit) => {
        const card = document.createElement('div');
        card.className = 'edit-card';

        const pathSpan = document.createElement('span');
        pathSpan.className = 'edit-path';
        pathSpan.title = edit.filePath;
        pathSpan.textContent = edit.filePath;

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'edit-actions';

        const diffBtn = document.createElement('button');
        diffBtn.className = 'secondary-btn';
        diffBtn.textContent = 'Ver Diff';
        diffBtn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'previewEdit',
            filePath: edit.filePath,
            content: edit.content
          });
        });

        const applyBtn = document.createElement('button');
        applyBtn.className = 'primary-btn';
        applyBtn.textContent = 'Aplicar';
        applyBtn.dataset.filePath = edit.filePath;
        applyBtn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'applyEdit',
            filePath: edit.filePath,
            content: edit.content
          });
        });

        actionsDiv.appendChild(diffBtn);
        actionsDiv.appendChild(applyBtn);
        card.appendChild(pathSpan);
        card.appendChild(actionsDiv);
        box.appendChild(card);
      });

      containerEl.appendChild(box);
      scrollToBottom();
    }

    function hideAutocomplete() {
      autocompleteEl.classList.remove('visible');
      autocompleteEl.innerHTML = '';
      acItems = [];
      acIndex = 0;
      activeMentionStart = -1;
    }

    function showAutocompleteLoading() {
      autocompleteEl.innerHTML = '<div class="ac-empty">Buscando pastas e arquivos...</div>';
      autocompleteEl.classList.add('visible');
    }

    function renderAutocomplete(emptyReason) {
      autocompleteEl.innerHTML = '';

      if (acItems.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'ac-empty';
        emptyEl.textContent = emptyReason || 'Nenhum arquivo ou pasta encontrado.';
        autocompleteEl.appendChild(emptyEl);
        autocompleteEl.classList.add('visible');
        return;
      }

      const header = document.createElement('div');
      header.className = 'ac-header';
      header.textContent = 'Pastas e arquivos (↑/↓ para navegar, Enter/Tab para selecionar)';
      autocompleteEl.appendChild(header);

      acItems.forEach((item, idx) => {
        const el = document.createElement('div');
        el.className = 'ac-item' + (idx === acIndex ? ' active' : '');
        el.textContent = item.label;
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          applyMention(item);
        });
        autocompleteEl.appendChild(el);
      });

      const activeEl = autocompleteEl.querySelector('.ac-item.active');
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }

      autocompleteEl.classList.add('visible');
    }

    function applyMention(item) {
      if (activeMentionStart === -1 || !item) return;
      const cursor = promptInput.selectionStart;
      const before = promptInput.value.slice(0, activeMentionStart);
      const after = promptInput.value.slice(cursor);
      const inserted = '@' + item.insertValue + ' ';
      promptInput.value = before + inserted + after;
      const newPos = before.length + inserted.length;
      promptInput.setSelectionRange(newPos, newPos);
      promptInput.focus();
      hideAutocomplete();
    }

    function triggerMentionCheck() {
      const cursor = promptInput.selectionStart;
      const textBeforeCursor = promptInput.value.slice(0, cursor);
      const match = textBeforeCursor.match(/(?:^|[\s([{"'])@([^\s@)\]}"',;]*)$/);

      if (match) {
        const query = match[1];
        activeMentionStart = textBeforeCursor.lastIndexOf('@');
        latestSearchRequestId += 1;
        if (acItems.length === 0) {
          showAutocompleteLoading();
        }
        vscode.postMessage({
          type: 'searchMentions',
          query,
          requestId: latestSearchRequestId
        });
      } else {
        hideAutocomplete();
      }
    }

    promptInput.addEventListener('input', triggerMentionCheck);
    promptInput.addEventListener('click', triggerMentionCheck);

    promptInput.addEventListener('keydown', (e) => {
      if (autocompleteEl.classList.contains('visible') && acItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          acIndex = (acIndex + 1) % acItems.length;
          renderAutocomplete();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          acIndex = (acIndex - 1 + acItems.length) % acItems.length;
          renderAutocomplete();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          applyMention(acItems[acIndex]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideAutocomplete();
          return;
        }
      } else if (autocompleteEl.classList.contains('visible') && e.key === 'Escape') {
        e.preventDefault();
        hideAutocomplete();
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    });

    function sendPrompt() {
      if (isGenerating) return;
      const text = promptInput.value.trim();
      if (!text && attachedSnippets.length === 0) return;

      const snippetsToSend = [...attachedSnippets];
      promptInput.value = '';
      attachedSnippets = [];
      renderSnippetChips();
      hideAutocomplete();

      vscode.postMessage({
        type: 'sendMessage',
        text,
        model: modelSelect.value,
        mode: selectedMode,
        snippets: snippetsToSend
      });
    }

    sendBtn.addEventListener('click', sendPrompt);
    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'stopGeneration' });
    });

    modelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectModel', model: modelSelect.value });
    });

    embeddingModelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectEmbeddingModel', model: embeddingModelSelect.value });
    });

    autocompleteModelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectAutocompleteModel', model: autocompleteModelSelect.value });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          populateModelSelect(modelSelect, msg.chatModels, msg.selectedModel, null);
          populateModelSelect(embeddingModelSelect, msg.embeddingModels, msg.selectedEmbeddingModel, '(Nenhum)');
          populateModelSelect(autocompleteModelSelect, msg.autocompleteModels, msg.selectedAutocompleteModel, '(Desativado)');
          if (msg.mode) {
            updateModeUi(msg.mode);
          }
          break;

        case 'injectContext': {
          const payload = msg.payload || {};
          if (payload.mode) {
            updateModeUi(payload.mode);
          }
          if (Array.isArray(payload.appendMentions) && payload.appendMentions.length > 0) {
            const tokens = payload.appendMentions.map((m) => '@' + m).join(' ');
            const current = promptInput.value;
            const sep = current && !/\s$/.test(current) ? ' ' : '';
            promptInput.value = current + sep + tokens + ' ';
          }
          if (payload.snippet) {
            attachedSnippets.push(payload.snippet);
            renderSnippetChips();
          }
          promptInput.focus();
          const endPos = promptInput.value.length;
          promptInput.setSelectionRange(endPos, endPos);
          break;
        }

        case 'mentionSuggestions':
          if (activeMentionStart !== -1 && (!msg.requestId || msg.requestId === latestSearchRequestId)) {
            acItems = msg.suggestions || [];
            acIndex = 0;
            renderAutocomplete(msg.emptyReason);
          }
          break;

        case 'userMessage':
          addUserBubble(msg.text, msg.attachedMentions, msg.mode);
          break;

        case 'assistantStart':
          isGenerating = true;
          currentAssistantRawText = '';
          sendBtn.style.display = 'none';
          stopBtn.style.display = 'inline-block';
          currentAssistantEl = document.createElement('div');
          currentAssistantEl.className = 'msg assistant';

          const header = document.createElement('div');
          header.className = 'msg-header';
          const tag = document.createElement('span');
          tag.className = 'mode-tag';
          tag.textContent = msg.mode || selectedMode;
          header.appendChild(tag);
          currentAssistantEl.appendChild(header);

          currentAssistantTextEl = document.createElement('div');
          currentAssistantTextEl.className = 'md-content';
          currentAssistantTextEl.textContent = '...';
          currentAssistantEl.appendChild(currentAssistantTextEl);
          messagesEl.appendChild(currentAssistantEl);
          scrollToBottom();
          break;

        case 'assistantChunk':
          if (currentAssistantTextEl) {
            currentAssistantRawText += msg.chunk || '';
            currentAssistantTextEl.innerHTML = renderMarkdownToHtml(currentAssistantRawText);
            scrollToBottom();
          }
          break;

        case 'proposedEdits':
          if (currentAssistantEl) {
            renderProposedEdits(currentAssistantEl, msg.edits);
          }
          break;

        case 'editStatus':
          if (msg.applied) {
            const buttons = messagesEl.querySelectorAll('button[data-file-path]');
            buttons.forEach((btn) => {
              if (btn.dataset.filePath === msg.filePath) {
                btn.textContent = 'Aplicado';
                btn.disabled = true;
              }
            });
          }
          break;

        case 'assistantError':
          if (currentAssistantEl && currentAssistantTextEl) {
            currentAssistantEl.classList.add('error');
            currentAssistantTextEl.classList.remove('md-content');
            currentAssistantTextEl.textContent = msg.error;
          }
          break;

        case 'assistantEnd':
          if (currentAssistantTextEl && currentAssistantRawText) {
            currentAssistantTextEl.innerHTML = renderMarkdownToHtml(currentAssistantRawText);
          }
          currentAssistantRawText = '';
          isGenerating = false;
          sendBtn.style.display = 'inline-block';
          stopBtn.style.display = 'none';
          currentAssistantEl = null;
          currentAssistantTextEl = null;
          break;

        case 'clearMessages':
          messagesEl.innerHTML = '';
          break;
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

async function resolveUrisToMentions(
  primaryUri?: any,
  selectedUris?: any[]
): Promise<string[]> {
  const targets =
    Array.isArray(selectedUris) && selectedUris.length > 0
      ? selectedUris
      : primaryUri
        ? [primaryUri]
        : vscode.window.activeTextEditor
          ? [vscode.window.activeTextEditor.document.uri]
          : [];

  const mentions: string[] = [];

  for (const uri of targets) {
    if (uri.scheme !== 'file') {
      continue;
    }
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) {
      continue;
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const isDir = (stat.type & vscode.FileType.Directory) !== 0;
      mentions.push(isDir ? `${rel.replace(/\/+$/, '')}/` : rel);
    } catch {
      mentions.push(rel);
    }
  }

  return Array.from(new Set(mentions));
}

function getActiveSelectionSnippet(): CodeSnippetAttachment | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }

  const code = editor.document.getText(editor.selection);
  if (!code.trim()) {
    return undefined;
  }

  const relPath = vscode.workspace
    .asRelativePath(editor.document.uri, false)
    .replace(/\\/g, '/');

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    filePath: relPath,
    startLine: editor.selection.start.line + 1,
    endLine: editor.selection.end.line + 1,
    languageId: editor.document.languageId,
    code
  };
}

export function activate(context: any) {
  const provider = new OllamaChatViewProvider(context.extensionUri);
  const inlineProvider = new OllamaInlineCompletionProvider();

  const registerExplorerModeCommand = (commandId: string, mode: AssistantMode) =>
    vscode.commands.registerCommand(
      commandId,
      async (primaryUri?: any, selectedUris?: any[]) => {
        const mentions = await resolveUrisToMentions(primaryUri, selectedUris);
        if (mentions.length === 0) {
          vscode.window.showWarningMessage('Nenhum arquivo ou pasta válido selecionado.');
          return;
        }
        await provider.revealAndInjectContext({
          mode,
          appendMentions: mentions
        });
      }
    );

  const registerSelectionModeCommand = (commandId: string, mode: AssistantMode) =>
    vscode.commands.registerCommand(commandId, async () => {
      const snippet = getActiveSelectionSnippet();
      if (!snippet) {
        vscode.window.showWarningMessage('Selecione um trecho de código no editor primeiro.');
        return;
      }
      await provider.revealAndInjectContext({
        mode,
        snippet
      });
    });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OllamaChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      inlineProvider
    ),
    vscode.commands.registerCommand('ollamaLocal.clearChat', () => {
      provider.clearHistory();
    }),
    registerExplorerModeCommand('ollamaLocal.addResourceToChat', 'chat'),
    registerExplorerModeCommand('ollamaLocal.addResourceToPlan', 'plan'),
    registerExplorerModeCommand('ollamaLocal.addResourceToAgent', 'agent'),
    registerSelectionModeCommand('ollamaLocal.addSelectionToChat', 'chat'),
    registerSelectionModeCommand('ollamaLocal.addSelectionToPlan', 'plan'),
    registerSelectionModeCommand('ollamaLocal.addSelectionToAgent', 'agent')
  );
}

export function deactivate() {}