import { spawn } from 'node:child_process';
import electronPath from 'electron';

const child = spawn(electronPath, ['--test', ...process.argv.slice(2), 'tests/integration/research-p0-production.test.mjs'], {
  env: {...process.env, ELECTRON_RUN_AS_NODE: '1', LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false'},
  stdio: 'inherit'
});

const {code, signal} = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({code, signal}));
});
if (signal !== null) throw new Error(`research_p0_runner_terminated:${signal}`);
process.exitCode = code;
