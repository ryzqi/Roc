# Context Engineering Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize Roc context engineering in Phase A -> Phase B -> Phase C order while keeping one DeepAgents runtime path.

**Architecture:** Keep `createDeepAgent` as the only harness for chat, Plan Mode, and background tasks. Use DeepAgents native `memory`, `skills`, `CompositeBackend`, `StoreBackend`, `thread_id`, and `checkpointer` where they fit; keep Roc wrappers only for Windows paths, safety policy, Plan Mode, selected skill ACL, and product-specific streaming. Add long-run context digest behind the existing forge compaction middleware rather than adding a second memory system.

**Tech Stack:** TypeScript ESM, Electron main process, React renderer unchanged, `deepagents@1.10.5`, `langchain@1.5.1`, `@langchain/langgraph@1.4.4`, Vitest, PowerShell.

## Global Constraints

- Implementation order is fixed: Phase A, then Phase B, then Phase C.
- Chat, Plan Mode, and background tasks must continue to share the same `createDeepAgent` runtime path.
- Do not create a second agent runtime.
- Do not replace DeepAgents with raw LangGraph or a different framework.
- Do not change provider configuration, task workbench UI, or background task user workflows.
- Do not remove Roc Windows path safety, shell path guard, selected skill access control, memory security scan, memory capacity checks, or Plan Mode read-only controls.
- Do not rely on prompt text for filesystem, shell, or permission enforcement.
- Do not add model summarization calls for Phase C.
- Use PowerShell commands for verification examples.

---

## File Structure

- Modify `src/main/services/forge-guardrails/middleware/prompt-caching.ts`: provider-safe prompt cache breakpoint selection.
- Modify `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`: cache marker count, order, request-block exclusion, unknown provider no-op.
- Modify `src/main/services/deep-agent/context/explicit-skills.ts`: validate selected skills and return compact skill index entries without reading full `SKILL.md`.
- Modify `src/main/services/deep-agent/context/prompt-blocks.ts`: serialize explicit skill index and trim memory prompt text in Phase B.
- Modify `tests/main/services/deep-agent/context/context-assembler.test.ts`: skill source and prompt assertions.
- Modify `tests/main/services/deep-agent/context/prompt-blocks.test.ts`: explicit skill index and prompt text assertions.
- Modify `src/main/services/deep-agent/context/memory-promotion.ts`: summary normalization helpers.
- Modify `src/main/services/memory/auto-memory-writer.ts`: duplicate suppression by normalized summary.
- Modify `tests/main/services/deep-agent/context/memory-promotion.test.ts`: normalization behavior.
- Modify `tests/main/plugins/memory/plugin.test.ts`: cross-run duplicate suppression.
- Modify `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`: native DeepAgents contract assumptions Roc depends on.
- Modify `src/main/services/forge-guardrails/message-tags.ts`: add protected digest message tag.
- Create `src/main/services/forge-guardrails/context-digest.ts`: deterministic digest types, extraction, protected message creation, and refresh.
- Modify `src/main/services/forge-guardrails/index.ts`: export digest helpers.
- Modify `src/main/services/forge-guardrails/middleware/forge-tiered-compaction.ts`: refresh digest before destructive edits and protect digest from deletion.
- Create `tests/main/services/forge-guardrails/context-digest.test.ts`: digest unit tests.
- Modify `tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts`: digest preservation in compaction.
- Modify `tests/main/services/forge-guardrails/integration/full-stack.test.ts`: middleware wiring smoke for digest before compaction.

---

### Task 1: Phase A Prompt Caching Safety

**Files:**
- Modify: `src/main/services/forge-guardrails/middleware/prompt-caching.ts`
- Test: `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`

**Interfaces:**
- Consumes: `PromptBlock`, `BlockStability`, `ProviderType`.
- Produces:
  - `export const MAX_ANTHROPIC_CACHE_CONTROL_MARKERS = 4;`
  - `AnthropicStrategy.detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[]`
  - Existing `createPromptCachingMiddleware(options: PromptCachingOptions)` behavior with provider-safe Anthropic markers.

- [ ] **Step 1: Add failing tests for provider-safe marker limits**

Append these tests inside `describe('AnthropicStrategy', () => { ... })` in `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`:

```ts
  it('balanced mode marks at most four stable blocks in priority order', () => {
    const blocks: PromptBlock[] = [
      { type: 'static', content: 'static', stability: BlockStability.STATIC, hash: 'a' },
      { type: 'workspace', content: 'workspace', stability: BlockStability.WORKSPACE, hash: 'b' },
      { type: 'tools', content: 'tools', stability: BlockStability.CAPABILITY, hash: 'c' },
      { type: 'capability', content: 'capability', stability: BlockStability.CAPABILITY, hash: 'd' },
      { type: 'context_recall', content: 'context', stability: BlockStability.WORKSPACE, hash: 'e' },
      { type: 'workflow', content: 'workflow', stability: BlockStability.REQUEST, hash: 'f' }
    ];

    expect(strategy.detectBreakpoints(blocks, 'balanced')).toEqual([0, 1, 3, 4]);
  });

  it('aggressive mode still respects the Anthropic cache marker limit', () => {
    const blocks: PromptBlock[] = [
      { type: 'static', content: 'static', stability: BlockStability.STATIC, hash: 'a' },
      { type: 'workspace', content: 'workspace', stability: BlockStability.WORKSPACE, hash: 'b' },
      { type: 'tools', content: 'tools', stability: BlockStability.CAPABILITY, hash: 'c' },
      { type: 'capability', content: 'capability', stability: BlockStability.CAPABILITY, hash: 'd' },
      { type: 'context_recall', content: 'context', stability: BlockStability.WORKSPACE, hash: 'e' },
      { type: 'workflow', content: 'workflow', stability: BlockStability.REQUEST, hash: 'f' }
    ];

    expect(strategy.detectBreakpoints(blocks, 'aggressive')).toEqual([0, 1, 2, 3]);
  });
```

