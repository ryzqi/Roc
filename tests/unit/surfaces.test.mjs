import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const surfaces = await importTypeScriptModule('src/shared/surfaces.ts');
const gate = await importTypeScriptModule('scripts/lib/gate-surfaces.mjs');

/** The guard the gate scripts share; the table is passed in rather than imported (see its header). */
const assertKnownView = gate.createViewGuard(surfaces);

/**
 * The surface table is the one home for "what exists and where it lands" (candidate 1).
 *
 * These tests exist because the table's value is entirely in the properties nobody can see by
 * reading it: that its derived sets match the code that used to keep its own copies, that a
 * retirement is representable, and — the one that already found eight bugs — that no gate script
 * navigates to a surface that does not exist.
 */

// ---------------------------------------------------------------------------------------------
// Table invariants
// ---------------------------------------------------------------------------------------------

test('the table has no duplicate ids', () => {
  const ids = surfaces.SURFACES.map((surface) => surface.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate surface id in ${ids.join(', ')}`);
});

test('exactly one surface is the default view, and it is a canvas view', () => {
  const defaults = surfaces.SURFACES.filter((surface) => surface.defaultView === true);
  assert.equal(defaults.length, 1, 'the ?view= default must be unambiguous');
  assert.equal(defaults[0].id, surfaces.defaultViewId);
  assert.ok(
    surfaces.isCanvasViewId(surfaces.defaultViewId),
    `default ${surfaces.defaultViewId} must be a ?view= value`
  );
});

test('the derived sets are the ones the shell used to keep by hand', () => {
  // These three assertions are the migration guard: each array replaced a hand-written copy.
  //   canvasTabIds    <- AppShell PRIMARY_TABS + WorkspaceCanvas TABS + CanvasTabId's Extract<>
  //   drawerSectionIds<- ManagementTabId + two inline `'memory' | 'skills' | 'mcp' | 'tasks'`
  //   canvasViewIds   <- routes.APP_VIEW_IDS
  assert.deepEqual([...surfaces.canvasTabIds], ['literature', 'latex', 'terminal']);
  assert.deepEqual([...surfaces.drawerSectionIds], ['memory', 'skills', 'mcp', 'tasks']);
  assert.deepEqual(
    [...surfaces.canvasViewIds],
    ['literature', 'latex', 'terminal', 'memory', 'skills', 'mcp']
  );
});

test('canvas tabs are canvas views, and the two sets differ by exactly the drawer sections', () => {
  for (const tab of surfaces.canvasTabIds) {
    assert.ok(surfaces.isCanvasViewId(tab), `${tab} is a tab but not a view`);
  }
  // 记忆 / 技能 / MCP are the three canvas views that are *also* drawer sections; 任务 is the one
  // drawer section with no canvas host (ADR 0024: two interfaces over one dataset diverge).
  const viewsThatAreNotTabs = surfaces.canvasViewIds.filter((id) => !surfaces.isCanvasTabId(id));
  assert.deepEqual([...viewsThatAreNotTabs], ['memory', 'skills', 'mcp']);
  for (const id of viewsThatAreNotTabs) {
    assert.ok(surfaces.isDrawerSectionId(id), `${id} is a non-tab canvas view but not a drawer section`);
  }
});

test('a parked capability cannot collide with a live surface id', () => {
  for (const parked of surfaces.PARKED_CAPABILITIES) {
    assert.equal(
      surfaces.resolveSurface(parked.id).kind,
      'parked',
      `${parked.id} is both a parked capability and a live surface`
    );
  }
});

test('every parked capability names the capability prefix the registry actually has', () => {
  // The contract is the authority for these names, and they are irregular: `research.ideas` is
  // plural while `research.experiment` / `research.figure` / `research.export` / `research.template`
  // are singular, and 阶段策略 hangs off `research.workflow.policies`. A wrong prefix here would be
  // invisible until someone used it.
  const generated = readFileSync('src/shared/ipc-generated.ts', 'utf8');
  for (const parked of surfaces.PARKED_CAPABILITIES) {
    assert.ok(
      generated.includes(`'${parked.capability}`) || generated.includes(`'${parked.capability}.`),
      `${parked.capability} is not a capability prefix in src/shared/ipc-generated.ts`
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The resolver: three outcomes, not two
// ---------------------------------------------------------------------------------------------

test('a live canvas view resolves to a surface', () => {
  for (const id of surfaces.canvasViewIds) {
    const resolution = surfaces.resolveSurface(id);
    assert.equal(resolution.kind, 'surface', id);
    assert.notEqual(resolution.surface.canvas, 'none');
  }
});

test('a drawer-only section resolves to a surface that has no canvas host', () => {
  // This is the rule ADR 0024 records, made checkable: the task board must not come back as a
  // canvas view, and the table is where that is true or false.
  const resolution = surfaces.resolveSurface('tasks');
  assert.equal(resolution.kind, 'surface');
  assert.equal(resolution.surface.canvas, 'none');
  assert.equal(resolution.surface.drawer, true);
  assert.equal(surfaces.canvasViewForDrawerSection('tasks'), null);
  assert.equal(surfaces.drawerSectionForCanvasView('tasks'), null);
});

test('a preserved-but-unbuilt domain resolves to parked, not unknown', () => {
  const resolution = surfaces.resolveSurface('manuscript');
  assert.equal(resolution.kind, 'parked');
  assert.equal(resolution.parked.capability, 'research.manuscript');
});

test('the surfaces retired in P10 resolve to unknown', () => {
  const retired = [
    'overview',
    'stage',
    'activity',
    'provenance',
    'diagnostics',
    'files',
    'changes',
    'tasks-board'
  ];
  for (const id of retired) {
    assert.equal(surfaces.resolveSurface(id).kind, 'unknown', id);
  }
});

test('empty input is unknown, never a surface', () => {
  for (const value of [null, undefined, '']) {
    assert.equal(surfaces.resolveSurface(value).kind, 'unknown', String(value));
  }
});

// ---------------------------------------------------------------------------------------------
// Menu intents
// ---------------------------------------------------------------------------------------------

test('every menu page has an intent, and its sections are drawer sections', () => {
  for (const page of surfaces.menuPages) {
    const intent = surfaces.menuIntentForPage(page);
    assert.notEqual(intent, null, page);
    assert.equal(intent, surfaces.MENU_PAGES[page]);
    if (intent.kind === 'management') {
      assert.ok(
        surfaces.isDrawerSectionId(intent.section),
        `${page} opens ${intent.section}, which is not a drawer section`
      );
    }
  }
});

test("the tray's 打开任务 opens the drawer's task section", () => {
  // The defect this replaces: `routeForNavigate('tasks')` returned the current route, the
  // `sameAppRoute` early-return dropped the navigation, and the tray item only raised the window
  // while its own comment claimed the drawer was opened. `tasks` has no canvas host, so an intent
  // is the only shape that can express it.
  assert.deepEqual(surfaces.menuIntentForPage('tasks'), { kind: 'management', section: 'tasks' });
});

test('the nine page names nothing produces are no longer claimed', () => {
  // `routeForNavigate` handled thirteen names for four real producers. The other nine are gone
  // rather than kept as a compatibility layer (ADR 0022: 不保留兼容层).
  const dropped = ['tasks-board', 'workspace', 'files', 'git', 'terminal', 'memory', 'mcp', 'skills', 'research'];
  for (const page of dropped) {
    assert.equal(surfaces.menuIntentForPage(page), null, page);
  }
});

test('the main process emits only pages the table knows', () => {
  // The producers are application-menu.ts (2), macos-host-service.ts (2) and the
  // `roc:app:open-settings` handler. This reads them so a producer added without a table entry
  // fails here instead of silently doing nothing at runtime.
  const sources = [
    'src/main/application-menu.ts',
    'src/main/macos-host-service.ts',
    'src/main/ipc/register-ipc.ts'
  ];
  const emitted = new Set();
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/openMainPage\((['"])([a-z-]+)\1\)/gu)) {
      emitted.add(match[2]);
    }
  }
  assert.ok(emitted.size >= 4, `expected to find the producers, found ${[...emitted].join(', ')}`);
  for (const page of emitted) {
    assert.notEqual(surfaces.menuIntentForPage(page), null, `${page} has no intent`);
  }
});

// ---------------------------------------------------------------------------------------------
// The drift guard: no gate script may navigate to a surface that does not exist
// ---------------------------------------------------------------------------------------------

test('every ?view= in a gate script resolves to a real canvas view', () => {
  // This found eight assertions passing on the wrong page: `view=overview` had been normalised to
  // `latex` since P10 removed the overview surface, so the gates were green against a page that
  // was not the one they named. Probing for the *value* form found a ninth that the query-string
  // pattern could not see — `verify-p4-assistant.mjs:80` had `view = 'overview'` as a parameter
  // default, so the id never appeared as `view=...` anywhere in the file.
  //
  // Two patterns, because a view id reaches the URL two ways: interpolated into a query string, or
  // written as a literal next to the word `view` (a parameter default, an object property).
  const patterns = [/view=([a-z][a-z-]*)/gu, /view\s*[=:]\s*['"`]([a-z][a-z-]*)['"`]/gu];
  const failures = [];
  let checked = 0;
  for (const file of listScripts()) {
    const source = readFileSync(file, 'utf8');
    for (const [index, line] of source.split('\n').entries()) {
      // Comments are history, not navigation: `verify-p3` and `verify-p5` both *document* the
      // removed `view=files` next to the line that replaced it, and that must stay legal.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        continue;
      }
      for (const pattern of patterns) {
        for (const match of line.matchAll(pattern)) {
          checked += 1;
          const value = match[1];
          try {
            assertKnownView(value);
          } catch (error) {
            failures.push(`${file}:${index + 1} ${String(error.message)}`);
          }
        }
      }
    }
  }
  assert.ok(checked >= 20, `expected to sweep the gate scripts, checked only ${checked}`);
  assert.deepEqual(failures, [], `gate scripts navigate to surfaces that do not exist:\n${failures.join('\n')}`);
});

test('the gate guard refuses parked and unknown views rather than normalising them', () => {
  assert.equal(assertKnownView('latex'), 'latex');
  assert.throws(() => assertKnownView('manuscript'), /gate_view_parked/u);
  assert.throws(() => assertKnownView('overview'), /gate_view_unknown/u);
  assert.throws(() => assertKnownView('tasks'), /gate_view_without_canvas/u);
});

function listScripts() {
  const dir = 'scripts';
  return readdirSync(dir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => join(dir, name));
}
