import {parse} from '@babel/parser';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {Plugin} from 'vite';
import {packageNameFromModuleId} from './renderer-chunk-metadata';

const mermaidVersion = '12.3.0';
const elkWorkerModule = '\0roc-mermaid-elk-worker';
// These are the default renderers for the formats accepted by
// src/shared/research-diagram-policy.ts. Keep both flowchart and graph syntax.
const supportedDetectors = new Set([
  'classDetector_V2_default',
  'erDetector_default',
  'sequenceDetector_default',
  'flowDetector_v2_default',
  'stateDetector_V2_default'
]);

type SyntaxNode = {type: string; start: number; end: number} & Record<string, unknown>;
type Edit = {start: number; end: number; text: string};

function isNode(value: unknown): value is SyntaxNode {
  return typeof value === 'object' && value !== null &&
    'type' in value && typeof value.type === 'string' &&
    'start' in value && typeof value.start === 'number' &&
    'end' in value && typeof value.end === 'number';
}

function visit(value: unknown, visitor: (node: SyntaxNode) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) visit(child, visitor);
  } else if (isNode(value)) {
    visitor(value);
    for (const child of Object.values(value)) {
      if (typeof child === 'object' && child !== null) visit(child, visitor);
    }
  }
}

function calls(node: SyntaxNode, name: string): boolean {
  return node.type === 'CallExpression' && isNode(node.callee) &&
    node.callee.type === 'Identifier' && node.callee.name === name;
}

function contractError(detail: string): never {
  throw new Error(`roc_mermaid_build_contract_changed:${detail}: review Mermaid pruning and run the diagram runtime test`);
}

function initializer(syntax: unknown, name: string): SyntaxNode {
  let scope: unknown;
  let scopes = 0;
  visit(syntax, node => {
    if (node.type === 'VariableDeclarator' && isNode(node.id) &&
        node.id.type === 'Identifier' && node.id.name === name) {
      scopes++;
      scope = node.init;
    }
  });
  if (scopes !== 1 || !isNode(scope)) contractError(`${name}_scope`);
  return scope;
}

function layoutName(node: SyntaxNode): string | undefined {
  if (node.type !== 'ObjectExpression' || !Array.isArray(node.properties)) return undefined;
  for (const property of node.properties as unknown[]) {
    if (isNode(property) && property.type === 'ObjectProperty' && isNode(property.key) &&
        property.key.type === 'Identifier' && property.key.name === 'name' &&
        isNode(property.value) && property.value.type === 'StringLiteral' &&
        typeof property.value.value === 'string') {
      return property.value.value;
    }
  }
  return undefined;
}

/**
 * The private diagram worker is Mermaid's only application consumer. The npm
 * distribution registers every diagram and layout, even those our policy
 * rejects, retaining an indivisible Langium parser and ELK bundle.
 *
 * Prune unsupported diagram and Cose registrations before tree shaking. Keep
 * Mermaid's default ELK layout, using its official API and a local, prebuilt
 * Worker asset instead of rebundling the engine into a renderer chunk.
 *
 * Do not patch node_modules or replace renderers/layouts.
 * Version and AST checks deliberately fail on an incompatible dependency update.
 */