Update the existing `balanced 模式应跳过 REQUEST` assertion from `expect(breakpoints).toEqual([0, 1, 2]);` to:

```ts
    expect(breakpoints).toEqual([0, 1, 2]);
```

Keep it unchanged because that four-block fixture still fits under the cap.

- [ ] **Step 2: Add failing middleware test for actual cache_control count**

Append this test inside `describe('createPromptCachingMiddleware', () => { ... })`:

```ts
  it('injects no more than four Anthropic cache_control markers into a production prompt', async () => {
    const prompt = serializePromptBlocks(
      buildPromptBlocks({
        mode: 'plan',
        enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
        workspacePath: 'F:\\Code\\Roc',
        workflowHint: 'propose_background_task',
        tools: [
          { name: 'session_search', description: 'Search prior conversations' },
          { name: 'web_read', description: 'Read a public page' }
        ],
        explicitSkillContexts: [
          {
            id: 'typescript',
            name: 'typescript',
            path: '/skills/typescript/SKILL.md'
          }
        ]
      })
    );
    const middleware = createPromptCachingMiddleware({
      providerType: 'anthropic_compatible',
      strategy: 'balanced'
    });
    const handler = vi.fn(async request => request);
    const wrapModelCall = middleware.wrapModelCall;
    if (wrapModelCall === undefined) {
      throw new Error('prompt_caching_wrap_model_call_missing');
    }

    await wrapModelCall(
      {
        messages: [new SystemMessage(prompt)]
      } as never,
      handler as never
    );

    const handledRequest = handler.mock.calls[0]?.[0] as { messages: SystemMessage[] } | undefined;
    if (handledRequest === undefined) {
      throw new Error('prompt_caching_handler_not_called');
    }
    const systemMessage = handledRequest.messages[0];
    if (!Array.isArray(systemMessage.content)) {
      throw new Error('expected_structured_anthropic_content');
    }
    const cacheMarked = systemMessage.content.filter((block) => {
      return typeof block === 'object' && block !== null && 'cache_control' in block;
    });

    expect(cacheMarked).toHaveLength(4);
    expect(cacheMarked.every((block) => JSON.stringify(block).includes('REQUEST'))).toBe(false);
  });
```

This test references the `ExplicitSkillContext` shape from Task 2. If Task 1 is implemented before Task 2, keep the test with `content: 'skill body'` until Task 2 changes the type, then update it in Task 2.

- [ ] **Step 3: Run tests and verify failure**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts
```

Expected: FAIL on the new marker limit assertions because current strategy marks every eligible block.

- [ ] **Step 4: Implement provider-safe Anthropic breakpoint selection**

In `src/main/services/forge-guardrails/middleware/prompt-caching.ts`, add this constant and helper functions near the strategy types:

```ts
export const MAX_ANTHROPIC_CACHE_CONTROL_MARKERS = 4;

const BALANCED_PRIORITY: ReadonlyArray<PromptBlock['type']> = [
  'static',
  'workspace',
  'capability',
  'context_recall',
  'tools'
];

function capBreakpoints(indexes: number[]): number[] {
  return indexes.slice(0, MAX_ANTHROPIC_CACHE_CONTROL_MARKERS).sort((left, right) => left - right);
}

function indexesForStability(blocks: PromptBlock[], stability: BlockStability): number[] {
  return blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.stability === stability)
    .map(({ index }) => index);
}

function indexesByTypePriority(blocks: PromptBlock[], priority: ReadonlyArray<PromptBlock['type']>): number[] {
  const selected: number[] = [];
  for (const type of priority) {
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block !== undefined && block.type === type && block.stability !== BlockStability.REQUEST) {
        selected.push(index);
      }
    }
  }
  return selected;
}
```

Replace `AnthropicStrategy.detectBreakpoints()` with:

```ts
  detectBreakpoints(blocks: PromptBlock[], strategy: PromptCachingStrategy): number[] {
    switch (strategy) {
      case 'aggressive':
        return capBreakpoints(
          blocks
            .map((block, index) => ({ block, index }))
            .filter(({ block }) => block.stability !== BlockStability.REQUEST)
            .map(({ index }) => index)
        );

      case 'balanced':
        return capBreakpoints(indexesByTypePriority(blocks, BALANCED_PRIORITY));

      case 'conservative':
        return capBreakpoints(indexesForStability(blocks, BlockStability.STATIC));

      default:
        return [];
    }
  }
