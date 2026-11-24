#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const expressionWrappers = new Set([
  'JSXExpressionContainer', 'TSAsExpression', 'TSSatisfiesExpression',
  'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'
]);
const functionTypes = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'
]);
const scopeTypes = new Set([
  'Program', 'BlockStatement', 'CatchClause',
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement'
]);

function bindPattern(pattern, value, scope) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') scope.bindings.set(pattern.name, value);
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      bindPattern(property.type === 'RestElement' ? property.argument : property.value, null, scope);
    }
  } else if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach(element => bindPattern(element, null, scope));
  } else if (pattern.type === 'AssignmentPattern') bindPattern(pattern.left, null, scope);
  else if (pattern.type === 'RestElement') bindPattern(pattern.argument, null, scope);
  else if (pattern.type === 'TSParameterProperty') bindPattern(pattern.parameter, null, scope);
}

function utilityName(token) {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    if (token[index] === '[' || token[index] === '(') depth++;
    else if (token[index] === ']' || token[index] === ')') depth--;
    else if (token[index] === ':' && depth === 0) start = index + 1;
  }
  return token.slice(start).replace(/^!|!$/g, '');
}

function motionViolation(token) {
  const utility = utilityName(token);
  if (utility === 'transition-all') {
    return ['MOTION-001', 'Use explicit transition properties instead of transition-all.'];
  }
  if (/^duration-(?:\[[^\]]+\]|\d[\d.]*)$/.test(utility)) {
    return ['MOTION-002', 'Use ui-motion-micro/fast/base/overlay instead of a local duration.'];
  }
  const properties = /^transition-\[(.+)\]$/.exec(utility)?.[1]
    .split(',').map(property => property.replaceAll('_', ' ').trim()) ?? [];
  if (['transition-shadow', 'transition-filter'].includes(utility)
    || properties.some(property => /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|filter|backdrop-filter|box-shadow)$/.test(property))) {
    return ['MOTION-003', 'Keep frequent transitions on opacity/transform or semantic colors.'];
  }
  return null;
}