export function mermaidDiagramBuild(): Plugin {
  let diagramsPruned = false;
  let layoutsPruned = false;
  let elkWorkerUsed = false;
  let elkApiPath = '';
  let elkWorkerPath = '';
  let elkWorkerSource = '';
  return {
    name: 'roc-mermaid-diagram-build',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      diagramsPruned = false;
      layoutsPruned = false;
      elkWorkerUsed = false;
      const require = createRequire(import.meta.url);
      const packagePath = require.resolve('mermaid/package.json');
      const metadata: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
      const version = typeof metadata === 'object' && metadata !== null && 'version' in metadata ? metadata.version : undefined;
      if (version !== mermaidVersion) contractError(`version:${String(version)}:expected:${mermaidVersion}`);
      const mermaidRequire = createRequire(packagePath);
      elkApiPath = mermaidRequire.resolve('elkjs/lib/elk-api.js').replaceAll('\\', '/');
      elkWorkerPath = mermaidRequire.resolve('elkjs/lib/elk-worker.min.js').replaceAll('\\', '/');
      elkWorkerSource = readFileSync(elkWorkerPath, 'utf8');
    },
    resolveId(source, importer) {
      if (source === 'elkjs/lib/elk.bundled.js' && packageNameFromModuleId(importer ?? '') === 'mermaid') {
        elkWorkerUsed = true;
        return elkWorkerModule;
      }
      return null;
    },
    load(id) {
      if (id !== elkWorkerModule) return null;
      // ELK accepts a JSON graph. Mermaid adds renderer-only shape functions,
      // which cannot cross a real Worker's structured-clone boundary.
      return `import ELK from ${JSON.stringify(elkApiPath)};
import workerUrl from ${JSON.stringify(`${elkWorkerPath}?url`)};
export default class WorkerELK extends ELK {
  constructor(options = {}) { super({...options, workerUrl}); }
  layout(graph, options) {
    return super.layout(JSON.parse(JSON.stringify(graph)), options);
  }
}`;
    },
    transform(code, id) {
      if (packageNameFromModuleId(id) !== 'mermaid') return null;
      const normalized = id.replaceAll('\\', '/');
      const diagramRegistry = normalized.endsWith('/dist/mermaid.core.mjs');
      const layoutRegistry = normalized.includes('/dist/chunks/mermaid.core/') &&
        code.includes('"registerDefaultLayoutLoaders"');
      if (!diagramRegistry && !layoutRegistry) return null;

      const edits: Edit[] = [];
      let registrations = 0;
      const syntax = parse(code, {sourceType: 'module'});
      if (diagramRegistry) {
        const retained = new Set<string>();
        // External diagram registration also calls registerLazyLoadedDiagrams;
        // preserve that API and prune only the built-in addDiagrams initializer.
        visit(initializer(syntax, 'addDiagrams'), node => {
          if (calls(node, 'registerLazyLoadedDiagrams')) {
            registrations++;
            if (!Array.isArray(node.arguments)) contractError('diagram_arguments');
            const argumentsToKeep: string[] = [];
            for (const argument of node.arguments as unknown[]) {
              if (!isNode(argument) || argument.type !== 'Identifier' || typeof argument.name !== 'string') {
                contractError('diagram_detector');
              }
              if (supportedDetectors.has(argument.name)) {
                if (retained.has(argument.name)) contractError(`duplicate_detector:${argument.name}`);
                retained.add(argument.name);
                argumentsToKeep.push(argument.name);
              }
            }
            edits.push({start: node.start, end: node.end,
              text: argumentsToKeep.length ? `registerLazyLoadedDiagrams(${argumentsToKeep.join(', ')})` : 'void 0'});
          }
        });
        if (registrations !== 2 || retained.size !== supportedDetectors.size) contractError('supported_diagram_registrations');
        diagramsPruned = true;
      } else {
        const names = new Set<string>();
        let elkLoaders = 0;
        visit(initializer(syntax, 'registerDefaultLayoutLoaders'), node => {
          if (!calls(node, 'registerLayoutLoaders')) return;
          registrations++;
          if (!Array.isArray(node.arguments) || node.arguments.length !== 1) contractError('layout_arguments');
          visit(node.arguments[0], child => {
            const name = layoutName(child);
            if (name !== undefined) {
              if (names.has(name)) contractError(`duplicate_layout:${name}`);
              names.add(name);
            }
            if (calls(child, 'elkLayoutLoaders')) elkLoaders++;
            if (child.type !== 'ArrayExpression' || !Array.isArray(child.elements)) return;
            const elements: SyntaxNode[] = [];
            for (const element of child.elements as unknown[]) {
              if (!isNode(element)) contractError('layout_element');
              elements.push(element);
            }
            if (!elements.some(element => layoutName(element) === 'cose-bilkent')) return;
            // Cose is used by unsupported diagram formats, including mindmap. Keep
            // the ELK spread and the default Dagre/swimlane loaders intact.
            edits.push({start: child.start, end: child.end, text: `[${elements
              .filter(element => layoutName(element) !== 'cose-bilkent')
              .map(element => code.slice(element.start, element.end)).join(', ')}]`});
          });
        });
        if (registrations !== 1 || edits.length !== 1 || elkLoaders !== 1 || names.size !== 3 ||
            !['dagre', 'swimlane', 'cose-bilkent'].every(name => names.has(name))) {
          contractError('default_layout_registrations');
        }
        layoutsPruned = true;
      }
      let result = code;
      for (const edit of edits.sort((a, b) => b.start - a.start)) {
        result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      }
      return {code: result, map: null};
    },
    buildEnd(error) {
      if (!error && (!diagramsPruned || !layoutsPruned || !elkWorkerUsed)) contractError('registration_module_missing');
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        for (const [id, module] of Object.entries(item.modules)) {
          const normalized = id.replaceAll('\\', '/');
          if (module.renderedLength > 0 && packageNameFromModuleId(id) === 'elkjs' &&
              !normalized.includes('/lib/elk-api.js') && normalized !== `${elkWorkerPath}?url`) {
            contractError(`elk_engine_in_chunk:${item.fileName}:${id}`);
          }
        }
      }
      const workerAsset = Object.values(bundle).find(item => item.type === 'asset' &&
        (typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8')) === elkWorkerSource);
      if (workerAsset === undefined) contractError('elk_worker_asset_missing');
      this.emitFile({
        type: 'asset',
        fileName: '.vite/diagram-worker-assets.json',
        source: JSON.stringify({version: 1, assets: {
          [workerAsset.fileName]: {
            kind: 'elk',
            bytes: Buffer.byteLength(elkWorkerSource),
            sha256: createHash('sha256').update(elkWorkerSource).digest('hex')
          }
        }})
      });
    }
  };
}