```

- [ ] **Step 5: Run prompt caching test**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

Run:

```powershell
git add src/main/services/forge-guardrails/middleware/prompt-caching.ts tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts
git commit -m "fix: cap prompt cache markers"
```

Expected: commit succeeds.

---

### Task 2: Phase A Explicit Skill Index

**Files:**
- Modify: `src/main/services/deep-agent/context/explicit-skills.ts`
- Modify: `src/main/services/deep-agent/context/prompt-blocks.ts`
- Test: `tests/main/services/deep-agent/context/context-assembler.test.ts`
- Test: `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
- Update if needed: `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts`

**Interfaces:**
- Consumes: `enabledCapabilities.skills`, `explicitSkillIds`, `/skills/` backend route.
- Produces:
  - `ExplicitSkillContext = { id: string; name: string; path: string }`
  - `buildExplicitSkillsPrompt(skills)` as compact index, not full `SKILL.md`.

- [ ] **Step 1: Add failing prompt-block test for compact skill index**

Append this test to `tests/main/services/deep-agent/context/prompt-blocks.test.ts`:

```ts
  it('serializes explicit skills as an index without SKILL.md content', () => {
    const blocks = buildPromptBlocks({
      mode: 'chat',
      enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [],
      explicitSkillContexts: [
        {
          id: 'typescript',
          name: 'typescript',
          path: '/skills/typescript/SKILL.md'
        }
      ]
    });

    const skillBlock = blocks.find((block) => block.type === 'explicit_skills');
    expect(skillBlock?.content).toContain('<skill_index>');
    expect(skillBlock?.content).toContain('<id>typescript</id>');
    expect(skillBlock?.content).toContain('<path>/skills/typescript/SKILL.md</path>');
    expect(skillBlock?.content).toContain('Read the SKILL.md file through the /skills/ route before applying it.');
    expect(skillBlock?.content).not.toContain('# TypeScript Skill');
  });
```

- [ ] **Step 2: Add failing assembler test for no full skill content**

Append this test to `tests/main/services/deep-agent/context/context-assembler.test.ts`:

```ts
  it('keeps explicit skill prompt context compact while exposing /skills/', () => {
    const harness = assembleContextHarness({
      mode: 'chat',
      enabledCapabilities: { mcpServers: [], skills: ['typescript'] },
      workflowHint: null,
      workspacePath: 'F:\\Code\\Roc',
      memorySources: [],
      baseTools: [],
      searchSessions: () => ({ query: 'x', total: 0, items: [] }),
      explicitSkillContexts: [
        {
          id: 'typescript',
          name: 'typescript',
          path: '/skills/typescript/SKILL.md'
        }
      ]
    });

    expect(harness.skillSources).toEqual(['/skills/']);
    expect(harness.systemPrompt).toContain('<skill_index>');
    expect(harness.systemPrompt).toContain('/skills/typescript/SKILL.md');
    expect(harness.systemPrompt).not.toContain('# TypeScript Skill');
  });
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-assembler.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts
```

Expected: FAIL because current type requires `content` and current prompt serializes full skill content.

- [ ] **Step 4: Change explicit skill context type and loader**

Replace `ExplicitSkillContext` in `src/main/services/deep-agent/context/explicit-skills.ts` with:

```ts
export type ExplicitSkillContext = {
  id: string;
  name: string;
  path: string;
};
```

In `loadExplicitSkillContexts()`, remove the `skills.file.read` call and push only the compact index:

```ts
    contexts.push({
      id: skill.id,
      name: skill.name,
      path: `/skills/${skill.id}/SKILL.md`
    });
```

Remove the unused `SkillFilePreviewResult` import.

- [ ] **Step 5: Change prompt-block type and serialization**

In `src/main/services/deep-agent/context/prompt-blocks.ts`, replace `ExplicitSkillPromptContext` with:

```ts
export type ExplicitSkillPromptContext = {
  id: string;
  name: string;
  path: string;
};
```

Replace `buildExplicitSkillsPrompt()` with:

```ts
function buildExplicitSkillsPrompt(skills: readonly ExplicitSkillPromptContext[]): string {
  return [
    'Explicitly enabled skills for this request:',
    '<skill_index>',
    ...skills.map((skill) =>
      [
        '<skill>',
        `<id>${skill.id}</id>`,
        `<name>${skill.name}</name>`,
        `<path>${skill.path}</path>`,
        'Read the SKILL.md file through the /skills/ route before applying it.',
        '</skill>'
      ].join('\n')
    ),
    '</skill_index>'
  ].join('\n');
}
```

- [ ] **Step 6: Update Task 1 prompt caching test shape if needed**

If `tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts` still constructs `explicitSkillContexts` with `content`, replace that object with:

```ts
          {
            id: 'typescript',
            name: 'typescript',
            path: '/skills/typescript/SKILL.md'
          }
```

- [ ] **Step 7: Run skill and prompt tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/context-assembler.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

Run:

