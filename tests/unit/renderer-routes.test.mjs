import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * Round-trip guard for the renderer URL contract.
 *
 * `routes.ts` is TypeScript with extension-less relative imports, so it is bundled before import —
 * `scripts/lib/bundle-ts.mjs` is that helper, shared with the other unit tests instead of the
 * `mkdtempSync` + `rmSync` copy each of them used to carry. No new test framework is introduced;
 * `node --test` is enough.
 *
 * Why this exists: the legacy shell made `view=changes` implicit while its parser defaulted to
 * `changes`, and the new shell initially inherited the implicit write while defaulting to
 * `overview`. That pair silently rewrote `changes -> overview` on every reload and orphaned
 * `tool=git`. The invariant enforced here is the one that failure violated.
 *
 * The native-menu mapping used to be tested here too. It moved: the page set and its meaning live in
 * `src/shared/surfaces.ts` (asserted in `surfaces.test.mjs`), and the part a route can carry is
 * `routeForMenuIntent` below. What remains here is the URL contract itself.
 */

const routes = await importTypeScriptModule('src/renderer/app/routes.ts');
/** Loaded separately because the menu assertions read the table itself, not only what routes re-exports. */
const surfaces = await importTypeScriptModule('src/shared/surfaces.ts');

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

test('a ?tool= survives next to any view — which is the route half of the Git and 文件 menu items', () => {
  // This guard started as “view=changes survives with its tool” after the legacy shell dropped the
  // parameter. The wide change view is gone and so is `routeForNavigate`, but the route the Git and
  // 文件 menu items mean is still this: a tool names a **drawer**, not a page, so it has to survive
  // next to whatever canvas view is on screen.
  for (const tool of ['git', 'files']) {
    const route = routes.parseAppRoute(
      new URLSearchParams(`page=research&project=p1&view=literature&tool=${tool}`)
    );
    assert.equal(route.view, 'literature', tool);
    assert.equal(route.tool, tool);
    assert.equal(toSearch(route).get('tool'), tool);
    assert.ok(routes.sameAppRoute(route, routes.parseAppRoute(toSearch(route))));
  }
});

test('every menu intent either produces a round-tripping route or is the drawer one', () => {
  // The producers are application-menu.ts, macos-host-service.ts and the open-settings handler;
  // src/shared/surfaces.ts owns the closed list. Three of the four intents are route changes and
  // must survive normalization from both a project route and the portal. 打开任务 is not routable at
  // all, which `RoutableMenuIntent` enforces by excluding it — the old `routeForNavigate` expressed
  // it as "return the current route", which `navigate` then dropped as a no-op.
  const base = routes.parseAppRoute(new URLSearchParams('page=research&project=p1'));
  const portal = routes.parseAppRoute(new URLSearchParams('page=research'));
  let routable = 0;
  for (const page of surfaces.menuPages) {
    const intent = surfaces.menuIntentForPage(page);
    assert.notEqual(intent, null, page);
    if (intent.kind === 'management') {
      continue;
    }
    routable += 1;
    for (const from of [base, portal]) {
      const next = routes.routeForMenuIntent(intent, from);
      assert.ok(
        routes.sameAppRoute(next, routes.parseAppRoute(toSearch(next))),
        `${page} does not round-trip`
      );
    }
  }
  assert.equal(routable, 3, 'expected three routable menu intents');
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
  // is how a drawer behaves (顶栏 Git 抽屉盖在画布上).
  const withGit = routes.parseAppRoute(new URLSearchParams('page=research&project=p1&view=latex&tool=git'));
  assert.equal(withGit.view, 'latex');
  assert.equal(withGit.tool, 'git');
  assert.equal(toSearch(withGit).get('tool'), 'git');
  assert.ok(routes.sameAppRoute(withGit, routes.parseAppRoute(toSearch(withGit))));
});

test('a missing view defaults to latex, the canvas default', () => {
  assert.equal(routes.parseAppRoute(new URLSearchParams('page=research&project=p1')).view, 'latex');
});

test('an incoming ?stage= is ignored, never read and never re-written', () => {
  // The stage surface is gone but the parameter is still tolerated: the native menu and any stale
  // deep link keep working, and the URL is cleaned up on the next normalise rather than breaking.
  const withStage = routes.parseAppRoute(new URLSearchParams('page=research&project=p1&stage=write&view=literature'));
  assert.equal(withStage.view, 'literature');
  assert.equal(toSearch(withStage).get('stage'), null);
});

test('a retired or parked view id falls back instead of leaking into the URL', () => {
  // Everything except the three canvas tabs and the three management views has been
  // retired (`overview`/`stage`/`activity`/`provenance`/`diagnostics` with the stage surface,
  // `tasks` with the task board, `files`/`changes` with the view-to-drawer move). A bookmark to any
  // of them must land somewhere real rather than render nothing.
  //
  // The parked domains (ADR 0024: 契约与数据库保留、界面删除) fall back **too**, and that is
  // correct here: the parser has to answer deterministically for any input. The place
  // that refuses them is the gate guard, which is where a wrong page would otherwise pass an
  // assertion — see `surfaces.test.mjs`.
  const retired = [
    'overview',
    'stage',
    'activity',
    'provenance',
    'diagnostics',
    'tasks',
    'files',
    'changes',
    ...surfaces.PARKED_CAPABILITIES.map((parked) => parked.id)
  ];
  for (const id of retired) {
    const parsed = routes.parseAppRoute(new URLSearchParams(`page=research&project=p1&view=${id}`));
    assert.equal(parsed.view, routes.DEFAULT_VIEW, id);
  }
});

test('the tray\'s 打开任务 is a drawer intent, and 任务 is still not a canvas host', () => {
  // Two facts replace the old "next.view === DEFAULT_VIEW" pin, which was true for the wrong reason:
  // it held because the branch did nothing at all. The intent is now a management one (so the shell
  // can open the drawer), and the table still records that 任务 must not gain a canvas view
  // (ADR 0024: two interfaces over one dataset diverge).
  assert.deepEqual(surfaces.menuIntentForPage('tasks'), { kind: 'management', section: 'tasks' });
  const resolution = surfaces.resolveSurface('tasks');
  assert.equal(resolution.kind, 'surface');
  assert.equal(resolution.surface.canvas, 'none');
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
