import { getOllamaSettings } from './ollamaClient';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode: any = require('vscode');

export async function requestFimCompletion(options: {
  prefix: string;
  suffix: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { host, autocompleteModel } = getOllamaSettings();
  if (!autocompleteModel || !options.prefix.trim()) {
    return '';
  }

  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      model: autocompleteModel,
      prompt: options.prefix,
      suffix: options.suffix,
      stream: false,
      options: {
        num_predict: 128,
        temperature: 0.2,
        stop: ['\n\n', '```']
      }
    })
  });

  if (!res.ok) {
    return '';
  }

  const data = (await res.json()) as { response?: string };
  return data.response || '';
}

export class OllamaInlineCompletionProvider {
  private lastRequestTime = 0;

  public async provideInlineCompletionItems(
    document: any,
    position: any,
    _context: any,
    token: any
  ): Promise<any[]> {
    const { autocompleteModel } = getOllamaSettings();
    if (!autocompleteModel) {
      return [];
    }

    const requestTime = Date.now();
    this.lastRequestTime = requestTime;
    await new Promise((resolve) => setTimeout(resolve, 350));

    if (token.isCancellationRequested || this.lastRequestTime !== requestTime) {
      return [];
    }

    const startLine = Math.max(0, position.line - 60);
    const endLine = Math.min(document.lineCount - 1, position.line + 25);

    const prefix = document.getText(
      new vscode.Range(startLine, 0, position.line, position.character)
    );
    const suffix = document.getText(
      new vscode.Range(
        position.line,
        position.character,
        endLine,
        document.lineAt(endLine).text.length
      )
    );

    if (!prefix.trim()) {
      return [];
    }

    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());

    try {
      const suggestion = await requestFimCompletion({
        prefix,
        suffix,
        signal: controller.signal
      });

      if (!suggestion.trim() || token.isCancellationRequested) {
        return [];
      }

      return [
        new vscode.InlineCompletionItem(suggestion, new vscode.Range(position, position))
      ];
    } catch {
      return [];
    }
  }
}