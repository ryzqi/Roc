import { describe, expect, it } from 'vitest';

import { compileRunCapabilityManifest } from '../../../../src/main/plugins/agent/run-capability-manifest';

describe('run capability manifest', () => {
  it('normalizes selections and records immutable tool authority', () => {
    const compiled = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'default',
      mcpApprovalMode: 'default',
      mcpServers: [
        mcpServer({
          id: 'docs',
          allowedTools: ['search_docs']
        }),
        mcpServer({
          id: 'disabled',
          enabled: false,
          allowedTools: ['search_disabled']
        })
      ],
      requestedCapabilities: {
        mcpServers: ['docs', 'docs', 'disabled', 'missing'],
        skills: ['research', 'research', 'invalid', 'missing']
      },
      skills: [
        skill({ id: 'research' }),
        skill({ id: 'invalid', status: 'invalid' })
      ],
      mode: 'chat',
      workflowHint: null
    });

    expect(compiled.manifest).toMatchObject({
      schemaVersion: 1,
      requestedCapabilities: {
        mcpServers: ['docs', 'disabled', 'missing'],
        skills: ['research', 'invalid', 'missing']
      },
      resolvedCapabilities: {
        mcpServers: ['docs'],
        skills: ['research']
      },
      skills: [
        {
          canonicalIdentity: 'skill:research',
          name: 'research',
          sourcePath: 'F:\\Skills\\research',
          description: 'research skill'
        }
      ],
      skippedCapabilities: [
        { id: 'disabled', type: 'mcp_server', reason: 'disabled' },
        { id: 'missing', type: 'mcp_server', reason: 'not_found' },
        { id: 'invalid', type: 'skill', reason: 'invalid' },
        { id: 'missing', type: 'skill', reason: 'not_found' }
      ]
    });
    expect(compiled.manifest.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalIdentity: 'builtin:run_shell_command',
          modelVisibleName: 'run_shell_command',
          provenance: { kind: 'builtin', source: 'roc' },
          effectClass: 'host_execution',
          approvalPolicy: { kind: 'none' },
          idempotencyStrategy: 'tool_call',
          resourceScope: 'external'
        }),
        expect.objectContaining({
          canonicalIdentity: 'mcp:docs:search_docs',
          modelVisibleName: 'search_docs',
          provenance: { kind: 'mcp', serverId: 'docs' },
          effectClass: 'external_call',
          approvalPolicy: { kind: 'required', allowedDecisions: ['approve', 'reject'] },
          idempotencyStrategy: 'tool_call',
          resourceScope: 'external',
          executionScopes: ['main', 'subagent']
        }),
        expect.objectContaining({
          canonicalIdentity: 'web:web_read',
          effectClass: 'network_read',
          approvalPolicy: { kind: 'none' },
          executionScopes: ['main', 'subagent']
        }),
        expect.objectContaining({
          canonicalIdentity: 'builtin:delete_file',
          approvalPolicy: { kind: 'required', allowedDecisions: ['approve', 'edit', 'reject'] },
          effectClass: 'workspace_mutation'
        })
      ])
    );
    expect(compiled.manifest.manifestHash).toHaveLength(64);
    expect(compiled.manifest.manifestHash).toBe(
      compileRunCapabilityManifest({
        deleteFileApprovalMode: 'default',
        mcpApprovalMode: 'default',
        mcpServers: [
          mcpServer({
            id: 'docs',
            allowedTools: ['search_docs']
          }),
          mcpServer({
            id: 'disabled',
            enabled: false,
            allowedTools: ['search_disabled']
          })
        ],
        requestedCapabilities: {
          mcpServers: ['docs', 'docs', 'disabled', 'missing'],
          skills: ['research', 'research', 'invalid', 'missing']
        },
        skills: [
          skill({ id: 'research' }),
          skill({ id: 'invalid', status: 'invalid' })
        ],
        mode: 'chat',
        workflowHint: null
      }).manifest.manifestHash
    );
  });

  it('rejects model-visible MCP tool name collisions instead of silently changing authority', () => {
    expect(() =>
      compileRunCapabilityManifest({
        deleteFileApprovalMode: 'fully_automatic',
        mcpApprovalMode: 'fully_automatic',
        mcpServers: [
          mcpServer({ id: 'docs-a', allowedTools: ['search_docs'] }),
          mcpServer({ id: 'docs-b', allowedTools: ['search_docs'] })
        ],
        requestedCapabilities: {
          mcpServers: ['docs-a', 'docs-b'],
          skills: []
        },
        skills: [],
        mode: 'chat',
        workflowHint: null
      })
    ).toThrow('run_capability_model_visible_name_collision:search_docs');
  });

  it('freezes explicit skills without changing the resolved selection', () => {
    const compiled = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      explicitSkillIds: ['python-expert'],
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      mode: 'chat',
      workflowHint: null,
      requestedCapabilities: {
        mcpServers: [],
        skills: ['typescript']
      },
      skills: [skill({ id: 'python-expert' }), skill({ id: 'typescript' })]
    });

    expect(compiled.manifest.resolvedCapabilities.skills).toEqual(['typescript']);
    expect(compiled.manifest.skills.map((skill) => skill.canonicalIdentity)).toEqual([
      'skill:typescript',
      'skill:python-expert'
    ]);
    expect(compiled.skillCards.map((card) => card.id)).toEqual(['skill:typescript', 'skill:python-expert']);
    expect(() =>
      compileRunCapabilityManifest({
        deleteFileApprovalMode: 'fully_automatic',
        explicitSkillIds: ['python-expert'],
        mcpApprovalMode: 'fully_automatic',
        mcpServers: [],
        mode: 'chat',
        workflowHint: null,
        requestedCapabilities: {
          mcpServers: [],
          skills: []
        },
        skills: [
          {
            ...skill({ id: 'python-expert' }),
            enabled: false
          }
        ]
      })
    ).toThrow('skill_disabled:python-expert');
  });

  it('hashes skill execution input and rejects MCP names reserved by the runtime tool surface', () => {
    const original = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      requestedCapabilities: {
        mcpServers: [],
        skills: ['research']
      },
      skills: [skill({ id: 'research' })],
      mode: 'chat',
      workflowHint: null
    });
    const relocated = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      requestedCapabilities: {
        mcpServers: [],
        skills: ['research']
      },
      skills: [
        {
          ...skill({ id: 'research' }),
          path: 'F:\\Skills\\relocated-research'
        }
      ],
      mode: 'chat',
      workflowHint: null
    });

    expect(relocated.manifest.manifestHash).not.toBe(original.manifest.manifestHash);
    const automaticMcp = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [mcpServer({ id: 'docs', allowedTools: ['search_docs'] })],
      requestedCapabilities: {
        mcpServers: ['docs'],
        skills: []
      },
      skills: [],
      mode: 'chat',
      workflowHint: null
    });
    expect(automaticMcp.manifest.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalIdentity: 'mcp:docs:search_docs',
          approvalPolicy: { kind: 'none' },
          executionScopes: ['main', 'subagent']
        })
      ])
    );
    expect(() =>
      compileRunCapabilityManifest({
        deleteFileApprovalMode: 'fully_automatic',
        mcpApprovalMode: 'fully_automatic',
        mcpServers: [mcpServer({ id: 'unsafe', allowedTools: ['propose_background_task'] })],
        requestedCapabilities: {
          mcpServers: ['unsafe'],
          skills: []
        },
        skills: [],
        mode: 'chat',
        workflowHint: null
      })
    ).toThrow('run_capability_model_visible_name_reserved:propose_background_task');
    expect(() =>
      compileRunCapabilityManifest({
        deleteFileApprovalMode: 'fully_automatic',
        mcpApprovalMode: 'fully_automatic',
        mcpServers: [mcpServer({ id: 'unsafe', allowedTools: ['write_file'] })],
        requestedCapabilities: {
          mcpServers: ['unsafe'],
          skills: []
        },
        skills: [],
        mode: 'chat',
        workflowHint: null
      })
    ).toThrow('run_capability_model_visible_name_reserved:write_file');
  });

  it('filters plan-only blocked tools while exposing the actual general-purpose subagent surface', () => {
    const compiled = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [mcpServer({ id: 'docs', allowedTools: ['search_docs'] })],
      requestedCapabilities: {
        mcpServers: ['docs'],
        skills: []
      },
      skills: [],
      mode: 'plan',
      workflowHint: null
    });

    expect(compiled.manifest.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalIdentity: 'mcp:docs:search_docs',
          executionScopes: ['main', 'subagent']
        })
      ])
    );
    expect(compiled.manifest.tools.map((tool) => tool.canonicalIdentity)).not.toEqual(
      expect.arrayContaining(['builtin:delete_file', 'builtin:run_shell_command'])
    );
    expect(compiled.interruptOn.delete_file).toBeUndefined();
    expect(compiled.interruptOn.propose_background_task).toBeUndefined();
    expect(compiled.subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'general-purpose',
          tools: expect.arrayContaining(['web_read', 'search_docs'])
        }),
        expect.objectContaining({
          id: 'research',
          tools: ['web_read']
        })
      ])
    );
  });

  it('records every model-visible Roc runtime tool with its frozen execution scope', () => {
    const compiled = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      requestedCapabilities: { mcpServers: [], skills: [] },
      skills: [],
      mode: 'chat',
      workflowHint: null
    });
    const backgroundCompiled = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      requestedCapabilities: { mcpServers: [], skills: [] },
      skills: [],
      mode: 'chat',
      workflowHint: 'propose_background_task'
    });

    expect(compiled.manifest.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalIdentity: 'builtin:write_file',
        executionScopes: ['main', 'subagent'],
        effectClass: 'workspace_mutation'
      }),
      expect.objectContaining({
        canonicalIdentity: 'builtin:session_search',
        executionScopes: ['main'],
        resourceScope: 'memory'
      })
    ]));
    expect(compiled.subagents.find((subagent) => subagent.id === 'general-purpose')?.tools).toEqual(
      expect.arrayContaining(['write_file'])
    );
    expect(compiled.subagents.find((subagent) => subagent.id === 'general-purpose')?.tools).not.toEqual(
      expect.arrayContaining(['schedule_background_task'])
    );
    expect(compiled.manifest.tools.map((tool) => tool.modelVisibleName)).not.toContain('schedule_background_task');
    expect(backgroundCompiled.manifest.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalIdentity: 'builtin:schedule_background_task',
        executionScopes: ['main'],
        effectClass: 'external_call'
      })
    ]));
  });

  it('does not expose host shell to a background run without durable pre-authorization', () => {
    const blocked = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      requestedCapabilities: { mcpServers: [], skills: [] },
      skills: [],
      mode: 'task',
      shellAllowedCommands: [],
      workflowHint: null
    });
    const authorized = compileRunCapabilityManifest({
      deleteFileApprovalMode: 'fully_automatic',
      mcpApprovalMode: 'fully_automatic',
      mcpServers: [],
      requestedCapabilities: { mcpServers: [], skills: [] },
      skills: [],
      mode: 'task',
      shellAllowedCommands: ['git status'],
      workflowHint: null
    });

    expect(blocked.manifest.tools.map((tool) => tool.modelVisibleName)).not.toContain('run_shell_command');
    expect(authorized.manifest.tools.map((tool) => tool.modelVisibleName)).toContain('run_shell_command');
  });
});

function mcpServer(input: {
  id: string;
  allowedTools: string[];
  enabled?: boolean;
}): {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'http';
  status: 'ready';
  tools: number;
  preset: false;
  riskLevel: 'medium';
  url: string;
  allowedTools: string[];
  lastError: null;
} {
  return {
    id: input.id,
    name: input.id,
    enabled: input.enabled === undefined ? true : input.enabled,
    transport: 'http',
    status: 'ready',
    tools: input.allowedTools.length,
    preset: false,
    riskLevel: 'medium',
    url: `https://${input.id}.example.test/mcp`,
    allowedTools: input.allowedTools,
    lastError: null
  };
}

function skill(input: { id: string; status?: 'ready' | 'invalid' }): {
  id: string;
  name: string;
  enabled: true;
  path: string;
  description: string;
  status: 'ready' | 'invalid';
} {
  return {
    id: input.id,
    name: input.id,
    enabled: true,
    path: `F:\\Skills\\${input.id}`,
    description: `${input.id} skill`,
    status: input.status === undefined ? 'ready' : input.status
  };
}
