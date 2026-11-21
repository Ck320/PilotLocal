import { AssistantMode } from './types';
import { OllamaInlineCompletionProvider } from './models/autocompleteModel';
import { generateEmbedding, generateBatchEmbeddings } from './models/embeddingModel';
import { OllamaChatViewProvider } from './webview/chatViewProvider';
import { getActiveSelectionSnippet, resolveUrisToMentions } from './workspaceUtils';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode: any = require('vscode');

export { generateEmbedding, generateBatchEmbeddings };

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
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineProvider),
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