```powershell
git add src/main/services/deep-agent/context/explicit-skills.ts src/main/services/deep-agent/context/prompt-blocks.ts tests/main/services/deep-agent/context/context-assembler.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts
git commit -m "refactor: use compact explicit skill context"
```

Expected: commit succeeds.

---

### Task 3: Phase A Automatic Memory Duplicate Suppression

**Files:**
- Modify: `src/main/services/deep-agent/context/memory-promotion.ts`
- Modify: `src/main/services/memory/auto-memory-writer.ts`
- Test: `tests/main/services/deep-agent/context/memory-promotion.test.ts`
- Test: `tests/main/plugins/memory/plugin.test.ts`

**Interfaces:**
- Produces:
  - `normalizeMemoryPromotionSummary(summary: string): string`
  - `memoryFileContainsPromotionSummary(existing: string, summary: string): boolean`
- Consumes: existing `buildMemoryPromotionBullet({ runId, summary })`.

- [ ] **Step 1: Add failing normalization tests**

Append these tests to `tests/main/services/deep-agent/context/memory-promotion.test.ts`:

```ts
import {
  buildMemoryPromotionBullet,
  memoryFileContainsPromotionSummary,
  normalizeMemoryPromotionSummary
} from '../../../../../src/main/services/deep-agent/context/memory-promotion';
```

If the file already imports `buildMemoryPromotionBullet`, replace that import with the block above.

Append:

```ts
  it('normalizes summary text for duplicate detection', () => {
    expect(normalizeMemoryPromotionSummary('  Native memory   now uses Store records.  ')).toBe(
      'native memory now uses store records.'
    );
  });

  it('detects duplicate summaries across different run ids', () => {
    const existing = ['## 2026-06-18', '', '- run_1: Native memory now uses Store records.'].join('\n');

    expect(memoryFileContainsPromotionSummary(existing, 'native memory now uses store records.')).toBe(true);
    expect(memoryFileContainsPromotionSummary(existing, 'Different result.')).toBe(false);
  });
```

- [ ] **Step 2: Add failing plugin test for cross-run duplicate skip**

In `tests/main/plugins/memory/plugin.test.ts`, add this test near the existing duplicate memory test:

```ts
  it('skips automatic memory writes when a different run has the same normalized summary', async () => {
    const { capabilities, eventBus } = await initializePluginWithBus({ workspace: null });
    const firstEvent = {
      type: 'agent.run.completed',
      source: '@roc/plugin-agent',
      payload: {
        runId: 'run_1',
        threadId: null,
        summary: 'Global memory updated.',
        assistantMessage: 'done'
      },
      createdAt: '2026-06-18T10:00:00.000Z'
    };
    const secondEvent = {
      ...firstEvent,
      payload: {
        ...firstEvent.payload,
        runId: 'run_2',
        summary: '  global   memory updated. '
      }
    };

    await eventBus.publish(firstEvent);
    await eventBus.publish(secondEvent);

    await expect(capabilities.invoke('memory.file.read', { scope: 'global', kind: 'memory' })).resolves.toBe(
      ['## 2026-06-18', '', '- run_1: Global memory updated.'].join('\n')
    );
  });
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/memory-promotion.test.ts tests/main/plugins/memory/plugin.test.ts
```

Expected: FAIL because helpers do not exist and current duplicate check includes run id.

- [ ] **Step 4: Implement normalization helpers**

In `src/main/services/deep-agent/context/memory-promotion.ts`, add:

```ts
export function normalizeMemoryPromotionSummary(summary: string): string {
  return summary.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

export function memoryFileContainsPromotionSummary(existing: string, summary: string): boolean {
  const normalizedSummary = normalizeMemoryPromotionSummary(summary);
  if (normalizedSummary.length === 0) {
    return false;
  }
  const lines = existing.split('\n');
  for (const line of lines) {
    const match = /^-\s+[^:]+:\s+(.*)$/u.exec(line.trim());
    if (match === null) {
      continue;
    }
    const existingSummary = match[1];
    if (existingSummary !== undefined && normalizeMemoryPromotionSummary(existingSummary) === normalizedSummary) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 5: Use normalized duplicate detection in AutoMemoryWriter**

In `src/main/services/memory/auto-memory-writer.ts`, update imports:

```ts
import {
  buildMemoryPromotionBullet,
  memoryFileContainsPromotionSummary
} from '../deep-agent/context/memory-promotion';
```

After `current` and before building `next`, add:

```ts
    const existing = current === null ? '' : current;
    if (memoryFileContainsPromotionSummary(existing, summary)) {
      return;
    }
```

Then change:

```ts
    const next = appendBullet(current === null ? '' : current, resolveDate(createdAt), bullet);
```

to:

```ts
    const next = appendBullet(existing, resolveDate(createdAt), bullet);
