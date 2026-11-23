import {createElement, Profiler} from 'react';
import {createReactProfileCollector} from './collectors.mjs';

const collector = createReactProfileCollector();
Object.defineProperty(window, '__rocReactProfile', {value: Object.freeze({
  begin: name => collector.begin(name), end: () => collector.end(), snapshot: () => collector.snapshot()
}), configurable: false});

/** Stable module-level wrapper; this file never enters an ordinary renderer graph. */
export function profileComponent(id, Component) {
  const Profiled = props => createElement(Profiler, {id, onRender: collector.onRender}, createElement(Component, props));
  Profiled.displayName = `Profile(${id})`;
  return Profiled;
}
