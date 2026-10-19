import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Round-trip guard for the renderer URL contract (ADR-M05).
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
    entryPoints: ['src/renderer/app/routes.ts'],
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
  'literature',
  'latex',
  'terminal',
  'mcp',
  'skills',
  'memory'
];

// `terminal` left the tool union: the terminal is a canvas tab, so `view=terminal` is what
// selects it (a separate sticky marker could not also mean “close the Git drawer”).
const ALL_TOOLS = [null, 'files', 'git'];
/**
 * `?file=` no longer names a view — the canvas `files` view is gone and the sidebar tree reads the
 * parameter — so every view drops it. The sweep still varies it, because “dropped everywhere” is
 * the invariant now.
 */
const ALL_OPEN_FILES = [null, 'src/a.ts', '目录/含 空格.md'];

/** Every route the app can actually construct: normalised inputs only. */
function* allRoutes() {
  for (const page of ['research', 'settings']) {
    for (const projectId of [null, 'p1']) {
      for (const view of ALL_VIEWS) {
        for (const tool of ALL_TOOLS) {
          for (const openFile of ALL_OPEN_FILES) {
            for (const assistantOpen of [false, true]) {
              for (const newProject of [false, true]) {
                yield routes.normalizeAppRoute({
                  page,
                  projectId,
                  view,
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
  // 2 pages × 2 projects × 6 views × 3 tools × 3 open files × 2 × 2 = 864. The sweep used to be an
  // order of magnitude wider: the stage-group dimension left with the stage surface, `tasks` with
  // the task board, and `terminal` with the tool union.
  assert.ok(checked > 800, `expected a broad sweep, checked only ${checked}`);
});

test('normalizeAppRoute is idempotent', () => {
  for (const route of allRoutes()) {
    assert.deepEqual(routes.normalizeAppRoute(routes.normalizeAppRoute(route)), route);
  }
});

test('the native menu\'s Git item selects the drawer, not a view', () => {
  // This guard started as “view=changes survives with its tool” after the legacy shell dropped the
  // parameter. The wide change view is gone (the reference has one Git surface, a drawer), so what
  // it protects now is that the menu item still reaches Git: `?tool=git` must survive the
  // round-trip while the view stays untouched.
  const gitIntent = routes.routeForNavigate('git', {
    page: 'research',
    projectId: 'p1',
    view: 'literature',
    tool: null,
    openFile: null,
    assistantOpen: false,
    newProject: false
  });
  const reparsed = routes.parseAppRoute(toSearch(gitIntent));
  assert.equal(reparsed.view, 'literature');
  assert.equal(reparsed.tool, 'git');
  assert.ok(routes.sameAppRoute(gitIntent, reparsed));
});

test('the files menu item also selects a drawer, and keeps the view', () => {
  const base = routes.parseAppRoute(new URLSearchParams('page=research&project=p1'));
  const next = routes.routeForNavigate('files', base);
  assert.equal(next.tool, 'files');
  // The view is whatever it already was — a drawer is not a page. This pin read `view === 'changes'`
  // for Git before; now both entries must leave the canvas alone.
  assert.equal(next.view, 'literature');
  assert.ok(routes.sameAppRoute(next, routes.parseAppRoute(toSearch(next))));
});

test('menu navigate payloads from the native menu always land somewhere reachable', () => {
  // src/main/application-menu.ts and macos-host-service.ts emit exactly these.
  const base = routes.parseAppRoute(new URLSearchParams('page=research&project=p1'));
  for (const payload of ['settings', 'research-new', 'chat', 'tasks', 'workspace', 'git', 'terminal']) {
    const next = routes.routeForNavigate(payload, base);
    assert.ok(routes.sameAppRoute(next, routes.parseAppRoute(toSearch(next))), payload);
  }
});

test('no project means the portal: no view, tool, file or assistant leaks into the URL', () => {
  const search = toSearch({
    page: 'research',
    projectId: null,
    view: 'memory',
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

// 注：“无项目时 tool 被清掉”这条断言仍然在守：portal 态的顶栏根本没有 Git/文件抽屉可开。

test('a tool survives on any view, because it selects a drawer', () => {
  // This is the opposite of the old rule (“tools belong to files/changes/terminal”). Git and files
  // are drawers now, so `?tool=git` has to survive next to whatever canvas view is on screen — that
  // is exactly how the reference behaves (顶栏 Git 抽屉盖在画布上).
  const withGit = routes.parseAppRoute(new URLSearchParams('page=research&project=p1&view=latex&tool=git'));
  assert.equal(withGit.view, 'latex');
  assert.equal(withGit.tool, 'git');
  assert.equal(toSearch(withGit).get('tool'), 'git');
  assert.ok(routes.sameAppRoute(withGit, routes.parseAppRoute(toSearch(withGit))));
});

test('a missing view defaults to latex, which is the reference canvas default', () => {
  assert.equal(routes.parseAppRoute(new URLSearchParams('page=research&project=p1')).view, 'latex');
});

test('an incoming ?stage= is ignored, never read and never re-written', () => {
  // The stage surface is gone but the parameter is still tolerated: the native menu and any stale
  // deep link keep working, and the URL is cleaned up on the next normalise rather than breaking.
  const withStage = routes.parseAppRoute(new URLSearchParams('page=research&project=p1&stage=write&view=literature'));
  assert.equal(withStage.view, 'literature');
  assert.equal(toSearch(withStage).get('stage'), null);
});

test('a retired view id falls back instead of leaking into the URL', () => {
  // Everything except the reference's three canvas tabs and the three management views has been
  // retired (`overview`/`stage`/`activity`/`provenance`/`diagnostics` with the stage surface,
  // `tasks` with the task board, `files`/`changes` with the view-to-drawer move). A bookmark to any
  // of them must land somewhere real rather than render nothing.
  const retired = ['overview', 'stage', 'activity', 'provenance', 'diagnostics', 'tasks', 'files', 'changes'];
  for (const id of retired) {
    const parsed = routes.parseAppRoute(new URLSearchParams(`page=research&project=p1&view=${id}`));
    assert.equal(parsed.view, routes.DEFAULT_VIEW, id);
  }
});

test('the native menu\'s task item stays reachable now that the board is gone', () => {
  const base = routes.parseAppRoute(new URLSearchParams('page=research&project=p1'));
  const next = routes.routeForNavigate('tasks', base);
  // The drawer opens from the shell, not from the URL, so what the route has to prove is that the
  // item does not send the user to a view that no longer exists.
  assert.equal(next.view, routes.DEFAULT_VIEW);
  assert.ok(!routes.APP_VIEW_IDS.has('tasks'));
});

test('?file= is carried but names no view', () => {
  // It is what the sidebar tree reveals and selects, so it must survive the URL round-trip...
  const deepLink = routes.parseAppRoute(
    new URLSearchParams('page=research&project=p1&view=literature&file=a%20b/%E7%9B%AE.md')
  );
  assert.equal(deepLink.openFile, 'a b/目.md');
  assert.equal(toSearch(deepLink).get('file'), 'a b/目.md');
  assert.ok(routes.sameAppRoute(deepLink, routes.parseAppRoute(toSearch(deepLink))));

  // ...and it must not drag a view along: the canvas `files` host is gone.
  const viaFiles = routes.parseAppRoute(new URLSearchParams('page=research&project=p1&view=files&file=a.md'));
  assert.equal(viaFiles.view, routes.DEFAULT_VIEW);
  assert.equal(viaFiles.openFile, 'a.md');

  // Blank is nothing, not a path of spaces.
  const blank = routes.parseAppRoute(new URLSearchParams('page=research&project=p1&file=%20%20'));
  assert.equal(blank.openFile, null);
});