```

- [ ] **Step 6: Run memory tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/memory-promotion.test.ts tests/main/plugins/memory/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run:

```powershell
git add src/main/services/deep-agent/context/memory-promotion.ts src/main/services/memory/auto-memory-writer.ts tests/main/services/deep-agent/context/memory-promotion.test.ts tests/main/plugins/memory/plugin.test.ts
git commit -m "fix: deduplicate automatic memory summaries"
```

Expected: commit succeeds.

---

### Task 4: Phase B Native DeepAgents Contract Convergence

**Files:**
- Modify: `src/main/services/deep-agent/context/prompt-blocks.ts`
- Test: `tests/main/services/deep-agent/context/prompt-blocks.test.ts`
- Test: `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`
- Test: `tests/main/deep-agent-build-wiring.test.ts`

**Interfaces:**
- Consumes: existing `buildDeepAgent()` arguments `memory`, `skills`, `backend`, `store`, `checkpointer`, `subagents`.
- Produces: a leaner model-facing memory prompt and explicit native-contract test coverage.

- [ ] **Step 1: Add failing prompt test for lean memory contract**

Append this test to `tests/main/services/deep-agent/context/prompt-blocks.test.ts`:

```ts
  it('keeps memory prompt model-actionable without explaining storage internals', () => {
    const blocks = buildPromptBlocks({
      mode: 'chat',
      enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: 'F:\\Code\\Roc',
      workflowHint: null,
      tools: [],
      explicitSkillContexts: []
    });
    const staticBlock = blocks.find((block) => block.type === 'static');

    expect(staticBlock?.content).toContain('/memory/global/USER.md');
    expect(staticBlock?.content).toContain('/memory/workspaces/current/MEMORY.md');
    expect(staticBlock?.content).toContain('Automatic writes only append to MEMORY.md');
    expect(staticBlock?.content).not.toContain('Roc SQLite');
    expect(staticBlock?.content).not.toContain('DeepAgents memory');
  });
```

- [ ] **Step 2: Add official-contract tests for native boundaries**

Append these tests to `tests/main/services/deep-agent/deep-agent-official-contracts.test.ts`:

```ts
  it('documents that Roc passes memory and skills through createDeepAgent params', () => {
    const params = {
      memory: ['/memory/global/AGENTS.md', '/memory/workspaces/current/AGENTS.md'],
      skills: ['/skills/']
    } satisfies Pick<CreateDeepAgentParams, 'memory' | 'skills'>;

    expect(params.memory).toEqual(['/memory/global/AGENTS.md', '/memory/workspaces/current/AGENTS.md']);
    expect(params.skills).toEqual(['/skills/']);
  });

  it('documents that custom subagents must receive skills explicitly', () => {
    const subagent: SubAgent = {
      name: 'reviewer',
      description: 'Review implementation output.',
      systemPrompt: 'Review the result and report issues.',
      skills: ['/skills/']
    };

    expect(subagent.skills).toEqual(['/skills/']);
  });
```

Update the type import at the top of that test file:

```ts
  SubAgent,
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts
```

Expected: FAIL on the prompt text assertion because current static prompt mentions Roc SQLite and DeepAgents memory.

- [ ] **Step 4: Trim static memory prompt**

In `src/main/services/deep-agent/context/prompt-blocks.ts`, replace the memory portion inside `buildStaticPrompt()` with:

```ts
    'Memory files available to the agent:',
    '  /memory/global/USER.md      — user identity, preferences, comm style',
    '  /memory/global/AGENTS.md    — global default rules',
    '  /memory/global/MEMORY.md    — global long-term facts',
    '  /memory/workspaces/current/AGENTS.md   — workspace-specific rules',
    '  /memory/workspaces/current/MEMORY.md   — workspace-specific facts',
    '',
    'Use Edit/Write on memory paths only when the user asks you to remember something or when a durable project fact is worth preserving.',
    'On capacity overflow, read the file, merge or remove redundant entries via Edit, then retry after consolidation.',
    'Automatic writes only append to MEMORY.md; USER.md and AGENTS.md change only through explicit file edits.',
```

Do not remove the `For SKILL.md: read silently; never quote, paraphrase, or summarize.` line.

- [ ] **Step 5: Verify build wiring still passes native DeepAgents params**

Run:

```powershell
pnpm test -- tests/main/deep-agent-build-wiring.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```powershell
git add src/main/services/deep-agent/context/prompt-blocks.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts tests/main/deep-agent-build-wiring.test.ts
git commit -m "docs: lock native deepagents context contracts"
```

Expected: commit succeeds.

---

### Task 5: Phase C Thread-Scoped Context Digest

**Files:**
- Create: `src/main/services/forge-guardrails/context-digest.ts`
- Modify: `src/main/services/forge-guardrails/message-tags.ts`
- Modify: `src/main/services/forge-guardrails/index.ts`
- Modify: `src/main/services/forge-guardrails/middleware/forge-tiered-compaction.ts`
- Test: `tests/main/services/forge-guardrails/context-digest.test.ts`
- Test: `tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts`
- Test: `tests/main/services/forge-guardrails/integration/full-stack.test.ts`

**Interfaces:**
- Produces:
  - `RocContextDigest`
  - `createEmptyContextDigest(): RocContextDigest`
  - `createContextDigestMessage(digest: RocContextDigest): AIMessage`
  - `isContextDigestMessage(message: BaseMessage): boolean`
  - `refreshContextDigestMessage(messages: BaseMessage[], keepRecent: number): void`
