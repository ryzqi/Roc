import type { LanguageFn } from 'highlight.js';
import highlight from 'highlight.js/lib/core';

/**
 * Lazy syntax highlighting (T4.4), ported from the legacy
 * `chat/syntax-highlight.ts`.
 *
 * Two things changed and nothing else:
 *
 *   1. The legacy module imported `styles/syntax-highlight.css` — a parallel
 *      stylesheet, which this shell does not have (R5). The `.hljs-*` classes are
 *      mapped onto the existing `--syntax-*` tokens under the `.roc-code` scope in
 *      `styles/index.css`, so the theme follows the light/dark switch like every
 *      other colour.
 *   2. Language grammars stay **dynamic imports**: each one becomes its own chunk,
 *      and `highlight.js` itself is therefore never in the eager graph (the P3
 *      eager-graph guard would fail if it were).
 */

const languageLoaders: Record<string, () => Promise<{ default: LanguageFn }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  js: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  ts: () => import('highlight.js/lib/languages/typescript'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  shell: () => import('highlight.js/lib/languages/bash'),
  python: () => import('highlight.js/lib/languages/python'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  sql: () => import('highlight.js/lib/languages/sql'),
  xml: () => import('highlight.js/lib/languages/xml'),
  html: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css')
};

const registeredLanguages = new Set<string>();

/** A run of code text with the `hljs-*` classes that apply to it. */
export type CodeToken = {
  text: string;
  classes: readonly string[];
};

/**
 * Syntax-highlights `code` and returns **React-renderable tokens**, never HTML.
 *
 * The legacy block injected `highlight.js`'s `.value` through
 * `dangerouslySetInnerHTML`. That is safe *today* (hljs escapes the source and only
 * emits its own `<span class="hljs-…">` wrappers), but it is an unverified trust
 * boundary in a surface that renders model output: a grammar bug or a future hljs
 * change would become script execution.
 *
 * `tokenizeHighlightedHtml` accepts only the markup hljs is allowed to produce, so
 * the component builds `<span>` elements itself. Anything unexpected yields `null`
 * and the caller falls back to plain text — the failure mode is "no colours", not
 * "injected markup".
 */
export async function highlightCodeTokens(language: string | null, code: string): Promise<CodeToken[] | null> {
  if (language === null) {
    return null;
  }
  const normalized = language.toLowerCase();
  const loader = languageLoaders[normalized];
  if (loader === undefined) {
    return null;
  }
  if (!registeredLanguages.has(normalized)) {
    const module = await loader();
    highlight.registerLanguage(normalized, module.default);
    registeredLanguages.add(normalized);
  }
  return tokenizeHighlightedHtml(highlight.highlight(code, { language: normalized, ignoreIllegals: true }).value);
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#039;': "'"
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#039);/gu, (match) => ENTITIES[match] ?? match);
}

/**
 * Parses highlight.js output into tokens, or returns `null` if it is not exactly
 * the allowlisted shape.
 *
 * Allowed: `<span class="hljs-…">`, `</span>`, and text with the five entities hljs
 * escapes. Anything else — another tag, an inline handler, an unquoted attribute, a
 * non-`hljs-` class, unbalanced tags — is rejected.
 */
export function tokenizeHighlightedHtml(html: string): CodeToken[] | null {
  const tokens: CodeToken[] = [];
  const classStack: string[][] = [];
  const pushText = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    const classes = classStack.flat();
    tokens.push({ text: decodeEntities(text), classes });
  };

  for (let index = 0; index < html.length; ) {
    const open = html.indexOf('<', index);
    if (open < 0) {
      pushText(html.slice(index));
      break;
    }
    pushText(html.slice(index, open));

    if (html.startsWith('</span>', open)) {
      if (classStack.pop() === undefined) {
        return null;
      }
      index = open + '</span>'.length;
      continue;
    }

    const spanMatch = /^<span class="([a-z0-9 -]*)">/u.exec(html.slice(open));
    if (spanMatch === null) {
      return null;
    }
    const classAttribute = spanMatch[1] ?? '';
  const names = classAttribute.split(' ').filter((name) => name.length > 0);
    if (names.length === 0 || names.some((name) => !name.startsWith('hljs-'))) {
      return null;
    }
    classStack.push(names);
    index = open + spanMatch[0].length;
  }

  return classStack.length === 0 ? tokens : null;
}

