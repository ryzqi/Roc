/**
 * 简单测试 NVIDIA Kimi 的 thinking 功能
 *
 * 运行方法：
 * 1. 确保在 Roc 应用中配置了 NVIDIA 供应商和 Kimi 模型
 * 2. 确保 options.thinking = true
 * 3. 运行此脚本并检查输出
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';

async function testNvidiaKimi() {
  console.log('🔬 测试 NVIDIA Kimi Thinking 功能\n');

  const apiKey = process.env.NVIDIA_API_KEY || 'your-api-key';

  const model = new ChatOpenAI({
    model: 'moonshotai/kimi-k2.6',
    apiKey: apiKey,
    configuration: {
      baseURL: 'https://integrate.api.nvidia.com/v1'
    },
    maxTokens: 500,
    temperature: 0.7,
    modelKwargs: {
      chat_template_kwargs: {
        thinking: true
      }
    }
  });

  console.log('📤 发送请求到 NVIDIA Kimi...');
  console.log('⚙️  配置: chat_template_kwargs = { thinking: true }\n');

  const prompt = '请解释量子纠缠的基本原理。先思考这个问题，然后简洁回答。';
  console.log(`💭 提示: ${prompt}\n`);
  console.log('─'.repeat(80));

  try {
    let chunkIndex = 0;
    const stream = await model.stream([new HumanMessage(prompt)]);

    for await (const chunk of stream) {
      chunkIndex++;

      console.log(`\n📦 Chunk ${chunkIndex}:`);

      // 打印完整的 chunk 结构
      console.log('  content:', JSON.stringify(chunk.content, null, 2));

      // 检查 additional_kwargs
      if (chunk.additional_kwargs) {
        console.log('  additional_kwargs:', JSON.stringify(chunk.additional_kwargs, null, 2));
      }

      // 检查 response_metadata
      if (chunk.response_metadata) {
        console.log('  response_metadata:', JSON.stringify(chunk.response_metadata, null, 2));
      }

      // 检查是否有 reasoning_content
      const additionalKwargs = chunk.additional_kwargs as Record<string, unknown> | undefined;
      if (additionalKwargs?.reasoning_content) {
        console.log('\n🧠 ✅ 发现 reasoning_content!');
        console.log('   内容:', additionalKwargs.reasoning_content);
      }

      if (additionalKwargs?.reasoningContent) {
        console.log('\n🧠 ✅ 发现 reasoningContent (驼峰)!');
        console.log('   内容:', additionalKwargs.reasoningContent);
      }

      // 检查 contentBlocks
      if (Array.isArray(chunk.content)) {
        for (const block of chunk.content) {
          if (typeof block === 'object' && block !== null) {
            const contentBlock = block as { type?: string; reasoning?: string };
            if (contentBlock.type === 'reasoning') {
              console.log('\n🧠 ✅ 发现 reasoning contentBlock!');
              console.log('   内容:', contentBlock.reasoning);
            }
          }
        }
      }
    }

    console.log('\n' + '─'.repeat(80));
    console.log('✅ 测试完成');

  } catch (error) {
    console.error('\n❌ 错误:', error);
    if (error instanceof Error) {
      console.error('   消息:', error.message);
      console.error('   堆栈:', error.stack);
    }
  }
}

// 直接测试原始 API
async function testRawApi() {
  console.log('\n\n🔬 直接测试 NVIDIA API (原始 fetch)\n');

  const apiKey = process.env.NVIDIA_API_KEY || 'your-api-key';

  const requestBody = {
    model: 'moonshotai/kimi-k2.6',
    messages: [
      {
        role: 'user',
        content: '请解释量子纠缠。先思考，再回答。'
      }
    ],
    stream: true,
    max_tokens: 500,
    temperature: 0.7,
    chat_template_kwargs: {
      thinking: true
    }
  };

  console.log('📤 请求体:', JSON.stringify(requestBody, null, 2));
  console.log('\n─'.repeat(80));

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let chunkIndex = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            chunkIndex++;

            console.log(`\n📦 SSE Chunk ${chunkIndex}:`);
            console.log(JSON.stringify(parsed, null, 2));

            // 检查 choices[0].delta
            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
              if (delta.reasoning_content) {
                console.log('\n🧠 ✅ 发现 delta.reasoning_content!');
                console.log('   内容:', delta.reasoning_content);
              }
              if (delta.content) {
                console.log('💬 内容:', delta.content);
              }
            }

          } catch (e) {
            console.error('解析错误:', e);
          }
        }
      }
    }

    console.log('\n' + '─'.repeat(80));
    console.log('✅ 原始 API 测试完成');

  } catch (error) {
    console.error('\n❌ 错误:', error);
  }
}

async function main() {
  console.log('=' .repeat(80));
  console.log('NVIDIA Kimi Thinking 功能测试');
  console.log('=' .repeat(80));

  // 首先测试 LangChain
  await testNvidiaKimi();

  // 然后测试原始 API（如果需要对比）
  if (process.env.TEST_RAW_API === 'true') {
    await testRawApi();
  } else {
    console.log('\n💡 提示: 设置 TEST_RAW_API=true 来测试原始 API');
  }
}

main().catch(console.error);
