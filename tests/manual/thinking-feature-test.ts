/**
 * 思考功能手动测试脚本
 *
 * 测试三个供应商的思考功能：
 * 1. NVIDIA供应商 - moonshotai/kimi-k2.6
 * 2. llama.cpp - Qwen3.5-4B-UD-Q5_K_XL.gguf
 * 3. OpenAI兼容 - 通过 modelKwargs 统一配置思考参数
 */

import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';

interface TestResult {
  provider: string;
  modelId: string;
  success: boolean;
  hasReasoning: boolean;
  reasoningContent: string | null;
  responseContent: string;
  error: string | null;
  responseMetadata?: unknown;
  additionalKwargs?: unknown;
}

// 测试提示词
const TEST_PROMPT = '请计算 2+2 等于多少？请先思考这个问题，然后给出答案。';

/**
 * 测试 NVIDIA 供应商 - Kimi K2.6
 */
async function testNvidiaKimi(): Promise<TestResult> {
  console.log('\n=== 测试 1: NVIDIA Kimi-K2.6 ===\n');

  const result: TestResult = {
    provider: 'nvidia',
    modelId: 'moonshotai/kimi-k2.6',
    success: false,
    hasReasoning: false,
    reasoningContent: null,
    responseContent: '',
    error: null
  };

  try {
    // 从环境变量获取 API Key
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      throw new Error('NVIDIA_API_KEY 环境变量未设置');
    }

    // 创建模型实例，启用思考功能
    const model = new ChatOpenAI({
      model: 'moonshotai/kimi-k2.6',
      apiKey,
      configuration: {
        baseURL: 'https://integrate.api.nvidia.com/v1'
      },
      streaming: false,
      // NVIDIA Kimi 使用 chat_template_kwargs 传递 thinking 参数
      modelKwargs: {
        chat_template_kwargs: {
          thinking: true  // 启用思考模式
        }
      }
    });

    console.log('发送请求...');
    const response = await model.invoke(TEST_PROMPT);

    console.log('响应类型:', typeof response);
    console.log('响应内容:', response.content);
    console.log('additional_kwargs:', JSON.stringify(response.additional_kwargs, null, 2));
    console.log('response_metadata:', JSON.stringify(response.response_metadata, null, 2));

    // 检查思考内容
    const reasoningFromAdditionalKwargs =
      (response.additional_kwargs as Record<string, unknown>)?.reasoning_content as string | undefined;
    const reasoningFromMetadata =
      (response.response_metadata as Record<string, unknown>)?.reasoning_content as string | undefined;
    const reasoningFromCamelCase =
      (response.additional_kwargs as Record<string, unknown>)?.reasoningContent as string | undefined;

    const reasoning = reasoningFromAdditionalKwargs || reasoningFromMetadata || reasoningFromCamelCase || null;

    result.success = true;
    result.hasReasoning = reasoning !== null;
    result.reasoningContent = reasoning;
    result.responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    result.responseMetadata = response.response_metadata;
    result.additionalKwargs = response.additional_kwargs;

    console.log('\n✓ 测试成功');
    console.log('是否包含思考内容:', result.hasReasoning);
    if (result.hasReasoning) {
      console.log('思考内容长度:', reasoning?.length);
      console.log('思考内容预览:', reasoning?.slice(0, 200));
    }

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error('✗ 测试失败:', result.error);
  }

  return result;
}

/**
 * 测试 llama.cpp - Qwen3.5
 */
async function testLlamaCppQwen(): Promise<TestResult> {
  console.log('\n=== 测试 2: llama.cpp Qwen3.5-4B ===\n');

  const result: TestResult = {
    provider: 'llama_cpp',
    modelId: 'Qwen3.5-4B-UD-Q5_K_XL.gguf',
    success: false,
    hasReasoning: false,
    reasoningContent: null,
    responseContent: '',
    error: null
  };

  try {
    // llama.cpp 默认运行在本地 8081 端口
    const baseURL = process.env.LLAMA_CPP_BASE_URL || 'http://127.0.0.1:8081/v1';

    // 创建模型实例
    const model = new ChatOpenAI({
      model: 'Qwen3.5-4B-UD-Q5_K_XL.gguf',
      apiKey: 'not-needed', // llama.cpp 本地不需要 API key
      configuration: {
        baseURL,
        fetch: async (input, init) => {
          // 移除 Authorization header
          const headers = new Headers(init?.headers);
          headers.delete('authorization');
          headers.delete('Authorization');
          return fetch(input, { ...init, headers });
        }
      },
      streaming: false,
      // llama.cpp 的模型特定参数
      modelKwargs: {
        cache_prompt: true
      }
    });

    console.log('发送请求到:', baseURL);
    const response = await model.invoke(TEST_PROMPT);

    console.log('响应类型:', typeof response);
    console.log('响应内容:', response.content);
    console.log('additional_kwargs:', JSON.stringify(response.additional_kwargs, null, 2));
    console.log('response_metadata:', JSON.stringify(response.response_metadata, null, 2));

    // 检查思考内容
    const reasoningFromAdditionalKwargs =
      (response.additional_kwargs as Record<string, unknown>)?.reasoning_content as string | undefined;
    const reasoningFromMetadata =
      (response.response_metadata as Record<string, unknown>)?.reasoning_content as string | undefined;

    const reasoning = reasoningFromAdditionalKwargs || reasoningFromMetadata || null;

    result.success = true;
    result.hasReasoning = reasoning !== null;
    result.reasoningContent = reasoning;
    result.responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    result.responseMetadata = response.response_metadata;
    result.additionalKwargs = response.additional_kwargs;

    console.log('\n✓ 测试成功');
    console.log('是否包含思考内容:', result.hasReasoning);
    if (result.hasReasoning) {
      console.log('思考内容长度:', reasoning?.length);
      console.log('思考内容预览:', reasoning?.slice(0, 200));
    }

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error('✗ 测试失败:', result.error);
  }

  return result;
}

