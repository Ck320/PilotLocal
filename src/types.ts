export type AssistantMode = 'chat' | 'plan' | 'agent';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProposedFileEdit {
  filePath: string;
  content: string;
}

export interface MentionSuggestion {
  kind: 'file' | 'folder';
  label: string;
  insertValue: string;
}

export interface ResolvedMentionContext {
  attachedMentions: string[];
  sections: string[];
}

export interface CodeSnippetAttachment {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  languageId: string;
  code: string;
}

export interface PendingComposerPayload {
  mode: AssistantMode;
  appendMentions?: string[];
  snippet?: CodeSnippetAttachment;
}

export interface OllamaModelCatalog {
  chatModels: string[];
  embeddingModels: string[];
  autocompleteModels: string[];
}