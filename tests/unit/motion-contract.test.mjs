import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  motionDurationSeconds, motionEasing, motionTransitions,
  tabIndicatorTransition, popoverTransition, modalPopTransition,
  drawerTransition, scrimTransition, getMotionTransition, getMotionVariants,
  getScrimVariants
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

test('existing overlay and selection exports share the current event scale', () => {
  assert.equal(tabIndicatorTransition, motionTransitions.selection);
  assert.equal(popoverTransition, motionTransitions.popover);
  assert.equal(modalPopTransition, motionTransitions.modal);
  assert.equal(drawerTransition, motionTransitions.drawer);
  assert.deepEqual([
    tabIndicatorTransition.duration, popoverTransition.duration,
    modalPopTransition.duration, drawerTransition.duration, scrimTransition.duration
  ], [0.22, 0.22, 0.22, 0.22, 0.22]);
});

test('every event settles within 300ms and exit never outlasts entry', () => {
  for (const event of Object.keys(motionTransitions)) {
    const enter = getMotionTransition(event, false);
    const exit = getMotionTransition(event, false, 'exit');
    assert.ok(enter.duration > 0 && enter.duration <= 0.3, event);
    assert.ok(exit.duration > 0 && exit.duration <= enter.duration, event);
    if (enter.type === 'spring') assert.equal(enter.bounce, 0, event);
    assert.equal(exit.type, 'tween', event);
    assert.equal(enter.reduceMotion, false, event);
    assert.equal(exit.reduceMotion, false, event);
  }
});

test('reduced variants preserve an opacity handoff and immediately reset prior movement', () => {
  for (const event of Object.keys(motionTransitions)) {
    const variants = getMotionVariants(event, true, 1);
    assert.equal(variants.initial.opacity, 0, event);
    assert.equal(variants.animate.opacity, 1, event);
    assert.equal(variants.exit.opacity, 0, event);
    for (const phase of ['initial', 'animate', 'exit']) {
      const variant = variants[phase];
      assert.equal(variant.x, 0, `${event}:${phase}`);
      assert.equal(variant.y, 0, `${event}:${phase}`);
      assert.equal(variant.scale, 1, `${event}:${phase}`);
      assert.equal(variant.rotate, 0, `${event}:${phase}`);
    }
    for (const phase of ['animate', 'exit']) {
      assert.equal(variants[phase].transition.type, 'tween', event);
      assert.equal(variants[phase].transition.duration, 0.1, event);
      // Motion 14 caches the initial preference on a VisualElement. This live
      // override is needed for changes while that same element remains mounted.
      assert.equal(variants[phase].transition.reduceMotion, true, event);
    }
  }
});

test('content handoffs respect selection direction without animating geometry', () => {
  for (const direction of [-1, 0, 1]) {
    const variants = getMotionVariants('content-handoff', false, direction);
    assert.equal(variants.initial.y, direction * 4);
    assert.equal(variants.animate.y, 0);
    assert.equal(variants.exit.y, direction * -4);
    assert.equal(variants.animate.transition.duration, 0.15);
    assert.equal(variants.exit.transition.duration, 0.11);
    for (const variant of Object.values(variants)) {
      for (const property of ['width', 'height', 'top', 'left', 'margin', 'padding']) {
        assert.equal(variant[property], undefined);
      }
    }
  }
});

test('error feedback ends at rest without repeating and number movement stays local', () => {
  const error = getMotionVariants('error', false);
  assert.deepEqual(error.animate.x, [0, -4, 4, -2, 2, 0]);
  assert.equal(error.animate.transition.duration, 0.26);
  assert.equal(error.animate.transition.repeat, undefined);
  assert.equal(getMotionVariants('number', false, 1).animate.transition.duration, 0.18);
  assert.equal(getMotionVariants('number', false, -1).initial.y, -4);
});

test('surface and scrim enter and exit share their lifecycle timing', () => {
  for (const event of ['modal', 'drawer']) {
    for (const reduced of [true, false]) {
      const variants = getMotionVariants(event, reduced);
      const scrim = getScrimVariants(event, reduced);
      assert.deepEqual(scrim.animate.transition, variants.animate.transition);
      assert.deepEqual(scrim.exit.transition, variants.exit.transition);
      assert.deepEqual(Object.keys(scrim.animate).sort(), ['opacity', 'transition']);
    }
  }
});
