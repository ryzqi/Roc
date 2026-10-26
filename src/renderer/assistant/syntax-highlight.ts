import { createLowlight, type LanguageFn } from 'lowlight';

/**
 * Lazy syntax highlighting (T4.4), ported from the legacy
 * `chat/syntax-highlight.ts`.
 *
 * Language grammars stay dynamic imports, so only a code block's language is loaded
 * when needed. Lowlight returns a HAST tree; the small adapter below accepts only
 * text nodes and highlighted `span` elements with known class shapes. The renderer
 * builds React spans from those tokens and falls back to source text if the tree is
 * unexpected.
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

const lowlight = createLowlight();
const languageRegistrations = new Map<string, Promise<void>>();

/** A run of code text with the `hljs-*` classes that apply to it. */
export type CodeToken = {
  text: string;
  classes: readonly string[];
};

const allowedModifierClasses = new Set(['class_', 'function_', 'language_']);
const safeClassName = /^[a-z0-9_-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedClassName(value: string): boolean {
  return safeClassName.test(value) && (value.startsWith('hljs-') || allowedModifierClasses.has(value));
}

/**
 * Convert a Lowlight root into React-renderable tokens. Unexpected tags, properties,
 * or classes reject the whole tree so the caller can keep the original source text.
 */
export function lowlightRootToCodeTokens(root: unknown, source: string): CodeToken[] | null {
  if (!isRecord(root) || root.type !== 'root' || !Array.isArray(root.children)) {
    return null;
  }

  const tokens: CodeToken[] = [];
  const visit = (node: unknown, inheritedClasses: readonly string[]): boolean => {
    if (!isRecord(node)) {
      return false;
    }

    if (node.type === 'text') {
      if (typeof node.value !== 'string') {
        return false;
      }
      if (node.value.length > 0) {
        tokens.push({ text: node.value, classes: inheritedClasses });
      }
      return true;
    }

    if (
      node.type !== 'element' ||
      node.tagName !== 'span' ||
      !Array.isArray(node.children) ||
      !isRecord(node.properties)
    ) {
      return false;
    }

    const propertyNames = Object.keys(node.properties);
    if (propertyNames.length !== 1 || propertyNames[0] !== 'className') {
      return false;
    }
    const localClasses = node.properties.className;
    if (
      !Array.isArray(localClasses) ||
      localClasses.length === 0 ||
      !localClasses.every((name): name is string => typeof name === 'string' && isAllowedClassName(name)) ||
      !localClasses.some((name) => name.startsWith('hljs-'))
    ) {
      return false;
    }

    const classes = [...inheritedClasses, ...localClasses];
    return node.children.every((child) => visit(child, classes));
  };

  if (!root.children.every((child) => visit(child, []))) {
    return null;
  }
  return tokens.map((token) => token.text).join('') === source ? tokens : null;
}

async function ensureLanguageRegistered(language: string, loader: () => Promise<{ default: LanguageFn }>): Promise<void> {
  let registration = languageRegistrations.get(language);
  if (registration === undefined) {
    registration = loader()
      .then(({ default: grammar }) => {
        lowlight.register(language, grammar);
      })
      .catch((error: unknown) => {
        if (languageRegistrations.get(language) === registration) {
          languageRegistrations.delete(language);
        }
        throw error;
      });
    languageRegistrations.set(language, registration);
  }
  await registration;
}

/**
 * Syntax-highlights `code` and returns React-renderable tokens, never HTML.
 * Unknown or absent language labels keep the existing plain-text rendering path.
 */
export async function highlightCodeTokens(language: string | null, code: string): Promise<CodeToken[] | null> {
  if (language === null) {
    return null;
  }
  const normalized = language.toLowerCase();
  const loader = Object.hasOwn(languageLoaders, normalized) ? languageLoaders[normalized] : undefined;
  if (loader === undefined) {
    return null;
  }

  await ensureLanguageRegistered(normalized, loader);
  return lowlightRootToCodeTokens(lowlight.highlight(normalized, code), code);
}
