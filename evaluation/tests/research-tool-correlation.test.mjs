import assert from 'node:assert/strict';
import {join} from 'node:path';
import {test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {testArtifacts} from './test-artifacts.mjs';

const root = testArtifacts('research-correlation');
const {takeProposedResearchTool} = await importTypeScriptModule('evaluation/runtime/research-tool-correlation.ts', {
  platform: 'node', tempDir: join(root, 'imports')
});
const projectId = 'correlation-project';
const proposal = (id, name, args) => ({id, function: {name, arguments: JSON.stringify(args)}});
const contextArgs = (chunkId, overrides = {}) => ({
  chunkId, expectedIndexedVersion: 'a'.repeat(64), ...overrides
});
const contextRequest = (chunkId, overrides = {}) => ({
  projectId, ...contextArgs(chunkId), maxChars: 6000, neighbors: true, ...overrides
});

test('reversed same-name context execution keeps each request attached to its proposal', () => {
  const first = proposal('context-a', 'research_read_knowledge_context', contextArgs('paper-a:chunk:0'));
  const second = proposal('context-b', 'research_read_knowledge_context', contextArgs('paper-b:chunk:0'));
  const pending = [first, second];
  assert.equal(takeProposedResearchTool(pending, {
    name: 'research.knowledge.context', request: contextRequest('paper-b:chunk:0'), projectId
  }).id, 'context-b');
  assert.deepEqual(pending, [first]);
  assert.equal(takeProposedResearchTool(pending, {
    name: 'research.knowledge.context', request: contextRequest('paper-a:chunk:0'), projectId
  }).id, 'context-a');
  assert.deepEqual(pending, []);
});

test('production search normalization binds trimmed queries and default limits', () => {
  const wrong = proposal('search-b', 'research_search_knowledge', {query: 'other paper'});
  const right = proposal('search-a', 'research_search_knowledge', {documentId: '', query: '  measured yield  '});
  const pending = [wrong, right];
  assert.equal(takeProposedResearchTool(pending, {
    name: 'research.knowledge.search', projectId,
    request: {embeddingConfigId: null, limit: 6, projectId, query: 'measured yield'}
  }).id, 'search-a');
  assert.deepEqual(pending, [wrong]);
});

test('an explicit operation ID must also match its normalized request without consuming evidence', () => {
  const first = proposal('context-a', 'research_read_knowledge_context', contextArgs('paper-a:chunk:0'));
  const second = proposal('context-b', 'research_read_knowledge_context', contextArgs('paper-b:chunk:0'));
  const pending = [first, second];
  assert.throws(() => takeProposedResearchTool(pending, {
    name: 'research.knowledge.context', projectId, toolCallId: 'context-a',
    request: contextRequest('paper-b:chunk:0')
  }), /benchmark_research_tool_binding_missing/);
  assert.deepEqual(pending, [first, second]);
  assert.equal(takeProposedResearchTool(pending, {
    name: 'research.knowledge.context', projectId, toolCallId: 'context-b',
    request: contextRequest('paper-b:chunk:0')
  }).id, 'context-b');
});

test('missing, malformed and version-mismatched proposals cannot receive capability receipts', () => {
  const pending = [
    {id: 'malformed', function: {name: 'research_read_knowledge_context', arguments: 'not JSON'}},
    proposal('different-version', 'research_read_knowledge_context', contextArgs('paper-a:chunk:0', {
      expectedIndexedVersion: 'b'.repeat(64)
    }))
  ];
  const before = structuredClone(pending);
  assert.throws(() => takeProposedResearchTool(pending, {
    name: 'research.knowledge.context', projectId, request: contextRequest('paper-a:chunk:0')
  }), /benchmark_research_tool_binding_missing/);
  assert.deepEqual(pending, before);
});
