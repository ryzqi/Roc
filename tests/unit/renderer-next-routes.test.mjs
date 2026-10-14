import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Round-trip guard for the renderer-next URL contract (ADR-M05).
 *
 * `routes.ts` is TypeScript with extension-less relative imports, so it is
 * bundled with esbuild (already a devDependency) before import. No new test
 * framework is introduced; `node --test` is enough.
 *
 * Why this exists: the legacy shell made `view=changes` implicit while its
 * parser defaulted to `changes`, and the new shell initially inherited the
 * implicit write while defaulting to `overview`. That pair silently rewrote
 * `changes -> overview` on every reload and orphaned `tool=git`. The invariant
 * enforced here is the one that failure violated.
 */

let routes;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-routes-'));
  const outfile = join(tempDir, 'routes.mjs');
  await esbuild.build({
    entryPoints: ['src/renderer-next/app/routes.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    logLevel: 'silent'
  });
  routes = await import(outfile);
});

after(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const ALL_VIEWS = [
  'overview',
  'stage',
  'activity',
  'provenance',
  'changes',
  'literature',
  'latex',
  'terminal',
  'files',
  'tasks',
  'diagnostics',
  'mcp',
  'skills',
  'memory'
];

const ALL_TOOLS = [null, 'files', 'git', 'terminal'];
/** Only meaningful for `view=files`; the normaliser must drop it everywhere else. */
const ALL_OPEN_FILES = [null, 'src/a.ts', '目录/含 空格.md'];
const STAGE_GROUPS = ['discover', 'plan', 'experiment', 'write', 'publish', 'settings'];
const STAGE_TABS = [
  'library',
  'knowledge',
  'ideas',
  'policies',
  'experiments',
  'figures',
  'manuscript',
  'editor',
  'production',
  'embedding'
];

/** Every route the app can actually construct: normalised inputs only. */
function* allRoutes() {
  for (const page of ['research', 'settings']) {
    for (const projectId of [null, 'p1']) {
      for (const view of ALL_VIEWS) {
        for (const stageGroup of STAGE_GROUPS) {
          for (const stageTab of STAGE_TABS) {
            for (const tool of ALL_TOOLS) {
              for (const openFile of ALL_OPEN_FILES) {
                for (const assistantOpen of [false, true]) {
                  for (const newProject of [false, true]) {
                    yield routes.normalizeAppRoute({
                      page,
                      projectId,
                      view,
                      stageGroup,
                      stageTab,
                      tool,
                      openFile,
                      assistantOpen,
                      newProject
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

function toSearch(route) {
  return new URLSearchParams(routes.appRouteToSearch(route));
}

test('parse(write(route)) preserves every field of a normalised route', () => {
  const failures = [];
  let checked = 0;
  for (const route of allRoutes()) {
    checked += 1;
    const reparsed = routes.parseAppRoute(toSearch(route));
    if (!routes.sameAppRoute(route, reparsed)) {
      failures.push({ route, reparsed });
    }
  }
  assert.equal(failures.length, 0, `round-trip failures: ${JSON.stringify(failures.slice(0, 3), null, 2)}`);
  assert.ok(checked > 10_000, `expected a broad sweep, checked only ${checked}`);
});

test('normalizeAppRoute is idempotent', () => {
  for (const route of allRoutes()) {
    assert.deepEqual(routes.normalizeAppRoute(routes.normalizeAppRoute(route)), route);
  }
});

test('view=changes survives with its tool (the regression that motivated this guard)', () => {
  const gitIntent = routes.routeForNavigate('git', {
    page: 'research',
    projectId: 'p1',
    view: 'overview',
    stageGroup: 'discover',
    stageTab: 'library',
    tool: null,
    openFile: null,
    assistantOpen: false,
    newProject: false
  });
  const reparsed = routes.parseAppRoute(toSearch(gitIntent));
  assert.equal(reparsed.view, 'changes');
  assert.equal(reparsed.tool, 'git');
  assert.ok(routes.sameAppRoute(gitIntent, reparsed));
});

test('menu navigate payloads from the native menu always land somewhere reachable', () => {
  // src/main/application-menu.ts and macos-host-service.ts emit exactly these.
  const base = routes.parseAppRoute(new URLSearchParams('page=research&project=p1'));
  for (const payload of ['settings', 'research-new', 'chat', 'tasks']) {
    const next = routes.routeForNavigate(payload, base);
    assert.ok(routes.sameAppRoute(next, routes.parseAppRoute(toSearch(next))), payload);
  }
});

test('no project means the portal: no view, tool, assistant or stage leaks into the URL', () => {
  const search = toSearch({
    page: 'research',
    projectId: null,
    view: 'memory',
    stageGroup: 'settings',
    stageTab: 'policies',
    tool: 'git',
    openFile: 'a.md',
    assistantOpen: true,
    newProject: false
  });
  assert.equal(search.get('view'), null);
  assert.equal(search.get('tool'), null);
  assert.equal(search.get('file'), null);
  assert.equal(search.get('assistant'), null);
  assert.equal(search.get('stage'), null);
  assert.equal(search.get('project'), null);
});

test('a missing view defaults to overview, not the legacy changes', () => {
  assert.equal(routes.parseAppRoute(new URLSearchParams('page=research&project=p1')).view, 'overview');
});

test('stage is only written for view=stage', () => {
  const withStage = routes.parseAppRoute(new URLSearchParams('page=research&project=p1&stage=write&view=overview'));
  assert.equal(withStage.view, 'overview');
  assert.equal(withStage.stageGroup, 'discover');
  assert.equal(toSearch(withStage).get('stage'), null);
});

test('file survives only in the files view, and round-trips through the URL', () => {
  const deepLink = routes.parseAppRoute(
    new URLSearchParams('page=research&project=p1&view=files&tool=files&file=a%20b/%E7%9B%AE.md')
  );
  assert.equal(deepLink.openFile, 'a b/目.md');
  assert.equal(toSearch(deepLink).get('file'), 'a b/目.md');
  assert.ok(routes.sameAppRoute(deepLink, routes.parseAppRoute(toSearch(deepLink))));

  const elsewhere = routes.parseAppRoute(new URLSearchParams('page=research&project=p1&view=terminal&file=a.md'));
  assert.equal(elsewhere.openFile, null);
  assert.equal(toSearch(elsewhere).get('file'), null);

  const blank = routes.parseAppRoute(new URLSearchParams('page=research&project=p1&view=files&file=%20%20'));
  assert.equal(blank.openFile, null);
});