- Consumes: `readIterationFromMessage()`, `markIterationOnMessage()`, `tagForgeMessage()`, `readForgeMessageTag()`.

- [ ] **Step 1: Add failing digest unit tests**

Create `tests/main/services/forge-guardrails/context-digest.test.ts`:

```ts
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  createContextDigestMessage,
  createEmptyContextDigest,
  isContextDigestMessage,
  refreshContextDigestMessage
} from '../../../../src/main/services/forge-guardrails/context-digest';
import { markIterationOnMessage } from '../../../../src/main/services/forge-guardrails';

function mark<M extends BaseMessage>(message: M, iterationIndex: number): M {
  return markIterationOnMessage(message, iterationIndex) as M;
}

describe('RocContextDigest', () => {
  it('creates a protected digest message', () => {
    const message = createContextDigestMessage({
      ...createEmptyContextDigest(),
      facts: ['Workspace is F:\\Code\\Roc.'],
      nextActions: ['Run targeted tests.']
    });

    expect(isContextDigestMessage(message)).toBe(true);
    expect(String(message.content)).toContain('Workspace is F:\\Code\\Roc.');
    expect(String(message.content)).toContain('Run targeted tests.');
  });

  it('refreshes digest from old assistant text and tool results', () => {
    const messages: BaseMessage[] = [
      mark(new AIMessage({ id: 'old-ai', content: 'Decision: use native DeepAgents memory.\nNext: update tests.' }), 1),
      mark(
        new ToolMessage({
          id: 'old-tool',
          tool_call_id: 'old-tool-call',
          name: 'run_shell_command',
          content: 'pnpm test -- tests/main/foo.test.ts\nPASS',
          status: 'success'
        }),
        1
      ),
      mark(new AIMessage({ id: 'recent-ai', content: 'Recent answer.' }), 5)
    ];

    refreshContextDigestMessage(messages, 2);

    const digest = messages.find(isContextDigestMessage);
    expect(digest).toBeDefined();
    expect(String(digest?.content)).toContain('use native DeepAgents memory');
    expect(String(digest?.content)).toContain('update tests');
    expect(String(digest?.content)).toContain('pnpm test -- tests/main/foo.test.ts');
  });
});
```

- [ ] **Step 2: Add failing compaction preservation test**

Append this test to `tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts`:

```ts
  it('preserves a context digest before dropping old messages', async () => {
    const messages = [
      ...headers(),
      assistantText('old-decision', 1),
      toolResult('old-tool', 1),
      toolCallAi('recent-anchor', 5)
    ];
    const oldDecision = messages.find((message) => message.id === 'old-decision');
    if (oldDecision !== undefined) {
      oldDecision.content = 'Decision: preserve long-running context before deleting old results.';
    }

    await applyTieredCompaction(messages, 980);

    const digest = messages.find((message) => message.additional_kwargs?.forge_message_type === 'forge:context_digest');
    expect(digest).toBeDefined();
    expect(String(digest?.content)).toContain('preserve long-running context');
    expect(ids(messages)).not.toContain('old-decision');
  });
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/context-digest.test.ts tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts
```

Expected: FAIL because digest module and tag do not exist.

- [ ] **Step 4: Add forge context digest tag**

In `src/main/services/forge-guardrails/message-tags.ts`, add `'forge:context_digest'` to `ForgeMessageType`, `isForgeMessageType()`, and `FORGE_COMPACTION_PRIORITY`:

```ts
  | 'forge:context_digest';
```

```ts
    value === 'forge:context_digest'
```

```ts
  'forge:context_digest': 0,
```

Do not add it to `FORGE_TRANSIENT_TYPES`.

- [ ] **Step 5: Implement context digest module**

Create `src/main/services/forge-guardrails/context-digest.ts`:

```ts
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  markIterationOnMessage,
  readIterationFromMessage
} from './state-schema';
import {
  readForgeMessageTag,
  tagForgeMessage
} from './message-tags';

export type RocContextDigest = {
  facts: string[];
  decisions: string[];
  filesTouched: string[];
  verifications: string[];
  openQuestions: string[];
  nextActions: string[];
};

const DIGEST_MESSAGE_ID = 'roc-context-digest';
const MAX_ITEMS_PER_FIELD = 8;

export function createEmptyContextDigest(): RocContextDigest {
  return {
    facts: [],
    decisions: [],
    filesTouched: [],
    verifications: [],
    openQuestions: [],
    nextActions: []
  };
}

export function createContextDigestMessage(digest: RocContextDigest): AIMessage {
  const message = new AIMessage({
    id: DIGEST_MESSAGE_ID,
    content: serializeDigest(digest),
    additional_kwargs: {
      roc_context_digest: digest
    }
  });
  return tagForgeMessage(message, 'forge:context_digest');
}

export function isContextDigestMessage(message: BaseMessage): message is AIMessage {
  return AIMessage.isInstance(message) && readForgeMessageTag(message) === 'forge:context_digest';
}

export function refreshContextDigestMessage(messages: BaseMessage[], keepRecent: number): void {
  const eligibleEnd = findEligibleEnd(messages, keepRecent);
  if (eligibleEnd <= 0) {
    return;
  }
  const digest = createEmptyContextDigest();
  for (let index = 0; index < eligibleEnd; index += 1) {
    const message = messages[index];
    if (message === undefined || isContextDigestMessage(message)) {
      continue;
    }
    mergeDigest(digest, digestFromMessage(message));
  }
  if (isEmptyDigest(digest)) {
    return;
  }
  const existingIndex = messages.findIndex(isContextDigestMessage);
  const digestMessage = markIterationOnMessage(createContextDigestMessage(digest), 0);
  if (existingIndex === -1) {
    const insertIndex = messages.length > 0 && messages[0] !== undefined && messages[0].getType() === 'system' ? 1 : 0;
    messages.splice(insertIndex, 0, digestMessage);
    return;
  }
  messages[existingIndex] = digestMessage;
}

function digestFromMessage(message: BaseMessage): RocContextDigest {
  const digest = createEmptyContextDigest();
  if (AIMessage.isInstance(message) && typeof message.content === 'string') {
    collectAssistantText(digest, message.content);
  }
  if (ToolMessage.isInstance(message)) {
    collectToolMessage(digest, message);
  }
  return digest;
}

function collectAssistantText(digest: RocContextDigest, content: string): void {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    collectPrefixedLine(digest.decisions, line, 'Decision:');
    collectPrefixedLine(digest.nextActions, line, 'Next:');
    collectPrefixedLine(digest.openQuestions, line, 'Question:');
    collectPrefixedLine(digest.facts, line, 'Fact:');
  }
}

function collectPrefixedLine(target: string[], line: string, prefix: string): void {
  if (!line.startsWith(prefix)) {
    return;
  }
  addUnique(target, line.slice(prefix.length).trim());
}

function collectToolMessage(digest: RocContextDigest, message: ToolMessage): void {
  if (typeof message.name === 'string' && message.name.length > 0) {
    addUnique(digest.verifications, `${message.name}: ${String(message.content).slice(0, 200)}`);
  }
  const content = String(message.content);
  const fileMatches = content.match(/[A-Za-z]:\\[^\s'"<>|]+|\/workspace\/[^\s'"<>|]+/gu);
  if (fileMatches === null) {
    return;
  }
  for (const match of fileMatches) {
    addUnique(digest.filesTouched, match);
  }
}

function mergeDigest(target: RocContextDigest, source: RocContextDigest): void {
  mergeItems(target.facts, source.facts);
  mergeItems(target.decisions, source.decisions);
  mergeItems(target.filesTouched, source.filesTouched);
  mergeItems(target.verifications, source.verifications);
  mergeItems(target.openQuestions, source.openQuestions);
  mergeItems(target.nextActions, source.nextActions);
}

function mergeItems(target: string[], source: readonly string[]): void {
  for (const item of source) {
    addUnique(target, item);
  }
}

function addUnique(target: string[], value: string): void {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0 || target.includes(normalized) || target.length >= MAX_ITEMS_PER_FIELD) {
    return;
  }
  target.push(normalized);
}

function isEmptyDigest(digest: RocContextDigest): boolean {
  return (
    digest.facts.length === 0 &&
    digest.decisions.length === 0 &&
    digest.filesTouched.length === 0 &&
    digest.verifications.length === 0 &&
    digest.openQuestions.length === 0 &&
    digest.nextActions.length === 0
  );
}

function serializeDigest(digest: RocContextDigest): string {
  return [
    '<roc_context_digest>',
    serializeSection('facts', digest.facts),
    serializeSection('decisions', digest.decisions),
    serializeSection('filesTouched', digest.filesTouched),
    serializeSection('verifications', digest.verifications),
    serializeSection('openQuestions', digest.openQuestions),
    serializeSection('nextActions', digest.nextActions),
    '</roc_context_digest>'
  ].join('\n');
}

function serializeSection(name: keyof RocContextDigest, values: readonly string[]): string {
  if (values.length === 0) {
    return `<${name} />`;
  }
  return [`<${name}>`, ...values.map((value) => `- ${value}`), `</${name}>`].join('\n');
}

function findEligibleEnd(messages: BaseMessage[], keepRecent: number): number {
  let maxIteration = -1;
  for (const message of messages) {
    const iterationIndex = readIterationFromMessage(message);
    if (iterationIndex !== null && iterationIndex > maxIteration) {
      maxIteration = iterationIndex;
    }
  }
  if (maxIteration < 0) {
    return 0;
  }
  const keepThreshold = maxIteration - keepRecent;
  if (keepThreshold < 0) {
    return 0;
  }
  for (let index = 0; index < messages.length; index += 1) {
    const iterationIndex = readIterationFromMessage(messages[index]!);
    if (iterationIndex !== null && iterationIndex > keepThreshold) {
      return index;
    }
  }
  return messages.length;
}
```

- [ ] **Step 6: Export digest helpers**

Add this line to `src/main/services/forge-guardrails/index.ts`:

```ts
export * from './context-digest';
```

- [ ] **Step 7: Wire digest refresh before compaction deletion**

In `src/main/services/forge-guardrails/middleware/forge-tiered-compaction.ts`, import:

