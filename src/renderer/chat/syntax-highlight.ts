import type { LanguageFn } from 'highlight.js';
import highlight from 'highlight.js/lib/core';

import '../styles/syntax-highlight.css';

const languageLoaders: Record<string, () => Promise<{ default: LanguageFn }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  js: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  ts: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  shell: () => import('highlight.js/lib/languages/bash'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  python: () => import('highlight.js/lib/languages/python'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  sql: () => import('highlight.js/lib/languages/sql'),
  xml: () => import('highlight.js/lib/languages/xml'),
  html: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css')
};

const registeredLanguages = new Set<string>();

export async function highlightCode(language: string | null, code: string): Promise<string> {
  if (language === null) {
    return escapeHtml(code);
  }
  const normalized = language.toLowerCase();
  const loader = languageLoaders[normalized];
  if (loader === undefined) {
    return escapeHtml(code);
  }
  if (!registeredLanguages.has(normalized)) {
    const module = await loader();
    highlight.registerLanguage(normalized, module.default);
    registeredLanguages.add(normalized);
  }
  return highlight.highlight(code, { language: normalized, ignoreIllegals: true }).value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
