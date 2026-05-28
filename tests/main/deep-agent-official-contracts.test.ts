import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesystemMiddleware, createSkillsMiddleware } from 'deepagents';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { createBackend } from '../../src/main/services/deep-agent/backend';

let root: string;
let userHome: string;
let previousUserProfile: string | undefined;
let services: AppServices;

function createShellExecutionAdapter(overrides?: { threadId?: string; runId?: string }) {
  return {
    executeAgentCommand: async (input: { command: string; cwd?: string }) =>
      await services.shellExecutionService.executeAgentCommandAsync({
        ...input,
        threadId: overrides?.threadId,
        runId: overrides?.runId
      })
  } as const;
}

function getBeforeAgentHook(
  middleware: unknown
): ((state: object) => Promise<unknown> | unknown) | null {
  const candidate = (middleware as { beforeAgent?: unknown }).beforeAgent;
  if (typeof candidate === 'function') {
    return candidate as (state: object) => Promise<unknown> | unknown;
  }
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'hook' in candidate &&
    typeof (candidate as { hook?: unknown }).hook === 'function'
  ) {
    return (candidate as { hook: (state: object) => Promise<unknown> | unknown }).hook;
  }
  return null;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-deep-agent-contracts-'));
  userHome = mkdtempSync(join(tmpdir(), 'roc-deep-agent-contracts-home-'));
  previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = userHome;
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
});

describe('deep agent official contracts', () => {
  it('exposes execute only when the runtime backend satisfies the official sandbox backend protocol', async () => {
    const backend = createBackend({
      workspaceService: services.workspaceService,
      paths: services.paths,
      shellExecutionService: createShellExecutionAdapter()
    }).backend;
    const middleware = createFilesystemMiddleware({
      backend
    });
    const tools = Array.from(
      ((middleware as { tools?: Array<{ name: string }> }).tools ?? []) as Array<{ name: string }>
    );
    const executeTool = tools.find((tool) => tool.name === 'execute');

    expect(executeTool).toBeDefined();

    const collectedTools: string[][] = [];
    await middleware.wrapModelCall!(
      {
        runtime: { state: {} },
        state: {},
        systemMessage: [],
        messages: [],
        tools
      } as never,
      async (request) => {
        const requestTools = ((request as { tools?: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
        collectedTools.push(requestTools);
        return 'ok' as never;
      }
    );

    expect(collectedTools.at(-1)).toContain('execute');
  });

  it('discovers selected skills through a root /skills/ source and selected backend projection', async () => {
    mkdirSync(join(services.paths.skillsDir, 'alpha-review'), { recursive: true });
    mkdirSync(join(services.paths.skillsDir, 'project-review'), { recursive: true });
    writeFileSync(
      join(services.paths.skillsDir, 'alpha-review', 'SKILL.md'),
      ['---', 'name: alpha-review', 'description: Alpha review skill', '---', 'Alpha instructions'].join('\n'),
      'utf8'
    );
    writeFileSync(
      join(services.paths.skillsDir, 'project-review', 'SKILL.md'),
      ['---', 'name: project-review', 'description: Project review skill', '---', 'Project instructions'].join('\n'),
      'utf8'
    );

    const backend = createBackend({
      workspaceService: services.workspaceService,
      paths: services.paths,
      shellExecutionService: createShellExecutionAdapter(),
      selectedSkillIds: ['project-review']
    }).backend;
    const middleware = createSkillsMiddleware({
      backend,
      sources: ['/skills/']
    });

    const beforeAgent = getBeforeAgentHook(middleware);
    const beforeAgentResult = beforeAgent === null ? undefined : await beforeAgent({});
    const skillsMetadata = (beforeAgentResult as { skillsMetadata?: Array<{ name: string; description: string; path: string }> })?.skillsMetadata ?? [];

    expect(skillsMetadata).toEqual([
      expect.objectContaining({
        name: 'project-review',
        description: 'Project review skill',
        path: '/skills/project-review/SKILL.md'
      })
    ]);
    expect(skillsMetadata).not.toContainEqual(
      expect.objectContaining({
        name: 'alpha-review'
      })
    );
  });
});
