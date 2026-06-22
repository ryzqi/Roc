import { describe, expect, it } from 'vitest';
import {
  providerTypeMeta
} from '../../src/renderer/settings/provider-draft-model';


describe('settings model helpers', () => {
  it('providerTypeMeta returns OpenAI defaults for openai_compatible', () => {
    expect(providerTypeMeta('openai_compatible')).toEqual({
      defaultBaseUrl: 'https://api.openai.com/v1'
    });
    expect(providerTypeMeta('openrouter')).toEqual({
      defaultBaseUrl: 'https://openrouter.ai/api/v1'
    });
  });


  it('providerTypeMeta returns Anthropic defaults for anthropic_compatible', () => {
    expect(providerTypeMeta('anthropic_compatible')).toEqual({
      defaultBaseUrl: 'https://api.anthropic.com'
    });
    expect(providerTypeMeta('llama_cpp')).toEqual({
      defaultBaseUrl: 'http://127.0.0.1:8081/v1'
    });
  });
});

