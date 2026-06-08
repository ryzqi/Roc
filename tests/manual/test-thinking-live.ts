/**
 * 实时测试三个供应商的 thinking/reasoning 功能
 *
 * 使用方法：
 * 1. 确保已配置好三个供应商（NVIDIA Kimi、llama.cpp、Agnes）
 * 2. 运行: pnpm tsx tests/manual/test-thinking-live.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { createAppServices } from '../../src/main/services/app-service';
import type { ProviderConfig } from '../../src/shared/types';

async function testProvider(
  providerConfig: ProviderConfig,
  modelId: string,
  prompt: string
): Promise<{ hasReasoning: boolean; reasoningContent: string | null; responseContent: string }> {
  const root = mkdtempSync(join(tmpdir(), 'roc-thinking-test-'));

  try {
    const services = createAppServices(root);
    await services.appService.initialize();

    // 保存供应商配置
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: modelId,
      providers: [providerConfig]
    });

    // 如果有凭据引用，设置测试凭据
    if (providerConfig.credentialRef?.startsWith('secret:')) {
      const secretKey = providerConfig.credentialRef.replace('secret:', '');
      services.secretService.setProviderSecret(secretKey, 'test-key');
    }

    const factory = services.langChainModelFactory;
    const handle = await factory.createDefaultChatModel({ streaming: true });

    console.log(`\n📡 测试供应商: ${providerConfig.name} (${providerConfig.type})`);
    console.log(`📋 模型: ${modelId}`);
    console.log(`⚙️  Options:`, JSON.stringify(providerConfig.options, null, 2));
    console.log(`🔧 Model kwargs:`, JSON.stringify(handle.runtime.modelKwargs, null, 2));

    let hasReasoning = false;
    let reasoningContent: string | null = null;
    let responseContent = '';
    let chunkCount = 0;

    console.log(`\n💭 发送提示: "${prompt}"\n`);
    console.log('📥 流式响应:');
    console.log('─'.repeat(80));

    try {
      const stream = await handle.model.stream([new HumanMessage(prompt)]);

      for await (const chunk of stream) {
        chunkCount++;

        // 检查 content
        if (chunk.content) {
          if (typeof chunk.content === 'string') {
            process.stdout.write(chunk.content);
            responseContent += chunk.content;
          } else if (Array.isArray(chunk.content)) {
            for (const block of chunk.content) {
              if (typeof block === 'object' && block !== null) {
                const contentBlock = block as { type?: string; reasoning?: string; text?: string };
                if (contentBlock.type === 'reasoning' && contentBlock.reasoning) {
                  hasReasoning = true;
                  if (reasoningContent === null) {
                    reasoningContent = contentBlock.reasoning;
                  } else {
                    reasoningContent += contentBlock.reasoning;
                  }
                  console.log(`\n🧠 [推理内容]: ${contentBlock.reasoning}`);
                } else if (contentBlock.type === 'text' && contentBlock.text) {
                  process.stdout.write(contentBlock.text);
                  responseContent += contentBlock.text;
                }
              }
            }
          }
        }

        // 检查 additional_kwargs 中的 reasoning_content
        const additionalKwargs = (chunk as { additional_kwargs?: Record<string, unknown> }).additional_kwargs;
        if (additionalKwargs) {
          const reasoningFromKwargs = additionalKwargs.reasoning_content || additionalKwargs.reasoningContent;
          if (typeof reasoningFromKwargs === 'string' && reasoningFromKwargs.length > 0) {
            hasReasoning = true;
            if (reasoningContent === null) {
              reasoningContent = reasoningFromKwargs;
            } else {
              reasoningContent += reasoningFromKwargs;
            }
            console.log(`\n🧠 [推理 - additional_kwargs]: ${reasoningFromKwargs.slice(0, 100)}...`);
          }
        }

        // 检查 response_metadata 中的 reasoning_content
        const responseMetadata = (chunk as { response_metadata?: Record<string, unknown> }).response_metadata;
        if (responseMetadata?.reasoning_content && typeof responseMetadata.reasoning_content === 'string') {
          hasReasoning = true;
          if (reasoningContent === null) {
            reasoningContent = responseMetadata.reasoning_content;
          }
          console.log(`\n🧠 [推理 - response_metadata]: ${responseMetadata.reasoning_content.slice(0, 100)}...`);
        }
      }

      console.log('\n' + '─'.repeat(80));
      console.log(`✅ 完成 - 收到 ${chunkCount} 个块`);

    } catch (error) {
      console.error('\n❌ 流式请求失败:', error);
      throw error;
    }

    await services.appService.shutdown();

    return { hasReasoning, reasoningContent, responseContent };

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  console.log('🚀 开始测试 Thinking/Reasoning 功能\n');
  console.log('=' .repeat(80));

  const testPrompt = '请解释量子纠缠的原理。先思考，再回答。';

  // 测试 1: NVIDIA Kimi K2.6
  console.log('\n\n🔹 测试 1/3: NVIDIA Kimi K2.6');
  console.log('=' .repeat(80));

  const nvidiaConfig: ProviderConfig = {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    type: 'nvidia',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    credentialRef: 'secret:nvidia',
    enabled: true,
    models: [
      {
        id: 'moonshotai/kimi-k2.6',
        displayName: 'Kimi K2.6',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true
      }
    ],
    options: {
      thinking: true,  // 关键：启用思考
      maxTokens: 500
    }
  };

  try {
    const result1 = await testProvider(nvidiaConfig, 'moonshotai/kimi-k2.6', testPrompt);
    console.log('\n\n📊 结果:');
    console.log(`  ✓ 是否有推理: ${result1.hasReasoning ? '✅ 是' : '❌ 否'}`);
    console.log(`  ✓ 推理内容长度: ${result1.reasoningContent?.length ?? 0} 字符`);
    console.log(`  ✓ 响应内容长度: ${result1.responseContent.length} 字符`);
    if (result1.reasoningContent) {
      console.log(`  ✓ 推理预览: ${result1.reasoningContent.slice(0, 200)}...`);
    }
  } catch (error) {
    console.error('❌ NVIDIA Kimi 测试失败:', error);
  }

  // 测试 2: llama.cpp
  console.log('\n\n🔹 测试 2/3: llama.cpp (Qwen3.5-4B-UD)');
  console.log('=' .repeat(80));

  const llamaCppConfig: ProviderConfig = {
    id: 'llama_cpp',
    name: 'llama.cpp',
    type: 'llama_cpp',
    endpoint: 'http://127.0.0.1:8080/v1',
    credentialRef: null,
    enabled: true,
    models: [
      {
        id: 'Qwen3.5-4B-UD-Q5_K_XL',
        displayName: 'Qwen 3.5 4B UD',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true
      }
    ]
  };

  try {
    const result2 = await testProvider(llamaCppConfig, 'Qwen3.5-4B-UD-Q5_K_XL', testPrompt);
    console.log('\n\n📊 结果:');
    console.log(`  ✓ 是否有推理: ${result2.hasReasoning ? '✅ 是' : '❌ 否'}`);
    console.log(`  ✓ 推理内容长度: ${result2.reasoningContent?.length ?? 0} 字符`);
    console.log(`  ✓ 响应内容长度: ${result2.responseContent.length} 字符`);
    if (result2.reasoningContent) {
      console.log(`  ✓ 推理预览: ${result2.reasoningContent.slice(0, 200)}...`);
    }
  } catch (error) {
    console.error('❌ llama.cpp 测试失败:', error);
  }

  // 测试 3: Agnes (OpenAI-compatible)
  console.log('\n\n🔹 测试 3/3: Agnes 2.0 Flash');
  console.log('=' .repeat(80));

  const agnesConfig: ProviderConfig = {
    id: 'agnes',
    name: 'Agnes',
    type: 'openai_compatible',
    endpoint: 'https://api.agnes.com/v1',
    credentialRef: 'secret:agnes',
    enabled: true,
    models: [
      {
        id: 'agnes-2.0-flash',
        displayName: 'Agnes 2.0 Flash',
        enabled: true,
        supportsStreaming: true,
        supportsToolCalls: true
      }
    ],
    options: {
      reasoning: {
        effort: 'medium'
      },
      maxTokens: 500
    }
  };

  try {
    const result3 = await testProvider(agnesConfig, 'agnes-2.0-flash', testPrompt);
    console.log('\n\n📊 结果:');
    console.log(`  ✓ 是否有推理: ${result3.hasReasoning ? '✅ 是' : '❌ 否'}`);
    console.log(`  ✓ 推理内容长度: ${result3.reasoningContent?.length ?? 0} 字符`);
    console.log(`  ✓ 响应内容长度: ${result3.responseContent.length} 字符`);
    if (result3.reasoningContent) {
      console.log(`  ✓ 推理预览: ${result3.reasoningContent.slice(0, 200)}...`);
    }
  } catch (error) {
    console.error('❌ Agnes 测试失败:', error);
  }

  console.log('\n\n' + '='.repeat(80));
  console.log('🎉 测试完成！');
  console.log('='.repeat(80));
}

main().catch(console.error);
