import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function createSmokePaths() {
  return {
    dataRoot: await mkdtemp(join(tmpdir(), 'roc-smoke-')),
    workspaceRoot: await mkdtemp(join(tmpdir(), 'roc-smoke-workspace-')),
    skillSourceRoot: await mkdtemp(join(tmpdir(), 'roc-smoke-skill-')),
    remoteRoot: await mkdtemp(join(tmpdir(), 'roc-smoke-remote-'))
  };
}

export function buildSmokeContent(label, lines = 1) {
  return Array.from({ length: lines }, (_, index) => `${label} ${index + 1}`).join('\n') + '\n';
}

export function runWorkspaceGit(workspaceRoot, args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

export function seedSmokeWorkspace(workspaceRoot, remoteRoot) {
  mkdirSync(join(workspaceRoot, 'assets'));
  writeFileSync(join(workspaceRoot, '00-overview.txt'), 'workspace overview smoke file\n', 'utf8');
  writeFileSync(join(workspaceRoot, 'phase-three-notes.txt'), 'phase three smoke workspace\n', 'utf8');
  writeFileSync(join(workspaceRoot, 'batch-stage.txt'), 'batch stage smoke workspace\n', 'utf8');
  writeFileSync(
    join(workspaceRoot, 'assets', 'smoke-image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=',
      'base64'
    )
  );
  runWorkspaceGit(workspaceRoot, ['init']);
  runWorkspaceGit(workspaceRoot, ['config', 'user.email', 'roc-smoke@example.test']);
  runWorkspaceGit(workspaceRoot, ['config', 'user.name', 'Roc Smoke']);
  runWorkspaceGit(workspaceRoot, ['add', '00-overview.txt', 'phase-three-notes.txt', 'batch-stage.txt', 'assets/smoke-image.png']);
  runWorkspaceGit(workspaceRoot, ['commit', '-m', 'initial smoke workspace']);
  writeFileSync(
    join(workspaceRoot, 'phase-three-notes.txt'),
    `phase three smoke workspace\n${buildSmokeContent('changed in git line', 80)}`,
    'utf8'
  );
  writeFileSync(join(workspaceRoot, 'batch-stage.txt'), buildSmokeContent('changed in batch line', 32), 'utf8');
  runWorkspaceGit(workspaceRoot, ['init', '--bare', remoteRoot]);
  runWorkspaceGit(workspaceRoot, ['remote', 'add', 'origin', remoteRoot]);
  runWorkspaceGit(workspaceRoot, ['push', '-u', 'origin', 'master']);
}

export function seedSmokeSkillSource(skillSourceRoot) {
  writeFileSync(
    join(skillSourceRoot, 'SKILL.md'),
    '---\nname: smoke-skill\ndescription: Smoke skill validates Phase 5 import.\n---\n\n# Smoke Skill\n',
    'utf8'
  );
}

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('error', rejectBody);
    request.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export async function startSmokeProvider() {
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      const rawBody = await readRequestBody(request);
      const parsedBody = rawBody.length === 0 ? null : JSON.parse(rawBody);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: parsedBody
      });
      if (parsedBody?.stream === true || request.headers.accept === 'text/event-stream') {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream');
        response.setHeader('cache-control', 'no-cache');
        response.setHeader('connection', 'keep-alive');
        response.write(
          'data: {"choices":[{"index":0,"delta":{"content":"Smoke Provider 已生成首轮回复。\\n\\n短行一。\\n短行二。\\n短行三。\\n短行四。\\n短行五。\\n短行六。\\n短行七。\\n短行八。"},"finish_reason":null}]}\n\n'
        );
        response.write(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":16,"completion_tokens":9,"total_tokens":25}}\n\n'
        );
        response.end('data: [DONE]\n\n');
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Smoke Provider 已生成首轮回复。\n\n短行一。\n短行二。\n短行三。\n短行四。\n短行五。\n短行六。\n短行七。\n短行八。'
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 16,
            completion_tokens: 9
          }
        })
      );
    })().catch((error) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'provider failed' }));
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Smoke provider did not expose a TCP address.');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      })
  };
}