```ts
import {
  isContextDigestMessage,
  refreshContextDigestMessage
} from '../context-digest';
```

Update `ThresholdedEdit.apply()` to refresh digest before applying destructive edits:

```ts
    refreshContextDigestMessage(params.messages, DEFAULT_KEEP_RECENT);
```

Place it after the token threshold check and before the `for (const edit of this.edits)` loop.

In `ForgeDropReasoningTextEdit.apply()`, before reading tag, add:

```ts
      if (isContextDigestMessage(message)) {
        continue;
      }
```

In `ForgeDropToolResultsEdit.apply()` and `ForgeTruncateToolResultsEdit.apply()`, no digest-specific branch is needed because digest is an `AIMessage`, but adding the same guard is acceptable:

```ts
      if (isContextDigestMessage(message)) {
        continue;
      }
```

- [ ] **Step 8: Run digest and compaction tests**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/context-digest.test.ts tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run integration test**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/integration/full-stack.test.ts
```

Expected: PASS. If middleware order assertions fail because the integration test lists middleware names, update the expected list only if `ForgeIterationTrackingMiddleware` still appears before tiered compaction and digest refresh remains inside the compaction boundary.

- [ ] **Step 10: Commit Task 5**

Run:

```powershell
git add src/main/services/forge-guardrails/context-digest.ts src/main/services/forge-guardrails/message-tags.ts src/main/services/forge-guardrails/index.ts src/main/services/forge-guardrails/middleware/forge-tiered-compaction.ts tests/main/services/forge-guardrails/context-digest.test.ts tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts tests/main/services/forge-guardrails/integration/full-stack.test.ts
git commit -m "feat: preserve context digest during compaction"
```

Expected: commit succeeds.

---

### Task 6: Final Verification And Cleanup

**Files:**
- Inspect: all files changed by Tasks 1-5.
- Modify only if verification exposes a direct issue from Tasks 1-5.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: verified final branch state.

- [ ] **Step 1: Run Phase A focused tests**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts tests/main/services/deep-agent/context/context-assembler.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/deep-agent/context/memory-promotion.test.ts tests/main/plugins/memory/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Phase B focused tests**

Run:

```powershell
pnpm test -- tests/main/services/deep-agent/deep-agent-official-contracts.test.ts tests/main/services/deep-agent/backend.test.ts tests/main/deep-agent/store-memory-backend.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/plugins/agent/deep-agent-executor.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run Phase C focused tests**

Run:

```powershell
pnpm test -- tests/main/services/forge-guardrails/context-digest.test.ts tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts tests/main/services/forge-guardrails/middleware/forge-iteration-tracking.test.ts tests/main/services/forge-guardrails/integration/full-stack.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run TypeScript check**

Run:

```powershell
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Run patch whitespace check**

Run:

```powershell
git diff --check
```

Expected: no output, exit code 0.

- [ ] **Step 6: Check IPC only if shared IPC changed**

Run:

```powershell
git diff --name-only HEAD~5..HEAD
```

Expected: no `src/shared/ipc.ts`, `src/shared/ipc-schema.json`, or IPC generated files in the output. If any IPC file appears, run:

```powershell
pnpm check:ipc
```

Expected: PASS.

- [ ] **Step 7: Commit verification fixes if needed**

If any direct verification fix was required, run:

```powershell
git add src/main/services/forge-guardrails/middleware/prompt-caching.ts src/main/services/deep-agent/context/explicit-skills.ts src/main/services/deep-agent/context/prompt-blocks.ts src/main/services/deep-agent/context/memory-promotion.ts src/main/services/memory/auto-memory-writer.ts src/main/services/forge-guardrails/context-digest.ts src/main/services/forge-guardrails/message-tags.ts src/main/services/forge-guardrails/index.ts src/main/services/forge-guardrails/middleware/forge-tiered-compaction.ts tests/main/services/forge-guardrails/middleware/prompt-caching.test.ts tests/main/services/deep-agent/context/context-assembler.test.ts tests/main/services/deep-agent/context/prompt-blocks.test.ts tests/main/services/deep-agent/context/memory-promotion.test.ts tests/main/plugins/memory/plugin.test.ts tests/main/services/deep-agent/deep-agent-official-contracts.test.ts tests/main/deep-agent-build-wiring.test.ts tests/main/services/forge-guardrails/context-digest.test.ts tests/main/services/forge-guardrails/middleware/forge-tiered-compaction.test.ts tests/main/services/forge-guardrails/integration/full-stack.test.ts
git commit -m "fix: complete context engineering verification"
```

Expected: commit succeeds. If no fixes were required, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: Phase A prompt caching, explicit skill index, and memory duplicate suppression are covered by Tasks 1-3. Phase B native DeepAgents boundary and prompt trim are covered by Task 4. Phase C context digest and compaction retention are covered by Task 5. Final verification is covered by Task 6.
- Red-flag scan: no incomplete markers or open-ended test instructions remain.
- Type consistency: `ExplicitSkillContext` is changed to `{ id, name, path }` and all later tests use that shape. `RocContextDigest` fields match the design spec and the new digest tests.
