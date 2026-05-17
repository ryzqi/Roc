import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryView } from '../../src/renderer/views/memory/MemoryView';
import { createLoadedState } from './view-test-helpers';

describe('MemoryView', () => {
  it('renders phase 4 section layout while preserving smoke-critical memory text', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryView, {
        loadState: {
          status: 'ready',
          error: null,
          key: 'memory'
        },
        state: createLoadedState({
          memoryCandidates: [
            {
              id: 'candidate-1',
              state: 'conflict_detected',
              type: 'project_context',
              scope: 'project:Roc',
              content: 'phase four smoke active memory validates candidate acceptance and recall',
              confidence: 0.92,
              priority: 'high',
              source: 'agent_extract',
              sourceRef: 'memory://candidate-1',
              suggestedAction: 'review_conflict',
              conflictCount: 1,
              createdAt: '2026-05-16T06:50:00.000Z',
              updatedAt: '2026-05-16T06:55:00.000Z'
            }
          ],
          memoryConflicts: [
            {
              id: 'conflict-1',
              candidateId: 'candidate-1',
              activeMemoryId: 'active-1',
              type: 'project_context',
              scope: 'project:Roc',
              reason: 'same_type_scope_contradiction_or_duplicate',
              status: 'open',
              createdAt: '2026-05-16T06:56:00.000Z'
            }
          ],
          memorySearch: {
            query: 'phase four',
            degraded: false,
            items: [
              {
                id: 'hot-1',
                layer: 'hot',
                scope: 'project:Roc',
                confidence: 0.98,
                sourceRef: 'memory://hot-1',
                reason: 'recently_recalled',
                summary: 'phase four smoke active memory validates candidate acceptance and recall'
              }
            ]
          },
          sessionSearch: {
            query: 'phase four',
            items: [
              {
                id: 'session-1',
                title: '恢复记录',
                summary: '恢复记录：最近一次删除已归档。',
                scope: 'thread:1',
                sourceRef: 'session://1',
                reason: 'recent_session_match'
              }
            ]
          },
          memoryRecovery: {
            id: 'recovery-1',
            status: 'archived',
            recoverable: true
          },
          memoryStatus: {
            root: 'F:\\Code\\Roc\\.memory',
            truthSource: 'markdown',
            indexSource: 'sqlite',
            vectorIndex: {
              enabled: false,
              healthy: false,
              status: 'not_configured'
            },
            fullTextIndex: {
              enabled: true,
              healthy: true,
              status: 'ready'
            },
            layers: {
              hot: { entries: 1, characters: 90, path: 'hot' },
              warm: { entries: 0, characters: 0, path: 'warm' },
              cold: { entries: 0, characters: 0, path: 'cold' },
              session: { entries: 1, characters: 18, path: 'session' },
              candidate: { entries: 1, characters: 74, path: 'candidate' }
            }
          }
        })
      })
    );

    expect(html).toContain('data-testid="memory-view"');
    expect(html).toContain('class="section"');
    expect(html).toContain('class="section-head"');
    expect(html).toContain('class="list-rows"');
    expect(html).toContain('memory-record-list');
    expect(html).toContain('class="field-preview"');
    expect(html).toContain('1 条召回 · 1 个候选');
    expect(html).toContain('当前范围');
    expect(html).toContain('project:Roc');
    expect(html).toContain('markdown');
    expect(html).not.toContain('本机 1 个工作区');
    expect(html).not.toContain('global / project:Roc / task threads');
    expect(html).toContain('phase four smoke active memory validates candidate acceptance and recall');
    expect(html).toContain('conflict_detected');
    expect(html).toContain('same_type_scope_contradiction_or_duplicate');
    expect(html).toContain('恢复记录');
    expect(html).not.toContain('card-title');
    expect(html).not.toContain('grid-2');
  });
});