/**
 * 测试 OpenAI 兼容 - 统一 modelKwargs 配置
 */
async function testOpenAiCompatibleModelKwargs(): Promise<TestResult> {
  console.log('\n=== 测试 3: OpenAI-compatible modelKwargs ===\n');

  const modelId = process.env.OPENAI_COMPAT_MODEL ?? 'thinking-compatible-model';

  const result: TestResult = {
    provider: 'openai_compatible',
    modelId,
    success: false,
    hasReasoning: false,
    reasoningContent: null,
    responseContent: '',
    error: null
  };

  try {
    // 从环境变量获取配置
    const apiKey = process.env.OPENAI_COMPAT_API_KEY;
    const baseURL = process.env.OPENAI_COMPAT_BASE_URL;

    if (!apiKey) {
      throw new Error('OPENAI_COMPAT_API_KEY 环境变量未设置');
    }
    if (!baseURL) {
      throw new Error('OPENAI_COMPAT_BASE_URL 环境变量未设置');
    }

    // 创建模型实例
    const model = new ChatOpenAI({
      model: modelId,
      apiKey,
      configuration: {
        baseURL
      },
      streaming: false,
      modelKwargs: {
        chat_template_kwargs: {
          enable_thinking: true
        }
      }
    });

    console.log('发送请求到:', baseURL);
    const response = await model.invoke(TEST_PROMPT);

    console.log('响应类型:', typeof response);
    console.log('响应内容:', response.content);
    console.log('additional_kwargs:', JSON.stringify(response.additional_kwargs, null, 2));
    console.log('response_metadata:', JSON.stringify(response.response_metadata, null, 2));

    // 检查思考内容
    const reasoningFromAdditionalKwargs =
      (response.additional_kwargs as Record<string, unknown>)?.reasoning_content as string | undefined;
    const reasoningFromMetadata =
      (response.response_metadata as Record<string, unknown>)?.reasoning_content as string | undefined;
    const reasoningFromCamelCase =
      (response.additional_kwargs as Record<string, unknown>)?.reasoningContent as string | undefined;

    const reasoning = reasoningFromAdditionalKwargs || reasoningFromMetadata || reasoningFromCamelCase || null;

    result.success = true;
    result.hasReasoning = reasoning !== null;
    result.reasoningContent = reasoning;
    result.responseContent = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    result.responseMetadata = response.response_metadata;
    result.additionalKwargs = response.additional_kwargs;

    console.log('\n✓ 测试成功');
    console.log('是否包含思考内容:', result.hasReasoning);
    if (result.hasReasoning) {
      console.log('思考内容长度:', reasoning?.length);
      console.log('思考内容预览:', reasoning?.slice(0, 200));
    }

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error('✗ 测试失败:', result.error);
  }

  return result;
}

/**
 * 主测试函数
 */
async function main() {
  console.log('========================================');
  console.log('思考功能测试');
  console.log('========================================');

  const results: TestResult[] = [];

  // 执行三个测试
  results.push(await testNvidiaKimi());
  results.push(await testLlamaCppQwen());
  results.push(await testOpenAiCompatibleModelKwargs());

  // 输出汇总报告
  console.log('\n\n========================================');
  console.log('测试结果汇总');
  console.log('========================================\n');

  results.forEach((result, index) => {
    console.log(`测试 ${index + 1}: ${result.provider} - ${result.modelId}`);
    console.log(`  状态: ${result.success ? '✓ 成功' : '✗ 失败'}`);
    if (result.success) {
      console.log(`  思考功能: ${result.hasReasoning ? '✓ 已启用' : '✗ 未检测到'}`);
      if (result.hasReasoning) {
        console.log(`  思考内容长度: ${result.reasoningContent?.length || 0} 字符`);
      }
    } else {
      console.log(`  错误: ${result.error}`);
    }
    console.log('');
  });

  // 前端渲染分析
  console.log('========================================');
  console.log('前端渲染分析');
  console.log('========================================\n');

  console.log('根据代码分析，前端渲染逻辑：');
  console.log('1. 从 assistant_block reasoning 块累积思考内容');
  console.log('2. 在 ChatMessageRow 组件中渲染为 reasoning block');
  console.log('3. 使用 <details> 元素展示，带折叠功能');
  console.log('4. 标签显示："推理 · N 步"');
  console.log('5. 流式输出时自动展开\n');

  const hasReasoningResults = results.filter(r => r.hasReasoning);
  if (hasReasoningResults.length > 0) {
    console.log('✓ 检测到思考内容的供应商:');
    hasReasoningResults.forEach(r => {
      console.log(`  - ${r.provider} (${r.modelId})`);
    });
  } else {
    console.log('✗ 未检测到任何思考内容');
  }

  console.log('\n建议：');
  console.log('1. 确保供应商正确配置思考参数');
  console.log('2. 检查模型是否原生支持思考功能');
  console.log('3. 验证 API 响应格式是否包含 reasoning_content 字段');
  console.log('4. 在实际应用中测试前端渲染效果');
}

// 执行测试
main().catch(console.error);
