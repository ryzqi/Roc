import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { ConfigService } from '../../src/main/services/config-service';
import { RocPaths } from '../../src/main/services/paths';
import type { ProviderConfig } from '../../src/shared/types';

let root: string;
let paths: RocPaths;

function readSettingsDocument(): unknown {
  return JSON.parse(readFileSync(join(root, 'config', 'settings.json'), 'utf8')) as unknown;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-config-test-'));
  paths = new RocPaths(root);
  paths.ensureTree();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});


describe('ConfigService unified settings document', () => {
  it('persists OpenAI-compatible and Anthropic-compatible advanced provider options through the unified settings document', () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'gpt-openai-1',
      providers: [
        {
          id: 'openai-advanced',
          name: 'OpenAI Advanced',
          type: 'openai_compatible',
          endpoint: 'https://openai.example.test/v1',
          credentialRef: 'secret:openai-advanced',
          enabled: true,
          models: [
            {
              id: 'gpt-openai-1',
              displayName: 'GPT OpenAI 1',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            temperature: 0.2,
            maxTokens: 2048,
            topP: 0.8,
            frequencyPenalty: 0.3,
            presencePenalty: 0.1,
            stop: ['DONE'],
            seed: 7,
            organization: 'org-roc-config',
            useResponsesApi: true,
            reasoning: {
              effort: 'high',
              summary: 'concise'
            },
            streamUsage: false,
            parallelToolCalls: true,
            serviceTier: 'priority',
            timeoutMs: 15_000,
            verbosity: 'medium',
            zdrEnabled: true,
            defaultHeaders: {
              'x-client': 'roc'
            },
            modelKwargs: {
              chat_template_kwargs: {
                enable_thinking: true
              }
            }
          } as ProviderConfig['options']
        },
        {
          id: 'anthropic-advanced',
          name: 'Anthropic Advanced',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-advanced',
          enabled: true,
          models: [
            {
              id: 'claude-advanced-1',
              displayName: 'Claude Advanced 1',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            temperature: 0.1,
            maxTokens: 4096,
            topP: 0.85,
            topK: 12,
            stop: ['\n\nHuman:'],
            streamUsage: false,
            timeoutMs: 22_000,
            defaultHeaders: {
              'x-tenant': 'east'
            },
            anthropicThinking: {
              mode: 'adaptive'
            }
          }
        }
      ]
    });

    expect(configService.getProviders().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'openai-advanced',
          options: {
            temperature: 0.2,
            maxTokens: 2048,
            topP: 0.8,
            frequencyPenalty: 0.3,
            presencePenalty: 0.1,
            stop: ['DONE'],
            seed: 7,
            organization: 'org-roc-config',
            useResponsesApi: true,
            reasoning: {
              effort: 'high',
              summary: 'concise'
            },
            streamUsage: false,
            parallelToolCalls: true,
            serviceTier: 'priority',
            timeoutMs: 15_000,
            verbosity: 'medium',
            zdrEnabled: true,
            defaultHeaders: {
              'x-client': 'roc'
            },
            modelKwargs: {
              chat_template_kwargs: {
                enable_thinking: true
              }
            }
          }
        }),
        expect.objectContaining({
          id: 'anthropic-advanced',
          options: {
            temperature: 0.1,
            maxTokens: 4096,
            topP: 0.85,
            topK: 12,
            stop: ['\n\nHuman:'],
            streamUsage: false,
            timeoutMs: 22_000,
            defaultHeaders: {
              'x-tenant': 'east'
            },
            anthropicThinking: {
              mode: 'adaptive'
            }
          }
        })
      ])
    );

    expect(readSettingsDocument()).toMatchObject({
      providers: {
        defaultModelId: 'gpt-openai-1',
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'openai-advanced',
            options: expect.objectContaining({
              defaultHeaders: {
                'x-client': 'roc'
              },
              organization: 'org-roc-config',
              useResponsesApi: true,
              reasoning: {
                effort: 'high',
                summary: 'concise'
              },
              serviceTier: 'priority',
              timeoutMs: 15_000,
              verbosity: 'medium',
              zdrEnabled: true,
              modelKwargs: {
                chat_template_kwargs: {
                  enable_thinking: true
                }
              }
            })
          }),
          expect.objectContaining({
            id: 'anthropic-advanced',
            options: expect.objectContaining({
              defaultHeaders: {
                'x-tenant': 'east'
              },
              anthropicThinking: {
                mode: 'adaptive'
              }
            })
          })
        ])
      }
    });
  });


  it('rejects persisted Anthropic thinking configs that violate the official budget contract', () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    let missingBudgetError: unknown;
    try {
      configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'claude-invalid-missing-budget',
        providers: [
          {
            id: 'anthropic-invalid-missing-budget',
            name: 'Anthropic Invalid Missing Budget',
            type: 'anthropic_compatible',
            endpoint: 'https://anthropic.example.test',
            credentialRef: 'secret:anthropic-invalid-missing-budget',
            enabled: true,
            models: [
              {
                id: 'claude-invalid-missing-budget',
                displayName: 'Claude Invalid Missing Budget',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ],
            options: {
              maxTokens: 4096,
              anthropicThinking: {
                mode: 'enabled'
              }
            }
          }
        ]
      } as unknown as Parameters<ConfigService['saveProviders']>[0]);
    } catch (error) {
      missingBudgetError = error;
    }

    expect(missingBudgetError).toBeInstanceOf(ZodError);
    expect((missingBudgetError as ZodError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['providers', 0, 'options', 'anthropicThinking']
        })
      ])
    );

    let tooSmallBudgetError: unknown;
    try {
      configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'claude-invalid-small-budget',
        providers: [
          {
            id: 'anthropic-invalid-small-budget',
            name: 'Anthropic Invalid Small Budget',
            type: 'anthropic_compatible',
            endpoint: 'https://anthropic.example.test',
            credentialRef: 'secret:anthropic-invalid-small-budget',
            enabled: true,
            models: [
              {
                id: 'claude-invalid-small-budget',
                displayName: 'Claude Invalid Small Budget',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ],
            options: {
              maxTokens: 4096,
              anthropicThinking: {
                mode: 'enabled',
                budgetTokens: 1023
              }
            }
          }
        ]
      });
    } catch (error) {
      tooSmallBudgetError = error;
    }

    expect(tooSmallBudgetError).toBeInstanceOf(ZodError);
    expect((tooSmallBudgetError as ZodError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['providers', 0, 'options', 'anthropicThinking', 'budgetTokens']
        })
      ])
    );

    let oversizedBudgetError: unknown;
    try {
      configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: 'claude-invalid-oversized-budget',
        providers: [
          {
            id: 'anthropic-invalid-oversized-budget',
            name: 'Anthropic Invalid Oversized Budget',
            type: 'anthropic_compatible',
            endpoint: 'https://anthropic.example.test',
            credentialRef: 'secret:anthropic-invalid-oversized-budget',
            enabled: true,
            models: [
              {
                id: 'claude-invalid-oversized-budget',
                displayName: 'Claude Invalid Oversized Budget',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ],
            options: {
              maxTokens: 2048,
              anthropicThinking: {
                mode: 'enabled',
                budgetTokens: 2048
              }
            }
          }
        ]
      });
    } catch (error) {
      oversizedBudgetError = error;
    }

    expect(oversizedBudgetError).toBeInstanceOf(ZodError);
    expect((oversizedBudgetError as ZodError).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['providers', 0, 'options', 'anthropicThinking', 'budgetTokens']
        })
      ])
    );
  });


  it('persists explicit Anthropic disabled thinking configs through the unified settings document', () => {
    const configService = new ConfigService(paths);
    configService.initialize();

    configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'claude-disabled-thinking',
      providers: [
        {
          id: 'anthropic-disabled-thinking',
          name: 'Anthropic Disabled Thinking',
          type: 'anthropic_compatible',
          endpoint: 'https://anthropic.example.test',
          credentialRef: 'secret:anthropic-disabled-thinking',
          enabled: true,
          models: [
            {
              id: 'claude-disabled-thinking',
              displayName: 'Claude Disabled Thinking',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ],
          options: {
            anthropicThinking: {
              mode: 'disabled'
            }
          }
        }
      ]
    });

    expect(configService.getProviders().providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'anthropic-disabled-thinking',
          options: {
            anthropicThinking: {
              mode: 'disabled'
            }
          }
        })
      ])
    );

    expect(readSettingsDocument()).toMatchObject({
      providers: {
        defaultModelId: 'claude-disabled-thinking',
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: 'anthropic-disabled-thinking',
            options: {
              anthropicThinking: {
                mode: 'disabled'
              }
            }
          })
        ])
      }
    });
  });
});
