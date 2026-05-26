import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { tsImport } from 'tsx/esm/api';

const defaultRuns = 30;
const endpoint = readEnv('ROC_TASK_PROBE_ENDPOINT');
const apiKey = readEnv('ROC_TASK_PROBE_API_KEY');
const model = readEnv('ROC_TASK_PROBE_MODEL');
const workspacePath = readEnv('ROC_TASK_PROBE_WORKSPACE') ?? process.cwd();
const runs = readRuns(process.argv);
const { buildTaskProposalPrompt, PROPOSE_TOOL_DESCRIPTION, PROPOSE_TOOL_NAME } = await tsImport(
  '../src/shared/background-task-tool-contract.ts',
  import.meta.url
);
const { proposeInputSchema } = await tsImport('../src/main/services/deep-agent/background-task-tools.ts', import.meta.url);

if (endpoint === null || apiKey === null || model === null) {
  console.log(
    JSON.stringify(
      {
        status: 'skipped',
        reason: 'missing ROC_TASK_PROBE_ENDPOINT, ROC_TASK_PROBE_API_KEY, or ROC_TASK_PROBE_MODEL',
        runs: 0,
        failures: 0,
        failureBySchemaPath: {}
      },
      null,
      2
    )
  );
  process.exit(0);
}

const proposeTool = tool(async (input) => JSON.stringify({ ok: true, input }), {
  name: PROPOSE_TOOL_NAME,
  description: PROPOSE_TOOL_DESCRIPTION,
  schema: proposeInputSchema
});

const modelWithTools = new ChatOpenAI({
  model,
  apiKey,
  configuration: {
    baseURL: endpoint.replace(/\/+$/u, '')
  },
  maxRetries: 0,
  streaming: false,
  temperature: 0,
  timeout: 60_000
}).bindTools([proposeTool]);

const failures = [];
for (let index = 0; index < runs; index += 1) {
  const prompt = buildPrompt(workspacePath, index);
  try {
    const response = await modelWithTools.invoke(prompt);
    const toolCalls = Array.isArray(response.tool_calls) ? response.tool_calls : [];
    const call = toolCalls.find((item) => item.name === PROPOSE_TOOL_NAME);
    if (call === undefined) {
      failures.push({ index, schemaPath: 'tool_call', message: 'missing propose_background_task tool call' });
      continue;
    }
    const parsed = proposeInputSchema.safeParse(call.args);
    if (!parsed.success) {
      const schemaPath = parsed.error.issues[0]?.path.map(String).join('.') || 'root';
      failures.push({ index, schemaPath, message: parsed.error.message });
    }
  } catch (error) {
    failures.push({
      index,
      schemaPath: readSchemaPath(error) ?? 'provider',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

const failureBySchemaPath = failures.reduce((accumulator, failure) => {
  accumulator[failure.schemaPath] = (accumulator[failure.schemaPath] ?? 0) + 1;
  return accumulator;
}, {});

console.log(
  JSON.stringify(
    {
      status: 'completed',
      runs,
      failures: failures.length,
      failureBySchemaPath,
      samples: failures.slice(0, 5)
    },
    null,
    2
  )
);

function readRuns(argv) {
  const index = argv.indexOf('--runs');
  if (index === -1) {
    return defaultRuns;
  }
  const value = argv[index + 1];
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new Error('--runs must be an integer from 1 to 200.');
  }
  return parsed;
}

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function buildPrompt(currentWorkspacePath, index) {
  return buildTaskProposalPrompt({
    description: `第 ${index + 1} 次采样：每天 21:50 抓取 AI 最新新闻并写入当前工作区的 docx 文件。`,
    workspacePath: currentWorkspacePath
  });
}

function readSchemaPath(error) {
  if (!(error instanceof Error)) {
    return null;
  }
  const match = /\bat\s+([A-Za-z0-9_.]+)\b/u.exec(error.message);
  return match?.[1] ?? null;
}
