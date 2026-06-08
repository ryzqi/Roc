/**
 * Thinking 功能综合诊断工具
 *
 * 这个脚本会：
 * 1. 检查供应商配置
 * 2. 测试 LangChain 模型创建
 * 3. 发送真实请求
 * 4. 分析响应中的 reasoning 字段
 * 5. 生成诊断报告
 *
 * 使用方法：
 *   pnpm tsx tests/manual/diagnose-thinking.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { createAppServices } from '../../src/main/services/app-service';
import type { ProviderConfig } from '../../src/shared/types';

interface DiagnosticResult {
  provider: string;
  modelId: string;
  configValid: boolean;
  modelCreated: boolean;
  requestSent: boolean;
  chunksReceived: number;
  reasoningFound: boolean;
  reasoningLocation: string | null;
  reasoningContent: string | null;
  responseContent: string;
  errors: string[];
  warnings: string[];
  rawChunkSamples: unknown[];
}

async function diagnoseProvider(
  services: ReturnType<typeof createAppServices>,
  providerConfig: ProviderConfig,
  modelId: string
): Promise<DiagnosticResult> {
  const result: DiagnosticResult = {
    provider: providerConfig.name,
    modelId,
    configValid: false,
    modelCreated: false,
    requestSent: false,
    chunksReceived: 0,
    reasoningFound: false,
    reasoningLocation: null,
    reasoningContent: null,
    responseContent: '',
    errors: [],
    warnings: [],
    rawChunkSamples: []
  };

  try {
    // 步骤 1: 保存配置
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📋 诊断供应商: ${providerConfig.name} (${providerConfig.type})`);
    console.log(`📦 模型: ${modelId}`);
    console.log(`${'='.repeat(80)}\n`);

    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: modelId,
      providers: [providerConfig]
    });

    // 设置测试凭据
    if (providerConfig.credentialRef?.startsWith('secret:')) {
      const secretKey = providerConfig.credentialRef.replace('secret:', '');
      services.secretService.setProviderSecret(secretKey, 'test-credential');
    }

    result.configValid = true;
    console.log('✅ 配置已保存\n');

    // 打印配置详情
    console.log('⚙️  供应商配置:');
    console.log(`   类型: ${providerConfig.type}`);
    console.log(`   端点: ${providerConfig.endpoint}`);
    if (providerConfig.options) {
      console.log(`   选项: ${JSON.stringify(providerConfig.options, null, 6)}`);
    }

    // 步骤 2: 创建模型
    console.log('\n🔧 创建 LangChain 模型...');
    const factory = services.langChainModelFactory;
    const handle = await factory.createDefaultChatModel({ streaming: true });

    result.modelCreated = true;
    console.log('✅ 模型创建成功\n');

    // 打印模型运行时信息
    console.log('🔍 模型运行时信息:');
    console.log(`   Provider Type: ${handle.runtime.providerType}`);
    console.log(`   Base URL: ${handle.runtime.baseUrl}`);
    console.log(`   Streaming: ${handle.runtime.streaming}`);
    if (handle.runtime.modelKwargs && Object.keys(handle.runtime.modelKwargs).length > 0) {
      console.log(`   Model Kwargs: ${JSON.stringify(handle.runtime.modelKwargs, null, 6)}`);
    } else {
      result.warnings.push('modelKwargs 为空 - 可能没有启用 thinking');
    }

    // 步骤 3: 发送测试请求
    const testPrompt = '请简要解释量子叠加原理。先思考，再回答。';
    console.log(`\n💭 发送测试提示: "${testPrompt}"\n`);
    console.log('📥 开始接收流式响应...\n');
    console.log('─'.repeat(80));

    const stream = await handle.model.stream([new HumanMessage(testPrompt)]);
    result.requestSent = true;

    for await (const chunk of stream) {
      result.chunksReceived++;

      // 保存前 5 个 chunk 样本
      if (result.rawChunkSamples.length < 5) {
        result.rawChunkSamples.push({
          index: result.chunksReceived,
          content: chunk.content,
          additional_kwargs: chunk.additional_kwargs,
          response_metadata: (chunk as { response_metadata?: unknown }).response_metadata
        });
      }

      // 检查 content（字符串形式）
      if (typeof chunk.content === 'string' && chunk.content.length > 0) {
        process.stdout.write(chunk.content);
        result.responseContent += chunk.content;
      }

      // 检查 content（数组形式）
      if (Array.isArray(chunk.content)) {
        for (const block of chunk.content) {
          if (typeof block === 'object' && block !== null) {
            const contentBlock = block as { type?: string; reasoning?: string; text?: string };

            if (contentBlock.type === 'reasoning' && contentBlock.reasoning) {
              if (!result.reasoningFound) {
                console.log('\n\n🧠 ✅ 发现 reasoning contentBlock!');
                result.reasoningFound = true;
                result.reasoningLocation = 'content[].reasoning';
              }
              result.reasoningContent = (result.reasoningContent || '') + contentBlock.reasoning;
              console.log(`   推理内容: ${contentBlock.reasoning.slice(0, 100)}${contentBlock.reasoning.length > 100 ? '...' : ''}`);
            } else if (contentBlock.type === 'text' && contentBlock.text) {
              process.stdout.write(contentBlock.text);
              result.responseContent += contentBlock.text;
            }
          }
        }
      }

      // 检查 additional_kwargs.reasoning_content
      const additionalKwargs = chunk.additional_kwargs as Record<string, unknown> | undefined;
      if (additionalKwargs?.reasoning_content && typeof additionalKwargs.reasoning_content === 'string') {
        if (!result.reasoningFound) {
          console.log('\n\n🧠 ✅ 发现 additional_kwargs.reasoning_content!');
          result.reasoningFound = true;
          result.reasoningLocation = 'additional_kwargs.reasoning_content';
        }
        result.reasoningContent = (result.reasoningContent || '') + additionalKwargs.reasoning_content;
        console.log(`   推理内容: ${additionalKwargs.reasoning_content.slice(0, 100)}...`);
      }

      // 检查 additional_kwargs.reasoningContent (驼峰)
      if (additionalKwargs?.reasoningContent && typeof additionalKwargs.reasoningContent === 'string') {
        if (!result.reasoningFound) {
          console.log('\n\n🧠 ✅ 发现 additional_kwargs.reasoningContent (驼峰)!');
          result.reasoningFound = true;
          result.reasoningLocation = 'additional_kwargs.reasoningContent';
        }
        result.reasoningContent = (result.reasoningContent || '') + additionalKwargs.reasoningContent;
        console.log(`   推理内容: ${additionalKwargs.reasoningContent.slice(0, 100)}...`);
      }

      // 检查 response_metadata.reasoning_content
      const responseMetadata = (chunk as { response_metadata?: Record<string, unknown> }).response_metadata;
      if (responseMetadata?.reasoning_content && typeof responseMetadata.reasoning_content === 'string') {
        if (!result.reasoningFound) {
          console.log('\n\n🧠 ✅ 发现 response_metadata.reasoning_content!');
          result.reasoningFound = true;
          result.reasoningLocation = 'response_metadata.reasoning_content';
        }
        result.reasoningContent = (result.reasoningContent || '') + responseMetadata.reasoning_content;
        console.log(`   推理内容: ${responseMetadata.reasoning_content.slice(0, 100)}...`);
      }
    }

    console.log('\n' + '─'.repeat(80));
    console.log(`✅ 接收完成 - 共 ${result.chunksReceived} 个 chunk\n`);

  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    console.error('\n❌ 错误:', error);
  }

  return result;
}

function generateReport(results: DiagnosticResult[]): string {
  let report = '# Thinking 功能诊断报告\n\n';
  report += `生成时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
  report += '## 总览\n\n';

  const summary = {
    total: results.length,
    configValid: results.filter(r => r.configValid).length,
    modelCreated: results.filter(r => r.modelCreated).length,
    requestSent: results.filter(r => r.requestSent).length,
    reasoningFound: results.filter(r => r.reasoningFound).length
  };

  report += `- 测试供应商数: ${summary.total}\n`;
  report += `- 配置有效: ${summary.configValid}/${summary.total}\n`;
  report += `- 模型创建成功: ${summary.modelCreated}/${summary.total}\n`;
  report += `- 请求发送成功: ${summary.requestSent}/${summary.total}\n`;
  report += `- **发现推理内容: ${summary.reasoningFound}/${summary.total}**\n\n`;

  report += '## 详细结果\n\n';

  for (const result of results) {
    report += `### ${result.provider} - ${result.modelId}\n\n`;

    report += '**状态检查**:\n';
    report += `- ✅ 配置有效: ${result.configValid ? '是' : '否'}\n`;
    report += `- ✅ 模型创建: ${result.modelCreated ? '是' : '否'}\n`;
    report += `- ✅ 请求发送: ${result.requestSent ? '是' : '否'}\n`;
    report += `- ✅ Chunk 数量: ${result.chunksReceived}\n`;
    report += `- ✅ **推理内容**: ${result.reasoningFound ? '✅ 找到' : '❌ 未找到'}\n\n`;

    if (result.reasoningFound) {
      report += '**推理详情**:\n';
      report += `- 字段位置: \`${result.reasoningLocation}\`\n`;
      report += `- 内容长度: ${result.reasoningContent?.length ?? 0} 字符\n`;
      if (result.reasoningContent) {
        report += `- 内容预览:\n\`\`\`\n${result.reasoningContent.slice(0, 300)}${result.reasoningContent.length > 300 ? '...' : ''}\n\`\`\`\n\n`;
      }
    }

    report += '**响应内容**:\n';
    report += `- 长度: ${result.responseContent.length} 字符\n`;
    if (result.responseContent.length > 0) {
      report += `- 预览:\n\`\`\`\n${result.responseContent.slice(0, 200)}${result.responseContent.length > 200 ? '...' : ''}\n\`\`\`\n\n`;
    }

    if (result.warnings.length > 0) {
      report += '**警告**:\n';
      for (const warning of result.warnings) {
        report += `- ⚠️ ${warning}\n`;
      }
      report += '\n';
    }

    if (result.errors.length > 0) {
      report += '**错误**:\n';
      for (const error of result.errors) {
        report += `- ❌ ${error}\n`;
      }
      report += '\n';
    }

    if (result.rawChunkSamples.length > 0) {
      report += '<details>\n<summary>原始 Chunk 样本 (点击展开)</summary>\n\n';
      report += '```json\n';
      report += JSON.stringify(result.rawChunkSamples, null, 2);
      report += '\n```\n</details>\n\n';
    }

    report += '---\n\n';
  }

  report += '## 结论与建议\n\n';

  if (summary.reasoningFound === 0) {
    report += '### ❌ 问题：所有供应商都未返回推理内容\n\n';
    report += '可能原因:\n';
    report += '1. 供应商配置中未启用 thinking 选项\n';
    report += '2. 模型不支持 reasoning 功能\n';
    report += '3. API 密钥无效或配额不足\n';
    report += '4. 提示词未能触发模型思考\n\n';
    report += '建议:\n';
    report += '1. 检查供应商配置，确保 `options.thinking = true` (NVIDIA)\n';
    report += '2. 检查 modelKwargs 是否包含 `chat_template_kwargs: { thinking: true }`\n';
    report += '3. 使用更明确的提示词，如"请先深入思考这个问题，然后回答"\n';
    report += '4. 查看原始 API 文档确认正确的参数格式\n\n';
  } else if (summary.reasoningFound < summary.total) {
    report += `### ⚠️ 部分成功：${summary.reasoningFound}/${summary.total} 个供应商返回了推理内容\n\n`;
    report += '建议检查未成功的供应商配置和模型支持情况。\n\n';
  } else {
    report += '### ✅ 成功：所有供应商都返回了推理内容\n\n';
    report += '如果前端仍未显示，请检查:\n';
    report += '1. 前端是否正确接收 `reasoning_delta` 事件\n';
    report += '2. `chat-transcript.ts` 中的 `appendReasoningBlock` 是否被调用\n';
    report += '3. `chat-message-row.tsx` 中的 `ChatActivityBlockView` 组件是否正确渲染\n';
    report += '4. 浏览器控制台是否有错误信息\n\n';
  }

  return report;
}

async function main() {
  console.log('\n🔬 Thinking 功能综合诊断工具');
  console.log('='.repeat(80));

  const root = mkdtempSync(join(tmpdir(), 'roc-thinking-diagnose-'));
  const services = createAppServices(root);
  await services.appService.initialize();

  const results: DiagnosticResult[] = [];

  try {
    // 测试 1: NVIDIA Kimi
    const nvidiaResult = await diagnoseProvider(
      services,
      {
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
          thinking: true,
          maxTokens: 300
        }
      },
      'moonshotai/kimi-k2.6'
    );
    results.push(nvidiaResult);

    // 测试 2: llama.cpp (如果需要)
    // const llamaCppResult = await diagnoseProvider(...);
    // results.push(llamaCppResult);

    // 生成报告
    console.log('\n\n' + '='.repeat(80));
    console.log('📝 生成诊断报告...\n');

    const report = generateReport(results);
    const reportPath = join(root, 'thinking-diagnostic-report.md');
    writeFileSync(reportPath, report, 'utf-8');

    console.log(`✅ 报告已保存到: ${reportPath}\n`);
    console.log('报告预览:\n');
    console.log(report);

  } finally {
    await services.appService.shutdown();
    // 保留临时目录以便查看报告
    console.log(`\n💡 临时目录: ${root}`);
    console.log('   诊断完成后可以手动删除此目录\n');
  }
}

main().catch(console.error);
