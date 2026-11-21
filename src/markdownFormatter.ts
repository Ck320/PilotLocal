export function getMarkdownStyles(): string {
  return `
    .md-content {
      white-space: normal;
      line-height: 1.5;
      word-break: break-word;
    }
    .md-content p {
      margin: 0 0 8px 0;
    }
    .md-content p:last-child {
      margin-bottom: 0;
    }
    .md-content h1, .md-content h2, .md-content h3, .md-content h4 {
      margin: 12px 0 6px 0;
      font-weight: 700;
      line-height: 1.3;
    }
    .md-content h1 { font-size: 1.25em; }
    .md-content h2 { font-size: 1.15em; }
    .md-content h3 { font-size: 1.05em; }
    .md-content ul, .md-content ol {
      margin: 4px 0 8px 0;
      padding-left: 20px;
    }
    .md-content li {
      margin: 2px 0;
    }
    .md-content blockquote {
      margin: 6px 0;
      padding: 4px 10px;
      border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder));
      background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
    }
    .md-content code.inline-code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.92em;
      padding: 1px 4px;
      border-radius: 3px;
      background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.2));
    }
    .md-code-block {
      margin: 8px 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      overflow: hidden;
      background: var(--vscode-textCodeBlock-background, var(--vscode-sideBar-background));
    }
    .md-code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 8px;
      font-size: 11px;
      opacity: 0.85;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: rgba(127, 127, 127, 0.08);
    }
    .md-copy-btn {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      border-radius: 3px;
      padding: 1px 6px;
      font-size: 10px;
      cursor: pointer;
    }
    .md-copy-btn:hover {
      background: var(--vscode-button-secondaryBackground);
    }
    .md-code-block pre {
      margin: 0;
      padding: 8px 10px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.92em;
      line-height: 1.4;
      white-space: pre;
    }
    .md-content a {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
    }
    .md-content hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 10px 0;
    }
  `;
}

export function getMarkdownClientScript(): string {
  return `
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatInlineMarkdown(escapedText) {
      // Inline code primeiro para não formatar ** ou * dentro de crases
      const codeTokens = [];
      let text = escapedText.replace(/\`([^\`]+)\`/g, (_, code) => {
        const token = '@@INLINECODE_' + codeTokens.length + '@@';
        codeTokens.push('<code class="inline-code">' + code + '</code>');
        return token;
      });

      // Links [texto](url)
      text = text.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

      // Negrito e itálico
      text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      text = text.replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>');
      text = text.replace(/(^|[^_])_([^_\\n]+)_(?!_)/g, '$1<em>$2</em>');
      text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');

      // Restaura inline code
      codeTokens.forEach((html, idx) => {
        text = text.replace('@@INLINECODE_' + idx + '@@', html);
      });

      return text;
    }

    function renderTextBlocks(rawSegment) {
      const lines = rawSegment.split(/\\r?\\n/);
      const htmlParts = [];
      let inUl = false;
      let inOl = false;
      let paragraphBuffer = [];

      function flushParagraph() {
        if (paragraphBuffer.length > 0) {
          htmlParts.push('<p>' + paragraphBuffer.join('<br>') + '</p>');
          paragraphBuffer = [];
        }
      }

      function closeLists() {
        if (inUl) {
          htmlParts.push('</ul>');
          inUl = false;
        }
        if (inOl) {
          htmlParts.push('</ol>');
          inOl = false;
        }
      }

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();

        if (!trimmed) {
          flushParagraph();
          closeLists();
          continue;
        }

        // Linha horizontal
        if (/^(-{3,}|\\*{3,}|_{3,})$/.test(trimmed)) {
          flushParagraph();
          closeLists();
          htmlParts.push('<hr>');
          continue;
        }

        // Headings (#, ##, ###, ####)
        const headingMatch = trimmed.match(/^(#{1,4})\\s+(.*)$/);
        if (headingMatch) {
          flushParagraph();
          closeLists();
          const level = headingMatch[1].length;
          htmlParts.push('<h' + level + '>' + formatInlineMarkdown(escapeHtml(headingMatch[2])) + '</h' + level + '>');
          continue;
        }

        // Blockquote (> ...)
        const quoteMatch = trimmed.match(/^>\\s?(.*)$/);
        if (quoteMatch) {
          flushParagraph();
          closeLists();
          htmlParts.push('<blockquote>' + formatInlineMarkdown(escapeHtml(quoteMatch[1])) + '</blockquote>');
          continue;
        }

        // Lista não ordenada (- ou *)
        const ulMatch = trimmed.match(/^[-*+]\\s+(.*)$/);
        if (ulMatch) {
          flushParagraph();
          if (inOl) {
            htmlParts.push('</ol>');
            inOl = false;
          }
          if (!inUl) {
            htmlParts.push('<ul>');
            inUl = true;
          }
          htmlParts.push('<li>' + formatInlineMarkdown(escapeHtml(ulMatch[1])) + '</li>');
          continue;
        }

        // Lista ordenada (1. ...)
        const olMatch = trimmed.match(/^\\d+\\.\\s+(.*)$/);
        if (olMatch) {
          flushParagraph();
          if (inUl) {
            htmlParts.push('</ul>');
            inUl = false;
          }
          if (!inOl) {
            htmlParts.push('<ol>');
            inOl = true;
          }
          htmlParts.push('<li>' + formatInlineMarkdown(escapeHtml(olMatch[1])) + '</li>');
          continue;
        }

        closeLists();
        paragraphBuffer.push(formatInlineMarkdown(escapeHtml(rawLine)));
      }

      flushParagraph();
      closeLists();
      return htmlParts.join('');
    }

    function renderMarkdownToHtml(markdownText) {
      if (!markdownText) return '';

      // Separa blocos cercados por \`\`\` (inclusive bloco aberto durante streaming)
      const parts = String(markdownText).split(/(\`\`\`[^\\r\\n\`]*\\r?\\n[\\s\\S]*?(?:\`\`\`|$))/g);
      let output = '';

      for (const part of parts) {
        if (!part) continue;

        if (part.startsWith('\`\`\`')) {
          const firstNewline = part.indexOf('\\n');
          const headerRaw = firstNewline !== -1 ? part.slice(3, firstNewline).trim() : part.slice(3).trim();
          let codeBody = firstNewline !== -1 ? part.slice(firstNewline + 1) : '';
          if (codeBody.endsWith('\`\`\`')) {
            codeBody = codeBody.slice(0, -3);
          }
          codeBody = codeBody.replace(/\\r?\\n$/, '');

          const label = escapeHtml(headerRaw || 'código');
          const escapedCode = escapeHtml(codeBody);

          output +=
            '<div class="md-code-block">' +
              '<div class="md-code-header">' +
                '<span>' + label + '</span>' +
                '<button type="button" class="md-copy-btn">Copiar</button>' +
              '</div>' +
              '<pre><code>' + escapedCode + '</code></pre>' +
            '</div>';
        } else {
          output += renderTextBlocks(part);
        }
      }

      return output;
    }

    // Delegação global para botões "Copiar" dentro de blocos de código
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.md-copy-btn') : null;
      if (!btn) return;
      const block = btn.closest('.md-code-block');
      const codeEl = block ? block.querySelector('pre code') : null;
      if (!codeEl) return;
      navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
        const oldText = btn.textContent;
        btn.textContent = 'Copiado!';
        setTimeout(() => {
          btn.textContent = oldText;
        }, 1500);
      });
    });
  `;
}