import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const routes = await importTypeScriptModule('src/renderer/app/routes.ts');
const surfaces = await importTypeScriptModule('src/shared/surfaces.ts');
const ALL_VIEWS = ['overview', 'discover', 'library', 'knowledge', 'writing', 'runs'];
const ALL_TOOLS = [null, 'files', 'git', 'terminal', 'memory', 'skills', 'mcp', 'tasks'];
const ALL_OPEN_FILES = [null, 'src/a.ts', '目录/含 空格.md'];

function* allRoutes() {
  for (const page of ['research', 'settings']) {
    for (const projectId of [null, 'p1']) {
      for (const view of ALL_VIEWS) {
        for (const tool of ALL_TOOLS) {
          for (const openFile of ALL_OPEN_FILES) {
            for (const assistantOpen of [false, true]) {
              for (const newProject of [false, true]) {
                yield routes.normalizeAppRoute({ page, projectId, ...routes.routeForView(view), tool, openFile,
                  assistantOpen, layoutPreset: null, newProject });
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

const parse = search => routes.parseAppRoute(new URLSearchParams(search));

test('parse(write(route)) preserves every canonical destination, tool and scope', () => {
  let checked = 0;
  for (const route of allRoutes()) {
    assert.deepEqual(routes.parseAppRoute(toSearch(route)), route);
    checked += 1;
  }
  assert.equal(checked, 2304);
});

test('normalization is idempotent', () => {
  for (const route of allRoutes()) assert.deepEqual(routes.normalizeAppRoute(route), route);
});

test('workspace tools select their owning canvas and retain compatible subviews', () => {
  for (const view of ALL_VIEWS) {
    for (const tool of ALL_TOOLS.filter(Boolean)) {
      const route = parse(`page=research&project=p1&view=${view}&tool=${tool}`);
      const destination = tool === 'tasks' ? {view: 'runs', subview: null} :
        tool === 'terminal' || tool === 'files' ? {view: 'writing', subview: null} : routes.routeForView(view);
      assert.equal(route.view, destination.view);
      assert.equal(route.subview, destination.subview);
      assert.equal(route.tool, tool === 'tasks' ? null : tool);
      assert.deepEqual(parse(toSearch(route)), route);
    }
  }
});

test('normalization opens the terminal in its writing host', () => {
  const route = parse('page=research&project=p1&view=overview&file=main.tex&assistant=1');
  const terminal = routes.normalizeAppRoute({...route, tool: 'terminal'});
  assert.deepEqual(terminal, {...route, view: 'writing', tool: 'terminal'});
  assert.deepEqual(parse(toSearch(terminal)), terminal);
});

test('previous-release bookmarks migrate once and preserve project, file and assistant', () => {
  const migrations = [
    ['latex', 'writing', null, null],
    ['literature', 'library', null, null],
    ['discover', 'overview', 'discover', null],
    ['knowledge', 'library', 'knowledge', null],
    ['terminal', 'writing', null, 'terminal'],
    ['memory', 'overview', null, 'memory'],
    ['skills', 'overview', null, 'skills'],
    ['mcp', 'overview', null, 'mcp']
  ];
  for (const [previous, view, subview, tool] of migrations) {
    const route = parse(`page=research&project=p1&view=${previous}&file=目录%2Fa%20b.tex&assistant=1`);
    assert.deepEqual(route, {
      page: 'research', projectId: 'p1', view, subview, tool,
      openFile: '目录/a b.tex', assistantOpen: true, layoutPreset: null, newProject: false
    });
    assert.equal(toSearch(route).get('view'), view);
    assert.equal(toSearch(route).get('subview'), subview);
    assert.deepEqual(parse(toSearch(route)), route);
  }
});

test('an explicit tool in a legacy bookmark takes precedence over an inferred tool', () => {
  const route = parse('page=research&project=p1&view=terminal&tool=git');
  assert.equal(route.view, 'writing');
  assert.equal(route.tool, 'git');
  assert.equal(parse('page=research&project=p1&view=mcp&tool=invalid').tool, 'mcp');
});

test('settings preserves a migrated project route under the overlay', () => {
  const route = parse('page=settings&project=p1&view=latex&file=main.tex&assistant=1');
  assert.equal(route.page, 'settings');
  assert.equal(route.view, 'writing');
  assert.equal(route.openFile, 'main.tex');
  assert.deepEqual(parse(toSearch(route)), route);
});

test('menu intents produce round-tripping routes and opening the assistant preserves the canvas', () => {
  const base = parse('page=research&project=p1&view=writing&file=main.tex');
  const portal = parse('page=research');
  for (const page of surfaces.menuPages) {
    const intent = surfaces.menuIntentForPage(page);
    if (intent.kind === 'management') continue;
    for (const from of [base, portal]) {
      const next = routes.routeForMenuIntent(intent, from);
      assert.deepEqual(parse(toSearch(next)), next);
    }
  }
  const assistant = routes.routeForMenuIntent({kind: 'assistant'}, base);
  assert.equal(assistant.view, 'writing');
  assert.equal(assistant.openFile, 'main.tex');
  assert.equal(assistant.assistantOpen, true);
});

test('the portal drops project-only state, including migrated tools', () => {
  const route = parse('page=research&view=memory&tool=terminal&file=main.tex&assistant=1');
  assert.deepEqual(route, {
    page: 'research', projectId: null, view: 'overview', subview: null, tool: null,
    openFile: null, assistantOpen: false, layoutPreset: null, newProject: false
  });
  const search = toSearch(route);
  for (const key of ['view', 'subview', 'tool', 'file', 'assistant', 'project']) assert.equal(search.get(key), null);
});

test('a project without a view opens the overview', () => {
  assert.equal(parse('page=research&project=p1').view, 'overview');
});

test('layout presets round trip without changing project content or assistant visibility', () => {
  for (const preset of ['research', 'writing', 'review']) {
    const route = parse(`project=p1&view=overview&subview=discover&layoutPreset=${preset}`);
    assert.equal(route.layoutPreset, preset);
    assert.equal(route.subview, 'discover');
    assert.equal(route.assistantOpen, false);
    assert.deepEqual(parse(toSearch(route)), route);
  }
  const invalid = parse('project=p1&view=overview&subview=knowledge&layoutPreset=invalid');
  assert.equal(invalid.subview, null);
  assert.equal(invalid.layoutPreset, null);
});

test('retired stage parameters are neither consumed nor written', () => {
  const route = parse('page=research&project=p1&stage=write&view=library');
  assert.equal(route.view, 'library');
  assert.equal(toSearch(route).get('stage'), null);
});

test('unsupported views normalize without becoming registered canvas destinations', () => {
  for (const id of ['stage', 'activity', 'provenance', 'diagnostics', 'tasks', 'files', 'changes',
    ...surfaces.PARKED_CAPABILITIES.map(parked => parked.id)]) {
    assert.equal(routes.APP_VIEW_IDS.has(id), false);
    assert.equal(parse(`page=research&project=p1&view=${id}`).view, routes.DEFAULT_VIEW);
  }
});

test('file selection survives destination changes and blank paths normalize to null', () => {
  const deepLink = parse('page=research&project=p1&view=library&file=a%20b/%E7%9B%AE.md');
  assert.equal(deepLink.openFile, 'a b/目.md');
  assert.deepEqual(parse(toSearch({...deepLink, view: 'writing'})), {...deepLink, view: 'writing'});
  assert.equal(parse('page=research&project=p1&file=%20%20').openFile, null);
});
