import * as path from 'path';
import {
  AssistantMode,
  CodeSnippetAttachment,
  ProposedFileEdit,
  ResolvedMentionContext
} from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode: any = require('vscode');

export const IGNORED_DIRS = new Set([
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

export const EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/.next/**,**/build/**,**/*.lock,**/*.vsix,**/*.png,**/*.jpg,**/*.jpeg,**/*.webp,**/*.gif,**/*.ico,**/*.pdf,**/*.zip,**/*.tar,**/*.gz}';

const MAX_FOLDER_FILES = 15;
const MAX_FILE_CHARS = 12000;
const MAX_TOTAL_CONTEXT_CHARS = 45000;

export function normalizeRelativeFilePath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^(?:\/\/|#|\/\*|--)\s*/, '')
    .replace(/\s*\*\/$/, '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

export function resolveSafeWorkspacePath(
  workspaceRoot: string,
  relativePath: string
): string | undefined {
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

export function extractProposedEdits(text: string): ProposedFileEdit[] {
  const editsByPath = new Map<string, string>();
  const fenceRegex = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    const infoString = (match[1] || '').trim();
    const content = match[2].replace(/\r?\n$/, '');

    const filePrefixMatch = infoString.match(/^file:(.+)$/i);
    if (filePrefixMatch) {
      const cleanPath = normalizeRelativeFilePath(filePrefixMatch[1]);
      if (cleanPath && !cleanPath.split('/').includes('..')) {
        editsByPath.set(cleanPath, content);
      }
      continue;
    }

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

export function getTargetFileUri(relativePath: string): any | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const rootUri = folders[0].uri;
  const safeFsPath = resolveSafeWorkspacePath(rootUri.fsPath, relativePath);
  if (!safeFsPath) {
    vscode.window.showWarningMessage(
      `Caminho inválido ou fora do workspace ignorado: ${relativePath}`
    );
    return undefined;
  }

  return vscode.Uri.file(safeFsPath);
}

export async function openDiffPreview(relativePath: string, newContent: string): Promise<void> {
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

export async function applyFileEdit(
  relativePath: string,
  newContent: string,
  showNotification = true
): Promise<boolean> {
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

export async function collectWorkspaceEntries(
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

async function readFileForContext(fileUri: any, relPath: string): Promise<string | undefined> {
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

async function resolveSingleMention(
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
      const section = await readFileForContext(fUri, relFile);
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
    const section = await readFileForContext(targetUri, normalizedPath);
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

export async function buildPromptWithContext(
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
    const allWorkspaceFiles = uris.map((u) =>
      vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/')
    );

    const alreadyIncluded = new Set<string>();
    const totalCharsRef = { count: 0 };

    for (const token of uniqueTokens) {
      const resolved = await resolveSingleMention(
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

export async function resolveUrisToMentions(
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
    const rel = vscode.workspace
      .asRelativePath(uri, false)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
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

export function getActiveSelectionSnippet(): CodeSnippetAttachment | undefined {
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