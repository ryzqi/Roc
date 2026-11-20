import { parse } from '@babel/parser';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sha256 } from './report-lib.mjs';

const areas = [
  'src/main/plugins/research/', 'src/main/services/deep-agent/',
  'src/renderer/assistant/', 'src/renderer/literature/', 'src/shared/'
];
const output = process.argv[2] ?? '.artifacts/mac-performance/mac-module-reference-audit.json';
const rawOutput = resolve('.artifacts/mac-performance/pr-15-module-reference-inventory.json');
const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  .toString().split('\0').filter(path => /\.(?:[cm]?[jt]sx?|json|ya?ml|md|css|html|sh)$/u.test(path)).sort();
const texts = new Map(paths.map(path => [path, readFileSync(path, 'utf8')]));
const tokens = new Map();
for (const text of texts.values()) {
  for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)) {
    tokens.set(match[0], (tokens.get(match[0]) ?? 0) + 1);
  }
}

function bindings(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'RestElement') return bindings(node.argument);
  if (node.type === 'AssignmentPattern') return bindings(node.left);
  if (node.type === 'ObjectPattern') return node.properties.flatMap(item => bindings(item.value ?? item.argument));
  if (node.type === 'ArrayPattern') return node.elements.flatMap(bindings);
  return [];
}

const modules = [];
for (const [path, text] of texts) {
  const area = areas.find(area => path.startsWith(area));
  if (!area || !/\.[cm]?[jt]sx?$/u.test(path)) continue;
  const ast = parse(text, {
    sourceType: 'unambiguous',
    plugins: [/\.[cm]?tsx?$/u.test(path) ? 'typescript' : null, /x$/u.test(path) ? 'jsx' : null].filter(Boolean)
  });
  const item = { path, area, sha256: sha256(text), exports: [], staticModules: [], dynamicModules: [],
    nonliteralDynamicImports: 0, capabilityStrings: [], pluginIdentityStrings: [] };
  const pending = [ast.program];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'ExportNamedDeclaration') {
      const declaration = node.declaration;
      const typeOnly = node.exportKind === 'type' || declaration?.type === 'TSInterfaceDeclaration' ||
        declaration?.type === 'TSTypeAliasDeclaration';
      const names = declaration?.type === 'VariableDeclaration'
        ? declaration.declarations.flatMap(value => bindings(value.id)) : bindings(declaration?.id);
      item.exports.push(...names.map(name => ({ name, kind: typeOnly ? 'type' : 'value',
        lexicalOccurrences: tokens.get(name) ?? 0 })));
      item.exports.push(...node.specifiers.map(specifier => ({
        name: specifier.exported.name ?? specifier.exported.value,
        kind: typeOnly || specifier.exportKind === 'type' ? 'type' : 'value',
        lexicalOccurrences: tokens.get(specifier.local?.name ?? specifier.exported.name) ?? 0
      })));
    } else if (node.type === 'ExportDefaultDeclaration') {
      item.exports.push({ name: 'default', kind: 'value', lexicalOccurrences: null });
    }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
        node.type === 'ExportNamedDeclaration' && node.source) {
      if (node.source) item.staticModules.push({ specifier: node.source.value, typeOnly: node.importKind === 'type' ||
        node.exportKind === 'type' });
    } else if (node.type === 'ImportExpression') {
      if (node.source?.type === 'StringLiteral') item.dynamicModules.push(node.source.value);
      else item.nonliteralDynamicImports++;
    }
    if (node.type === 'StringLiteral') {
      if (/^research\.[A-Za-z]/u.test(node.value)) item.capabilityStrings.push(node.value);
      if (/^@roc\/plugin-/u.test(node.value)) item.pluginIdentityStrings.push(node.value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'extra' || key === 'comments') continue;
      if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === 'object' && typeof value.type === 'string') pending.push(value);
    }
  }
  item.capabilityStrings = [...new Set(item.capabilityStrings)].sort();
  item.pluginIdentityStrings = [...new Set(item.pluginIdentityStrings)].sort();
  modules.push(item);
}
const candidates = modules.flatMap(item => item.exports.filter(value =>
  value.kind === 'value' && value.lexicalOccurrences !== null && value.lexicalOccurrences <= 1)
  .map(value => ({ path: item.path, ...value })));
const summary = {
  schemaVersion: 1, gitSha: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
  sourceSha256: sha256(JSON.stringify(modules.map(({ path, sha256 }) => ({ path, sha256 })))),
  textFilesScanned: paths.length,
  areas: areas.map(area => {
    const selected = modules.filter(item => item.area === area);
    return {
      area, modules: selected.length,
      valueExports: selected.reduce((sum, item) => sum + item.exports.filter(value => value.kind === 'value').length, 0),
      typeExports: selected.reduce((sum, item) => sum + item.exports.filter(value => value.kind === 'type').length, 0),
      staticModuleReferences: selected.reduce((sum, item) => sum + item.staticModules.length, 0),
      literalDynamicImports: selected.reduce((sum, item) => sum + item.dynamicModules.length, 0),
      nonliteralDynamicImports: selected.reduce((sum, item) => sum + item.nonliteralDynamicImports, 0),
      distinctCapabilityOrEventStrings: new Set(selected.flatMap(item => item.capabilityStrings)).size
    };
  }),
  singleOccurrenceValueExportCandidates: candidates,
  generatedIpc: { path: 'src/shared/ipc-generated.ts', verification: 'pnpm check:ipc' },
  rawInventory: rawOutput.slice(resolve('.').length + 1),
  limitations: [
    'This inventories AST exports, module references and runtime strings; lexical occurrence counts include tests, tooling, docs and local references.',
    'An occurrence does not establish reachability. No candidate alone authorizes deleting a symbol, a platform branch or a persisted schema.',
    'Dynamic imports, generated IPC, manifests, packaging/runtime entries and supported persisted versions require their own checks before removal.'
  ]
};
mkdirSync(dirname(resolve(output)), { recursive: true });
mkdirSync(dirname(rawOutput), { recursive: true });
writeFileSync(rawOutput, `${JSON.stringify(modules, null, 2)}\n`);
writeFileSync(resolve(output), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
