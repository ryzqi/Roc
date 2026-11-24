import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  motionDurationSeconds, motionEasing, motionTransitions,
  tabIndicatorTransition, popoverTransition, modalPopTransition,
  drawerTransition, scrimTransition
} from '../../src/renderer/shared/motion.ts';

test('CSS milliseconds and easing tokens match the Motion event scale', async () => {
  const css = await readFile(new URL('../../src/renderer/styles/tokens.css', import.meta.url), 'utf8');
  const token = name => {
    const value = css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
    assert.ok(value, `Missing ${name}`);
    return value;
  };
  for (const [name, seconds] of Object.entries(motionDurationSeconds)) {
    assert.equal(token(`--duration-${name === 'legacySlow' ? 'legacy-slow' : name}`), `${seconds * 1000}ms`);
  }
  for (const [name, curve] of Object.entries(motionEasing)) {
    const coordinates = token(`--ease-${name}`).match(/^cubic-bezier\(([^)]+)\)$/)?.[1];
    assert.ok(coordinates, `Expected a cubic-bezier for ${name}`);
    assert.deepEqual(coordinates.split(',').map(Number), curve);
  }
  assert.equal(token('--duration-slow'), 'var(--duration-legacy-slow)');
  assert.equal(token('--easing-standard'), 'var(--ease-standard)');
});

test('existing overlay and selection exports retain their event presets and timings', () => {
  assert.equal(tabIndicatorTransition, motionTransitions.selection);
  assert.equal(popoverTransition, motionTransitions.popover);
  assert.equal(modalPopTransition, motionTransitions.modal);
  assert.equal(drawerTransition, motionTransitions.drawer);
  assert.deepEqual([
    tabIndicatorTransition.duration, popoverTransition.duration,
    modalPopTransition.duration, drawerTransition.duration, scrimTransition.duration
  ], [0.18, 0.12, 0.18, 0.2, 0.18]);
});
