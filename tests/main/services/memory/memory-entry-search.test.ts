import { describe, expect, it } from 'vitest';

import {
  searchMemoryDocuments,
  tokenizeQuery,
  type MemorySearchDocument
} from '../../../../src/main/services/memory/memory-entry-search';

const userDocument: MemorySearchDocument = {
  path: '/memory/global/USER.md',
  scope: 'global',
  kind: 'user',
  content: ['## Preferences', '', '<!-- key: user.language -->', '- 用户偏好使用 Python 编程语言。'].join('\n')
};

const memoryDocument: MemorySearchDocument = {
  path: '/memory/workspaces/current/MEMORY.md',
  scope: 'workspace',
  kind: 'memory',
  content: [
    '## 2026-07-03',
    '',
    '- type: decision',
    '  key: roc.memory.trigram',
    '  confidence: high',
    '  source: run_1',
    '  evidence: src/main/infrastructure/database-schemas.ts',
    '  summary: session_messages_fts uses the trigram tokenizer.',
    '- type: workspace_fact',
    '  key: roc.build.command',
    '  confidence: high',
    '  source: run_1',
    '  evidence: package.json',
    '  summary: pnpm build runs typecheck first.'
  ].join('\n')
};

const topicDocument: MemorySearchDocument = {
  path: '/memory/global/topics/archive-2026-05.md',
  scope: 'global',
  kind: 'topic',
  content: ['## 2026-05-01', '', 'Archived note about the PowerShell packaging pipeline.'].join('\n')
};

describe('tokenizeQuery', () => {
  it('splits Chinese queries into bigrams and keeps latin words of at least two characters', () => {
    expect(tokenizeQuery('喜欢什么语言')).toEqual(['喜欢', '欢什', '什么', '么语', '语言']);
    expect(tokenizeQuery('trigram a tokenizer')).toEqual(['trigram', 'tokenizer']);
  });

  it('splits mixed-script tokens before tokenizing each side', () => {
    expect(tokenizeQuery('python偏好设置')).toEqual(['python', '偏好', '好设', '设置']);
  });

  it('keeps single-character Chinese queries searchable', () => {
    expect(tokenizeQuery('语')).toEqual(['语']);
  });
});

describe('searchMemoryDocuments', () => {
  it('finds a Chinese user preference from a natural-language question', () => {
    const result = searchMemoryDocuments([userDocument, memoryDocument, topicDocument], '喜欢什么语言', 5);

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      path: '/memory/global/USER.md',
      scope: 'global',
      kind: 'user',
      entryType: 'user_preference',
      key: 'user.language',
      text: '用户偏好使用 Python 编程语言。'
    });
    expect(result.hits[0].score).toBeGreaterThan(0);
    expect(result).toMatchObject({ query: '喜欢什么语言', scannedDocuments: 3 });
  });

  it('ranks a key match above a body-only match', () => {
    const result = searchMemoryDocuments([memoryDocument], 'trigram', 5);

    expect(result.hits.map((hit) => hit.key)).toEqual(['roc.memory.trigram']);
    expect(result.hits[0].entryType).toBe('decision');
  });

  it('scores full query coverage above partial coverage', () => {
    const result = searchMemoryDocuments([memoryDocument], 'trigram tokenizer', 5);
    const partial = searchMemoryDocuments([memoryDocument], 'trigram build', 5);

    expect(result.hits[0].key).toBe('roc.memory.trigram');
    expect(result.hits[0].score).toBeGreaterThan(partial.hits[0].score);
  });

  it('searches topic file prose as section entries', () => {
    const result = searchMemoryDocuments([userDocument, topicDocument], 'PowerShell packaging', 5);

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      path: '/memory/global/topics/archive-2026-05.md',
      kind: 'topic',
      entryType: 'section',
      key: '2026-05-01'
    });
  });

  it('returns no hits when the query carries no usable term', () => {
    expect(searchMemoryDocuments([userDocument, memoryDocument], '  a  ', 5)).toEqual({
      query: '  a  ',
      hits: [],
      scannedDocuments: 2,
      scannedEntries: 3
    });
  });

  it('returns no hits when nothing matches', () => {
    expect(searchMemoryDocuments([userDocument, memoryDocument], 'kubernetes', 5).hits).toEqual([]);
  });

  it('honours the requested limit', () => {
    const result = searchMemoryDocuments([memoryDocument], 'roc', 1);

    expect(result.hits).toHaveLength(1);
    expect(result.scannedEntries).toBe(2);
  });

  it('truncates long entry text with an ellipsis', () => {
    const long = 'A'.repeat(400);
    const result = searchMemoryDocuments(
      [
        {
          path: '/memory/global/MEMORY.md',
          scope: 'global',
          kind: 'memory',
          content: [
            '## 2026-07-03',
            '',
            '- type: decision',
            '  key: roc.memory.long',
            '  confidence: high',
            '  source: run_1',
            '  evidence: tests/main/services/memory/memory-entry-search.test.ts',
            `  summary: ${long}`
          ].join('\n')
        }
      ],
      'roc.memory.long',
      5
    );

    expect([...result.hits[0].text]).toHaveLength(321);
    expect(result.hits[0].text.endsWith('…')).toBe(true);
  });
});
