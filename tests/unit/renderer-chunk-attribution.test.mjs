import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EAGER_FORBIDDEN_PACKAGES,
  findForbiddenPackages,
  packageNameOf,
  scanPackageRegions
} from '../../scripts/lib/renderer-chunk-attribution.mjs';

/**
 * The eager-graph guard has to be tested on its own, because when it silently
 * stops matching nothing else complains: the byte budget is far away from its
 * ceiling and the forbidden *name* list does not cover these packages.
 *
 * That is not hypothetical. The first version of this parser split a pnpm
 * directory like `@xterm+xterm@6.0.0` into `@xterm+xterm`, so the two scoped
 * entries on the deny-list could never fire while ADR-M11, findings F14 and the
 * config comment all said `@xterm/*` was enforced. The generative test at the
 * bottom is the one that would have caught it.
 */

test('a pnpm directory is decoded back to the real package name', () => {
  // Every shape below is copied from a real region marker in dist/renderer.
  assert.equal(packageNameOf('react@19.3.0/node_modules/react/index.js'), 'react');
  assert.equal(
    packageNameOf('react-diff-view@3.3.3_react@19.3.0/node_modules/react-diff-view/es/index.js'),
    'react-diff-view'
  );
  // pnpm encodes the scope's slash as `+` in the directory name.
  assert.equal(
    packageNameOf('@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs'),
    '@xterm/xterm'
  );
  assert.equal(
    packageNameOf('@xterm+addon-fit@0.11.0/node_modules/@xterm/addon-fit/lib/addon-fit.mjs'),
    '@xterm/addon-fit'
  );
  assert.equal(
    packageNameOf('motion-dom@14.2.0/node_modules/motion-dom/dist/es/index.mjs'),
    'motion-dom'
  );
  // A scoped package with a peer suffix.
  assert.equal(
    packageNameOf('@scope+name@1.2.3_react@19.3.0/node_modules/@scope/name/dist/index.js'),
    '@scope/name'
  );
});

test('regions are counted per package', () => {
  const source = [
    '//#region node_modules/.pnpm/react@19.3.0/node_modules/react/index.js',
    'code',
    '//#region node_modules/.pnpm/react@19.3.0/node_modules/react/jsx-runtime.js',
    '//#region node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs'
  ].join('\n');
  const counts = scanPackageRegions(source);
  assert.equal(counts.get('react'), 2);
  assert.equal(counts.get('@xterm/xterm'), 1);
  assert.equal(counts.size, 2);
});

test('the lazy-only packages are reported when they are in the source', () => {
  const source = '//#region node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs';
  assert.deepEqual(findForbiddenPackages(source), ['@xterm/xterm']);

  const diffSource =
    '//#region node_modules/.pnpm/react-diff-view@3.3.3_react@19.3.0/node_modules/react-diff-view/es/index.js';
  assert.deepEqual(findForbiddenPackages(diffSource), ['react-diff-view']);
});

test('eager-only packages are not reported', () => {
  const source = [
    '//#region node_modules/.pnpm/react@19.3.0/node_modules/react/index.js',
    '//#region node_modules/.pnpm/react-dom@19.3.0_react@19.3.0/node_modules/react-dom/index.js',
    '//#region node_modules/.pnpm/lucide-react@1.56.0_react@19.3.0/node_modules/lucide-react/dist/esm/lucide-react.js'
  ].join('\n');
  assert.deepEqual(findForbiddenPackages(source), []);
  assert.deepEqual(findForbiddenPackages(''), []);
});

test('every deny-listed package can actually fire', () => {
  // Generative on purpose: hand-written cases only cover the shapes I remembered
  // to write down, which is how `@xterm/xterm` stayed broken. For each entry,
  // build the marker pnpm would emit for it and require a match.
  const pnpmDirectory = (name) =>
    name.includes('/') ? `${name.replace('/', '+')}@1.0.0` : `${name}@1.0.0`;
  for (const name of EAGER_FORBIDDEN_PACKAGES) {
    const source = `//#region node_modules/.pnpm/${pnpmDirectory(name)}/node_modules/${name}/index.js`;
    assert.deepEqual(
      findForbiddenPackages(source),
      [name],
      `${name} is on the deny-list but the parser cannot match its own marker`
    );
  }
});

test('the deny-list itself stays in canonical npm form', () => {
  for (const name of EAGER_FORBIDDEN_PACKAGES) {
    // pnpm's `+` encoding belongs in built directory names, never in the list: a
    // `+` here would mean the entry can never match (the original bug).
    assert.ok(!name.includes('+'), `${name} must use "/" not pnpm's "+" encoding`);
    // A scoped entry must keep its scope, otherwise it is a different package.
    if (name.startsWith('@')) {
      assert.match(name, /^@[^/]+\/[^/]+$/u, `${name} must be a scoped name`);
    }
  }
  // Sanity: the list is de-duplicated and non-empty.
  assert.equal(new Set(EAGER_FORBIDDEN_PACKAGES).size, EAGER_FORBIDDEN_PACKAGES.length);
  assert.ok(EAGER_FORBIDDEN_PACKAGES.length > 0);
});
