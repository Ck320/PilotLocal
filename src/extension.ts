import * as vscode from 'vscode';
import * as path from 'path';

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

function extractProposedEdits(text: string): ProposedFileEdit[] {
  const edits: ProposedFileEdit[] = [];
  const regex = /```file:([^\r\n`]+)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1].trim();
    const content = match[2].replace(/\r?\n$/, '');
    if (filePath) {
      edits.push({ filePath, content });
    }
  }

  return edits;
}

function getTargetFileUri(relativePath: string): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const cleanPath = relativePath.replace(/^[/\\]+/, '');
  return vscode.Uri.joinPath(folders[0].uri, ...cleanPath.split(/[/\\]/));
}

async function openDiffPreview(relativePath: string, newContent: string) {
  const targetUri = getTargetFileUri(relativePath);
  if (!targetUri) {
    vscode.window.showErrorMessage('Nenhuma pasta aberta no workspace.');
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

async function applyFileEdit(relativePath: string, newContent: string): Promise<boolean> {
  const targetUri = getTargetFileUri(relativePath);
  if (!targetUri) {
    vscode.window.showErrorMessage('Nenhuma pasta aberta no workspace.');
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
  await vscode.window.showTextDocument(savedDoc);
  vscode.window.showInformationMessage(`Alterações aplicadas em ${relativePath}`);
  return true;
}

class OllamaChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ollamaChatView';
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private abortController?: AbortController;

  constructor(private readonly extensionUri: vscode.Uri) {}

  private getConfig() {
    const cfg = vscode.workspace.getConfiguration('ollamaLocal');
    const host = (cfg.get<string>('host') || 'http://localhost:11434').replace(/\/+$/, '');
    const model = cfg.get<string>('model') || 'llama3.2';
    return { host, model };
  }

  public clearHistory() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
    this.history = [];
    this.view?.webview.postMessage({ type: 'clearMessages' });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await this.sendInitialState();
          break;
        case 'selectModel':
          await vscode.workspace
            .getConfiguration('ollamaLocal')
            .update('model', msg.model, vscode.ConfigurationTarget.Global);
          break;
        case 'searchFiles':
          await this.handleFileSearch(msg.query || '');
          break;
        case 'sendMessage':
          await this.handleUserMessage(msg.text || '', msg.model);
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
          const ok = await applyFileEdit(msg.filePath, msg.content);
          this.view?.webview.postMessage({
            type: 'editStatus',
            filePath: msg.filePath,
            applied: ok
          });
          break;
        }
      }
    });
  }

  private async sendInitialState() {
    const { host, model } = this.getConfig();
    let models: string[] = [];
    try {
      const res = await fetch(`${host}/api/tags`);
      if (res.ok) {
        const data = (await res.json()) as OllamaTagsResponse;
        models = (data.models || []).map((m) => m.name);
      }
    } catch {
      // Ollama pode estar offline no momento da abertura
    }

    if (models.length === 0 && model) {
      models = [model];
    }

    this.view?.webview.postMessage({
      type: 'init',
      models,
      selectedModel: models.includes(model) ? model : models[0] || model
    });
  }

  private async handleFileSearch(query: string) {
    const excludePattern = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.venv/**,**/__pycache__/**}';
    const uris = await vscode.workspace.findFiles('**/*', excludePattern, 200);

    const normalizedQuery = query.toLowerCase();
    const files = uris
      .map((uri) => vscode.workspace.asRelativePath(uri, false))
      .filter((relPath) => relPath.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => a.length - b.length)
      .slice(0, 20);

    this.view?.webview.postMessage({
      type: 'fileSuggestions',
      files
    });
  }

  private async buildPromptWithReferencedFiles(rawText: string): Promise<{
    enrichedPrompt: string;
    attachedFiles: string[];
  }> {
    const mentionRegex = /(?:^|\s)@([^\s@]+)/g;
    const matches = [...rawText.matchAll(mentionRegex)];
    const uniquePaths = Array.from(new Set(matches.map((m) => m[1])));

    if (uniquePaths.length === 0) {
      return { enrichedPrompt: rawText, attachedFiles: [] };
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return { enrichedPrompt: rawText, attachedFiles: [] };
    }

    const rootUri = workspaceFolders[0].uri;
    const fileSections: string[] = [];
    const attachedFiles: string[] = [];

    for (const relPath of uniquePaths) {
      try {
        const cleanPath = relPath.replace(/^[/\\]+/, '');
        const fileUri = vscode.Uri.joinPath(rootUri, ...cleanPath.split(/[/\\]/));
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const content = new TextDecoder('utf-8').decode(bytes);
        const ext = path.extname(cleanPath).replace('.', '') || 'txt';

        attachedFiles.push(cleanPath);
        fileSections.push(`Arquivo: \`${cleanPath}\`\n\`\`\`${ext}\n${content}\n\`\`\``);
      } catch {
        // Ignora referências que não correspondem a arquivos válidos
      }
    }

    if (fileSections.length === 0) {
      return { enrichedPrompt: rawText, attachedFiles: [] };
    }

    const editInstruction =
      '\nQuando você propuser alterações completas para um arquivo existente ou novo, inclua o código atualizado dentro de um bloco exatamente neste formato:\n' +
      '```file:caminho/do/arquivo.ext\n<código completo do arquivo>\n```';

    const enrichedPrompt =
      `${rawText}${editInstruction}\n\n---\nContexto dos arquivos referenciados:\n\n${fileSections.join('\n\n')}`;

    return { enrichedPrompt, attachedFiles };
  }

  private async handleUserMessage(rawText: string, chosenModel?: string) {
    const trimmed = rawText.trim();
    if (!trimmed) {
      return;
    }

    const { host, model: defaultModel } = this.getConfig();
    const model = chosenModel || defaultModel;

    const { enrichedPrompt, attachedFiles } = await this.buildPromptWithReferencedFiles(trimmed);

    this.view?.webview.postMessage({
      type: 'userMessage',
      text: trimmed,
      attachedFiles
    });

    this.history.push({
      role: 'user',
      content: enrichedPrompt
    });

    this.view?.webview.postMessage({ type: 'assistantStart' });

    this.abortController = new AbortController();
    let assistantReply = '';

    try {
      const res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this.abortController.signal,
        body: JSON.stringify({
          model,
          messages: this.history,
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
        const proposedEdits = extractProposedEdits(assistantReply);
        if (proposedEdits.length > 0) {
          this.view?.webview.postMessage({
            type: 'proposedEdits',
            edits: proposedEdits
          });
        }
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        if (assistantReply) {
          this.history.push({ role: 'assistant', content: assistantReply });
          const proposedEdits = extractProposedEdits(assistantReply);
          if (proposedEdits.length > 0) {
            this.view?.webview.postMessage({
              type: 'proposedEdits',
              edits: proposedEdits
            });
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

  private getHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now());

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
      gap: 6px;
      align-items: center;
    }
    select {
      flex: 1;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 4px 6px;
      border-radius: 4px;
      outline: none;
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
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.user {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      align-self: flex-end;
      max-width: 92%;
    }
    .msg.assistant {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      align-self: stretch;
    }
    .msg.error {
      border-color: var(--vscode-inputValidation-errorBorder);
      background: var(--vscode-inputValidation-errorBackground);
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
    .autocomplete {
      position: absolute;
      bottom: 100%;
      left: 8px;
      right: 8px;
      max-height: 180px;
      overflow-y: auto;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      display: none;
      z-index: 20;
    }
    .autocomplete.visible {
      display: block;
    }
    .ac-item {
      padding: 5px 8px;
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
    textarea {
      width: 100%;
      min-height: 64px;
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
    }
    .hint {
      font-size: 11px;
      opacity: 0.75;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
  </style>
</head>
<body>
  <div class="topbar">
    <select id="modelSelect" title="Modelo local do Ollama"></select>
  </div>

  <div class="messages" id="messages"></div>

  <div class="composer">
    <div class="autocomplete" id="autocomplete"></div>
    <textarea id="promptInput" placeholder="Pergunte algo... Use @ para anexar arquivos (Enter envia, Shift+Enter quebra linha)"></textarea>
    <div class="actions">
      <span class="hint">Digite <strong>@</strong> para buscar arquivos</span>
      <div>
        <button id="stopBtn" class="secondary" style="display:none;">Parar</button>
        <button id="sendBtn">Enviar</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const promptInput = document.getElementById('promptInput');
    const sendBtn = document.getElementById('sendBtn');
    const stopBtn = document.getElementById('stopBtn');
    const modelSelect = document.getElementById('modelSelect');
    const autocompleteEl = document.getElementById('autocomplete');

    let currentAssistantEl = null;
    let currentAssistantTextEl = null;
    let isGenerating = false;
    let acFiles = [];
    let acIndex = 0;
    let activeMentionStart = -1;

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addUserBubble(text, attachedFiles) {
      const div = document.createElement('div');
      div.className = 'msg user';

      if (attachedFiles && attachedFiles.length > 0) {
        const badges = document.createElement('div');
        badges.className = 'badges';
        attachedFiles.forEach((f) => {
          const b = document.createElement('span');
          b.className = 'badge';
          b.textContent = '@' + f;
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
        diffBtn.className = 'secondary';
        diffBtn.textContent = 'Ver Diff';
        diffBtn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'previewEdit',
            filePath: edit.filePath,
            content: edit.content
          });
        });

        const applyBtn = document.createElement('button');
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
      acFiles = [];
      acIndex = 0;
      activeMentionStart = -1;
    }

    function renderAutocomplete() {
      if (acFiles.length === 0) {
        hideAutocomplete();
        return;
      }
      autocompleteEl.innerHTML = '';
      acFiles.forEach((file, idx) => {
        const item = document.createElement('div');
        item.className = 'ac-item' + (idx === acIndex ? ' active' : '');
        item.textContent = file;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          applyFileMention(file);
        });
        autocompleteEl.appendChild(item);
      });
      autocompleteEl.classList.add('visible');
    }

    function applyFileMention(filePath) {
      if (activeMentionStart === -1) return;
      const cursor = promptInput.selectionStart;
      const before = promptInput.value.slice(0, activeMentionStart);
      const after = promptInput.value.slice(cursor);
      const inserted = '@' + filePath + ' ';
      promptInput.value = before + inserted + after;
      const newPos = before.length + inserted.length;
      promptInput.setSelectionRange(newPos, newPos);
      promptInput.focus();
      hideAutocomplete();
    }

    promptInput.addEventListener('input', () => {
      const cursor = promptInput.selectionStart;
      const textBeforeCursor = promptInput.value.slice(0, cursor);
      const match = textBeforeCursor.match(/(?:^|\s)@([^\s@]*)$/);

      if (match) {
        const query = match[1];
        activeMentionStart = textBeforeCursor.lastIndexOf('@');
        vscode.postMessage({ type: 'searchFiles', query });
      } else {
        hideAutocomplete();
      }
    });

    promptInput.addEventListener('keydown', (e) => {
      if (autocompleteEl.classList.contains('visible')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          acIndex = (acIndex + 1) % acFiles.length;
          renderAutocomplete();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          acIndex = (acIndex - 1 + acFiles.length) % acFiles.length;
          renderAutocomplete();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          applyFileMention(acFiles[acIndex]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideAutocomplete();
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
      }
    });

    function sendPrompt() {
      if (isGenerating) return;
      const text = promptInput.value.trim();
      if (!text) return;

      promptInput.value = '';
      hideAutocomplete();
      vscode.postMessage({
        type: 'sendMessage',
        text,
        model: modelSelect.value
      });
    }

    sendBtn.addEventListener('click', sendPrompt);
    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'stopGeneration' });
    });

    modelSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectModel', model: modelSelect.value });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          modelSelect.innerHTML = '';
          msg.models.forEach((m) => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === msg.selectedModel) opt.selected = true;
            modelSelect.appendChild(opt);
          });
          break;

        case 'fileSuggestions':
          if (activeMentionStart !== -1) {
            acFiles = msg.files || [];
            acIndex = 0;
            renderAutocomplete();
          }
          break;

        case 'userMessage':
          addUserBubble(msg.text, msg.attachedFiles);
          break;

        case 'assistantStart':
          isGenerating = true;
          sendBtn.style.display = 'none';
          stopBtn.style.display = 'inline-block';
          currentAssistantEl = document.createElement('div');
          currentAssistantEl.className = 'msg assistant';
          currentAssistantTextEl = document.createElement('div');
          currentAssistantTextEl.textContent = '...';
          currentAssistantEl.appendChild(currentAssistantTextEl);
          messagesEl.appendChild(currentAssistantEl);
          scrollToBottom();
          break;

        case 'assistantChunk':
          if (currentAssistantTextEl) {
            if (currentAssistantTextEl.textContent === '...') {
              currentAssistantTextEl.textContent = '';
            }
            currentAssistantTextEl.textContent += msg.chunk;
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
            currentAssistantTextEl.textContent = msg.error;
          }
          break;

        case 'assistantEnd':
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

export function activate(context: vscode.ExtensionContext) {
  const provider = new OllamaChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OllamaChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('ollamaLocal.clearChat', () => {
      provider.clearHistory();
    })
  );
}

export function deactivate() {}