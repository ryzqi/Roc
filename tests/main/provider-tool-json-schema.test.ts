import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import {
  sanitizeAnthropicCompatibleTools,
  sanitizeOpenAiCompatibleTools,
  sanitizeProviderToolJsonSchema
} from '../../src/main/services/provider-tool-json-schema';

describe('sanitizeProviderToolJsonSchema', () => {
  it('collapses DeepAgents grep nullable defaults into plain optional types', () => {
    const schema = toJsonSchema(
      z.object({
        pattern: z.string(),
        glob: z.string().optional().nullable().default(null),
        max_count: z.coerce.number().int().positive().optional().nullable().default(null)
      })
    );

    const raw = JSON.stringify(schema);
    expect(raw.includes('"not":{}') || raw.includes('"null"')).toBe(true);

    const sanitized = sanitizeProviderToolJsonSchema(schema as Record<string, unknown>);

    expect(JSON.stringify(sanitized)).not.toContain('"not"');
    expect(JSON.stringify(sanitized)).not.toContain('"anyOf"');
    expect(sanitized).toMatchObject({
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        glob: { type: 'string' },
        max_count: { type: 'integer', exclusiveMinimum: 0 }
      },
      required: ['pattern'],
      additionalProperties: false
    });
  });

  it('collapses Zod v3 any-type not schemas used by DeepAgents grep', () => {
    const sanitized = sanitizeProviderToolJsonSchema({
      type: 'object',
      properties: {
        glob: {
          anyOf: [
            { anyOf: [{ not: {} }, { type: 'string' }] },
            { type: 'null' }
          ],
          default: null
        }
      },
      required: ['glob']
    });

    expect(JSON.stringify(sanitized)).not.toContain('"not"');
    expect(JSON.stringify(sanitized)).not.toContain('"anyOf"');
    expect(sanitized).toEqual({
      type: 'object',
      properties: {
        glob: { type: 'string' }
      },
      additionalProperties: false
    });
  });

  it('keeps object roots and drops empty additionalProperties maps', () => {
    const sanitized = sanitizeProviderToolJsonSchema({
      type: 'object',
      properties: {
        config: {
          anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: {} }]
        },
        payload: {
          type: 'object',
          additionalProperties: {}
        }
      },
      required: ['config']
    });

    expect(sanitized).toEqual({
      type: 'object',
      properties: {
        config: { type: 'string' },
        payload: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      },
      required: ['config'],
      additionalProperties: false
    });
  });

  it('sanitizes OpenAI function tools and Anthropic input_schema tools', () => {
    const grepParameters = toJsonSchema(
      z.object({
        glob: z.string().optional().nullable().default(null)
      })
    ) as Record<string, unknown>;

    expect(
      sanitizeOpenAiCompatibleTools([
        {
          type: 'function',
          function: {
            name: 'grep',
            parameters: grepParameters
          }
        }
      ])
    ).toMatchObject([
      {
        type: 'function',
        function: {
          name: 'grep',
          parameters: {
            type: 'object',
            properties: {
              glob: { type: 'string' }
            },
            additionalProperties: false
          }
        }
      }
    ]);

    expect(
      sanitizeAnthropicCompatibleTools([
        {
          name: 'grep',
          input_schema: grepParameters
        }
      ])
    ).toMatchObject([
      {
        name: 'grep',
        input_schema: {
          type: 'object',
          properties: {
            glob: { type: 'string' }
          },
          additionalProperties: false
        }
      }
    ]);
  });
});