/** Static class expressions and local initializers only; never executes source. */
export function auditMotionSource(source, filename = 'source.tsx') {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const scopeOf = new WeakMap();
  const attributes = [];

  function visit(node, parentScope) {
    if (!node || typeof node.type !== 'string') return;
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) && node.id) {
      parentScope.bindings.set(node.id.name, null);
    }
    const scope = scopeTypes.has(node.type) || functionTypes.has(node.type)
      ? { parent: parentScope, bindings: new Map() } : parentScope;
    scopeOf.set(node, scope);
    if (functionTypes.has(node.type)) {
      node.params.forEach(parameter => bindPattern(parameter, null, scope));
      if (node.id) bindPattern(node.id, null, scope);
    }
    if (node.type === 'CatchClause') bindPattern(node.param, null, scope);
    if (node.type === 'VariableDeclarator') bindPattern(node.id, node.init, scope);
    if (node.type === 'ImportDeclaration') {
      node.specifiers.forEach(specifier => bindPattern(specifier.local, null, scope));
    }
    if (node.type === 'JSXAttribute' && node.name.name === 'className' && node.value) {
      attributes.push(node);
    }
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens', 'errors'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(value => visit(value, scope));
      else if (child && typeof child === 'object') visit(child, scope);
    }
  }
  visit(ast.program, null);

  function binding(node) {
    for (let scope = scopeOf.get(node); scope; scope = scope.parent) {
      if (scope.bindings.has(node.name)) return scope.bindings.get(node.name);
    }
    return null;
  }

  function reference(node) {
    const seen = new Set();
    while (node && !seen.has(node)) {
      seen.add(node);
      if (expressionWrappers.has(node.type)) node = node.expression;
      else if (node.type === 'Identifier') node = binding(node);
      else return node;
    }
    return null;
  }

  function propertyKey(node, computed) {
    const key = computed ? reference(node) : node;
    if (key?.type === 'StringLiteral' || key?.type === 'NumericLiteral') return String(key.value);
    return !computed && key?.type === 'Identifier' ? key.name : null;
  }

  const combine = (left, right) => (left.length ? left : [''])
    .flatMap(prefix => (right.length ? right : ['']).map(suffix => prefix + suffix));

  function classStrings(node, seen = new Set()) {
    if (!node || seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (expressionWrappers.has(node.type)) return classStrings(node.expression, next);
    if (node.type === 'StringLiteral' || node.type === 'NumericLiteral') return [String(node.value)];
    if (node.type === 'Identifier') return classStrings(binding(node), next);
    if (node.type === 'TemplateLiteral') {
      let strings = [node.quasis[0].value.cooked ?? node.quasis[0].value.raw];
      node.expressions.forEach((expression, index) => {
        strings = combine(strings, classStrings(expression, next))
          .map(value => value + (node.quasis[index + 1].value.cooked ?? node.quasis[index + 1].value.raw));
      });
      return strings;
    }
    if (node.type === 'ConditionalExpression') {
      return [...classStrings(node.consequent, next), ...classStrings(node.alternate, next)];
    }
    if (node.type === 'LogicalExpression') {
      return node.operator === '&&' ? classStrings(node.right, next)
        : [...classStrings(node.left, next), ...classStrings(node.right, next)];
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      return combine(classStrings(node.left, next), classStrings(node.right, next));
    }
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const object = reference(node.object);
      const key = propertyKey(node.property, node.computed);
      if (object?.type === 'ObjectExpression') {
        return object.properties.flatMap(property => {
          if (property.type === 'SpreadElement') return classStrings(property.argument, next);
          if (property.type !== 'ObjectProperty') return [];
          return key === null || key === propertyKey(property.key, property.computed)
            ? classStrings(property.value, next) : [];
        });
      }
      if (object?.type === 'ArrayExpression') {
        return (key === null ? object.elements : [object.elements[Number(key)]])
          .flatMap(element => classStrings(element, next));
      }
    }
    if (node.type === 'ArrayExpression') return node.elements.flatMap(element => classStrings(element, next));
    if (node.type === 'ObjectExpression') {
      return node.properties.flatMap(property => classStrings(
        property.type === 'SpreadElement' ? property.argument : property.value, next
      ));
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      const method = propertyKey(node.callee.property, node.callee.computed);
      if (method === 'join' && reference(node.arguments[0])?.value === ' '
        || method === 'filter' && node.arguments[0]?.type === 'Identifier' && node.arguments[0].name === 'Boolean') {
        return classStrings(node.callee.object, next);
      }
    }
    return [];
  }

  const diagnostics = [];
  for (const attribute of attributes) {
    const tokens = new Set(classStrings(attribute.value).flatMap(value => value.split(/\s+/)).filter(Boolean));
    for (const token of tokens) {
      const violation = motionViolation(token);
      if (violation) {
        diagnostics.push({
          filename, line: attribute.loc.start.line, column: attribute.loc.start.column + 1,
          code: violation[0], token, message: violation[1]
        });
      }
    }
  }
  return diagnostics;
}

async function sourceFiles(target) {
  const info = await stat(target);
  if (info.isFile()) {
    if (/\.[cm]?[jt]sx?$/.test(target)) return [target];
    throw new Error(`Expected a TypeScript/JavaScript source file: ${target}`);
  }
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const filename = path.join(target, entry.name);
    return entry.isDirectory() ? sourceFiles(filename)
      : /\.[cm]?[jt]sx?$/.test(entry.name) ? [filename] : [];
  }));
  return nested.flat().sort();
}

async function main(targets) {
  const files = [...new Set((await Promise.all(
    (targets.length ? targets : ['src/renderer']).map(target => sourceFiles(path.resolve(target)))
  )).flat())];
  if (!files.length) throw new Error('No TypeScript/JavaScript source files found.');
  let violations = 0;
  let failures = 0;
  for (const absolute of files) {
    const filename = path.relative(process.cwd(), absolute);
    try {
      const diagnostics = auditMotionSource(await readFile(absolute, 'utf8'), filename);
      violations += diagnostics.length;
      for (const diagnostic of diagnostics) {
        console.log(`${filename}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code} ${diagnostic.token} — ${diagnostic.message}`);
      }
    } catch (error) {
      failures++;
      console.error(`${filename}:${error.loc?.line ?? 1} MOTION-INPUT ${error.message}`);
    }
  }
  console.log(`Motion audit: ${files.length} files, ${violations} violations, ${failures} input failures.`);
  process.exitCode = failures ? 2 : violations ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Motion audit: ${error.message}`);
    process.exitCode = 2;
  });
}
