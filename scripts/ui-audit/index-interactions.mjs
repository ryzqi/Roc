#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { parse as parseCsv } from 'csv-parse/sync';

const root = fileURLToPath(new URL('../../', import.meta.url));
const destination = path.join(root, 'docs/ux-motion/interaction-matrix.csv');
const flags = process.argv.slice(2);
const surfaceFlag = flags.find(flag => flag.startsWith('--surface='));
const mode = flags.find(flag => !flag.startsWith('--surface=')) ?? 'summary';
if (flags.some(flag => !['--write', '--check', '--list'].includes(flag) && !flag.startsWith('--surface='))
  || flags.filter(flag => !flag.startsWith('--surface=')).length > 1
  || flags.filter(flag => flag.startsWith('--surface=')).length > 1
  || (surfaceFlag && mode !== '--list')) {
  throw new Error('Usage: node scripts/ui-audit/index-interactions.mjs [--write | --check | --list [--surface=Sxx]]');
}

// Index source templates, including shared controls at their use sites. These
// counts cannot describe runtime cardinality, visibility or verified UX.
const controls = new Set([
  'button', 'details', 'summary', 'dialog', 'select', 'input', 'textarea', 'a',
  'ActionButton', 'PageListRow', 'TextField', 'NumberField', 'CheckboxField',
  'SelectField', 'ActionStatus', 'TransientStatus', 'ModalShell', 'ConfirmDialog', 'Dialog.Root', 'Dialog.Trigger',
  'Dialog.Close', 'Dialog.Content'
]);
const families = [
  [/\/app\/WorkspaceLayout\.tsx$/, 'S01', 'shell', 'F01', 'P0', 'P3'],
  [/\/shell\/ResizableDivider\.tsx$/, 'S02', 'splitter', 'F02;F14', 'P0', 'P3'],
  [/\/shell\/WindowChrome\.tsx$/, 'S03', 'titlebar', 'F05;F17', 'P1', 'P0;P1;P3'],
  [/\/(AppNavigation|ActivityRail|ContextDrawer|WorkspaceCanvas)\.tsx$/, 'S04', 'navigation', 'F03;F04', 'P1', 'P3'],
  [/\/shell\/SearchPaletteModal\.tsx$/, 'S05', 'search-palette', '', 'P1', 'P3'],
  [/\/(?:shell\/|app\/OverlayHost\.tsx$)/, 'S06', 'shared-overlays', 'F14', 'P1', 'P2;P3'],
  [/\/project\/ProjectFormDialog\.tsx$/, 'S07', 'project-form', 'F06', 'P1', 'P1'],
  [/\/project\/(ProjectPortalView|ProjectRow)\.tsx$/, 'S08', 'project-portal', 'F12', 'P1', 'P1;P3'],
  [/\/project\//, 'S09', 'project-overview', '', 'P1', 'P4;P5'],
  [/\/literature\/(?:ImportDialog|literature-editor-guard)\.tsx$/, 'S10', 'literature-import', 'F07', 'P0', 'P1;P5'],
  [/\/literature\/Zotero/, 'S11', 'zotero', 'F09', 'P1', 'P1;P5'],
  [/\/literature\/(Discovery|AcademicRadar|Radar|ReadingDiscovery|LiteratureCandidate|AcquisitionPreferences|OpenReview|HuggingFace|ResearchResources|Resource)/, 'S12', 'discovery-resources', '', 'P1', 'P5'],
  [/\/literature\/(Library|LiteratureHub)/, 'S13', 'library', '', 'P1', 'P5'],
  [/\/literature\/(LiteratureProcessing|PipelineProgress|KnowledgeJobs)/, 'S14', 'literature-processing', 'F13', 'P1', 'P5'],
  [/\/literature\/(Paper|Pdf|Reading|Reader)/, 'S15', 'reading', '', 'P1', 'P5'],
  [/\/literature\/(Rag|Wiki)/, 'S16', 'rag-wiki', 'F09', 'P1', 'P1;P5'],
  [/\/literature\/(KnowledgeGraph|Graph|Scientific|ClaimComparison|Scholarly)/, 'S17', 'knowledge-evidence', '', 'P1', 'P5'],
  [/\/literature\/Monitor/, 'S18', 'monitors', 'F09', 'P1', 'P1;P5'],
  [/\/latex\//, 'S19', 'writing', '', 'P0', 'P5'],
  [/\/canvas\/files\//, 'S20', 'files', '', 'P1', 'P5'],
  [/\/canvas\/git\//, 'S21', 'git', '', 'P0', 'P5'],
  [/\/canvas\/terminal\//, 'S22', 'terminal', '', 'P1', 'P5'],
  [/\/assistant\/(HitlApprovalDock|blocks\/approval-cards|blocks\/question-card)\.tsx$/, 'S23', 'approval', '', 'P0', 'P4'],
  [/\/assistant\/composer\.tsx$/, 'S24', 'composer', '', 'P0', 'P4'],
  [/\/assistant\/(transcript-panel|blocks\/message-row)\.tsx$/, 'S25', 'transcript', '', 'P1', 'P4'],
  [/\/assistant\/(ResearchTaskProgress|StatusPillHeader)\.tsx$/, 'S26', 'assistant-task', 'F13', 'P0', 'P4'],
  [/\/assistant\//, 'S27', 'assistant-activity', 'F13', 'P1', 'P4'],
  [/\/research\/tasks\//, 'S28', 'research-tasks', 'F10', 'P0', 'P1;P4'],
  [/\/management\//, 'S29', 'management', 'F13', 'P1', 'P4;P5'],
  [/\/settings\/sections\/RagSection\.tsx$/, 'S30', 'rag-settings', 'F08', 'P1', 'P1;P5'],
  [/\/settings\//, 'S31', 'settings', 'F11', 'P0', 'P1;P3;P5'],
  [/\/artifacts\//, 'S32', 'artifacts', '', 'P0', 'P5'],
  [/\/shared\//, 'S33', 'shared-feedback', 'F13;F14', 'P1', 'P2;P5'],
  [/./, 'S34', 'startup-inline-commands', '', 'P1', 'P0;P5']
];
const columns = [
  'issue_id', 'finding_id', 'priority', 'phase', 'contract_id', 'surface',
  'static_template_count', 'source_files_count', 'trigger', 'before', 'pending', 'success',
  'failure', 'cancel_undo', 'repeat_interrupt', 'reduced_motion', 'focus',
  'long_content', 'object_switch', 'known_input', 'source',
  'owner', 'evidence', 'runtime_acceptance', 'baseline_commit', 'source_sha256'
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename)
      : /\.(?:tsx?|jsx?)$/.test(entry.name) ? [filename] : [];
  }));
  return nested.flat().sort();
}

function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') callback(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'tokens', 'comments', 'errors'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(child => visit(child, callback));
    else if (value && typeof value === 'object') visit(value, callback);
  }
}

function jsxName(node) {
  if (node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'JSXMemberExpression') return `${jsxName(node.object)}.${jsxName(node.property)}`;
  return '';
}

function short(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function attributes(opening, source) {
  return Object.fromEntries(opening.attributes
    .filter(attribute => attribute.type === 'JSXAttribute')
    .map(attribute => [jsxName(attribute.name), attribute.value === null
      ? 'true' : short(source.slice(attribute.value.start, attribute.value.end))]));
}

function staticRow({ source, filename, node, control, attrs, kind, label, ordinal, commit, hash }) {
  const [, contract, surface, finding, priority, phase] = families.find(([pattern]) => pattern.test(filename));
  const issueId = `UX-${createHash('sha256').update(`${filename}:${control}:${ordinal}`).digest('hex').slice(0, 10)}`;
  const disclosure = ['details', 'summary'].includes(control);
  const field = ['input', 'textarea', 'select', 'TextField', 'NumberField', 'CheckboxField', 'SelectField'].includes(control);
  const trigger = Object.entries(attrs).filter(([name]) => /^on(?:Click|Change|Submit|Toggle|KeyDown|PointerDown)$/.test(name))
    .map(([name, value]) => `${name}=${value}`).join(';');
  const before = Object.entries(attrs).filter(([name]) =>
    ['open', 'disabled', 'checked', 'value', 'loading', 'aria-current', 'aria-selected', 'aria-pressed'].includes(name))
    .map(([name, value]) => `${name}=${value}`).join(';');
  const pending = Object.entries(attrs).filter(([name]) =>
    ['loading', 'pending', 'disabled', 'aria-busy'].includes(name))
    .map(([name, value]) => `${name}=${value}`).join(';');
  return {
    issue_id: issueId, finding_id: finding, priority, phase, contract_id: contract, surface,
    kind, control, label,
    trigger: short(trigger || (disclosure ? '原生鼠标/键盘披露' : field ? '输入/选择/键盘' : '鼠标/键盘激活')),
    before: short(before || `见 ${contract} before`),
    pending: short(pending || (disclosure || field ? '无异步动作；见所属合同' : `见 ${contract} pending；静态节点未声明`)),
    success: disclosure ? '内容展开/收起，保留业务状态' : field ? '可编辑值/选择立即显示' : `见 ${contract} success`,
    failure: `见 ${contract} failure；不得隐藏错误`,
    cancel_undo: `见 ${contract} cancel/undo；仅按真实能力`,
    repeat_interrupt: disclosure ? '二次操作反向；待运行验证' : `见 ${contract} repeat；待运行验证`,
    reduced_motion: '根 MotionConfig 与 CSS 抑制；信息/焦点等效待验证',
    focus: short(attrs['aria-label'] || attrs.label || `见 ${contract} focus；键盘可达待验证`),
    long_content: `见 ${contract} long-content；待运行验证`,
    object_switch: `见 ${contract} identity；草稿/异步隔离待验证`,
    known_input: short(attrs.value || attrs.projectId || attrs.itemId || attrs.taskId || '所属项目/当前对象由调用者提供'),
    source: filename, line: node.loc.start.line, owner: 'renderer',
    evidence: `AST:${filename}:${node.loc.start.line}；合同见 surface-inventory.md#${contract.toLowerCase()}`,
    runtime_acceptance: '待验证', baseline_commit: commit, source_sha256: hash
  };
}

function csv(rows) {
  const cell = value => `"${String(value).replaceAll('"', '""')}"`;
  return [columns.join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\n') + '\n';
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const files = await sourceFiles(path.join(root, 'src/renderer'));
const routeFile = path.join(root, 'src/shared/surfaces.ts');
const rows = [];
const countByControl = {};
let filesWithControls = 0;
for (const absolute of [...files, routeFile]) {
  const filename = path.relative(root, absolute).split(path.sep).join('/');
  const source = await readFile(absolute, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const ordinals = new Map();
  const beforeCount = rows.length;
  visit(ast, node => {
    if (filename === 'src/renderer/app/routes.ts') {
      const array = node.type === 'VariableDeclarator' && node.id.name === 'APP_VIEWS'
        ? node.init.expression : null;
      const subviews = node.type === 'TSTypeAliasDeclaration' && node.id.name === 'AppSubview'
        ? node.typeAnnotation.types : null;
      const targets = array?.type === 'ArrayExpression' ? array.elements
        : subviews?.map(type => type.literal) ?? [];
      for (const target of targets) {
        if (target.type !== 'StringLiteral') continue;
        const row = staticRow({
          source, filename, node: target, control: 'route', attrs: {},
          kind: array ? 'canonical-view' : 'canonical-subview',
          label: target.value, ordinal: target.value, commit, hash
        });
        for (const key of ['before', 'pending', 'success', 'failure', 'cancel_undo', 'repeat_interrupt', 'focus', 'long_content', 'object_switch']) {
          row[key] = `见 S35 ${key}；实际 canonical route`;
        }
        Object.assign(row, {
          contract_id: 'S35', surface: 'surface-registry', phase: 'P0;P3',
          trigger: `view/subview=${target.value}`,
          evidence: `AST:${filename}:${target.loc.start.line}；合同见 surface-inventory.md#s35`
        });
        rows.push(row);
        countByControl.route = (countByControl.route ?? 0) + 1;
      }
    }
    if (node.type === 'JSXElement') {
      const opening = node.openingElement;
      const name = jsxName(opening.name);
      const attrs = attributes(opening, source);
      const control = /^(?:motion|m)\./.test(name) ? name.split('.').at(-1) : name;
      const interactive = ['onClick', 'onChange', 'onSubmit', 'onPointerDown'].some(attribute => Object.hasOwn(attrs, attribute));
      if (!controls.has(control) && !Object.hasOwn(attrs, 'popover') && attrs.role !== '"dialog"' && !interactive) return;
      const kind = Object.hasOwn(attrs, 'popover') ? 'popover' : attrs.role === '"dialog"' ? 'dialog'
        : !controls.has(control) && interactive ? 'event-control' : 'jsx';
      const ordinal = (ordinals.get(control) ?? 0) + 1;
      ordinals.set(control, ordinal);
      const label = short(attrs['aria-label'] || attrs.label || attrs.title
        || source.slice(opening.end, node.closingElement?.start ?? opening.end));
      rows.push(staticRow({ source, filename, node, control, attrs, kind, label, ordinal, commit, hash }));
      countByControl[control] = (countByControl[control] ?? 0) + 1;
    }
    if (absolute === routeFile && node.type === 'ObjectExpression') {
      const properties = Object.fromEntries(node.properties
        .filter(property => property.type === 'ObjectProperty' && property.key.type === 'Identifier')
        .map(property => [property.key.name, property.value]));
      if (properties.id?.type !== 'StringLiteral' || !properties.canvas || !properties.drawer) return;
      const row = staticRow({
        source, filename, node, control: 'route', attrs: {}, kind: 'surface-registry',
        label: properties.id.value, ordinal: properties.id.value, commit, hash
      });
      Object.assign(row, {
        contract_id: 'S35', surface: 'surface-registry', phase: 'P0;P3',
        trigger: `surface=${properties.id.value}`,
        before: short(source.slice(node.start, node.end)),
        pending: '懒加载目标；旧内容保持至 ready',
        success: '视图/抽屉按注册位置打开',
        failure: '见 S35 failure；未知/parked 不新增路由',
        cancel_undo: '见 S35 cancel/undo；草稿守卫保持',
        repeat_interrupt: '见 S35 repeat；快速切换待验证',
        focus: '导航保持归属；Overlay 使用焦点恢复',
        long_content: '见 S35 long-content；待运行验证',
        object_switch: '见 S35 identity；当前 project 及 target',
        evidence: `AST:${filename}:${node.loc.start.line}；合同见 surface-inventory.md#s35`
      });
      rows.push(row);
      countByControl.route = (countByControl.route ?? 0) + 1;
    }
  });
  if (rows.length > beforeCount) filesWithControls++;
}

const grouped = [...families, [null, 'S35', 'surface-registry', '', 'P1', 'P0;P3']].map(([, id, surface, finding, priority, phase]) => {
  const members = rows.filter(row => row.contract_id === id);
  const locations = [...new Set(members.map(row => row.source))].sort();
  const hashes = [...new Set(members.map(row => `${row.source}:${row.source_sha256}`))].sort();
  return {
    issue_id: `UX-${id}`, finding_id: finding, priority, phase, contract_id: id, surface,
    static_template_count: members.length, source_files_count: locations.length,
    trigger: `见 ${id} trigger；控件事件通过 --list --surface=${id} 查询`,
    before: `见 ${id} before；当前项目/对象/草稿/后端状态`,
    pending: `见 ${id} pending；立即反馈，真实异步状态`,
    success: `见 ${id} success；按真实响应/回执确认`,
    failure: `见 ${id} failure；错误常驻，按能力重试`,
    cancel_undo: `见 ${id} cancel/undo；不虚构可恢复性`,
    repeat_interrupt: `见 ${id} repeat；开关反向、服务动作去重`,
    reduced_motion: '根 MotionConfig/CSS；文字/图标/焦点等效待验证',
    focus: `见 ${id} focus；键盘可达，退出还焦点`,
    long_content: `见 ${id} long-content；滚动/虚拟化/选区优先`,
    object_switch: `见 ${id} identity；草稿与过期异步结果隔离`,
    known_input: `见 ${id}；只派生已知输入，不自动授权副作用`,
    source: locations.join(';'), owner: 'renderer',
    evidence: `AST 模板索引；语义审查见 surface-inventory.md#${id.toLowerCase()}`,
    runtime_acceptance: '待验证', baseline_commit: commit,
    source_sha256: createHash('sha256').update(hashes.join('\n')).digest('hex')
  };
});
const savedRows = (mode === '--write' || mode === '--check') && existsSync(destination)
  ? parseCsv(await readFile(destination, 'utf8'), { columns: true }) : [];
if (mode === '--write') {
  for (const row of grouped) {
    const saved = savedRows.find(candidate => candidate.issue_id === row.issue_id);
    if (saved?.source_sha256 === row.source_sha256) {
      row.evidence = saved.evidence;
      row.runtime_acceptance = saved.runtime_acceptance;
      row.baseline_commit = saved.baseline_commit;
    }
  }
  await writeFile(destination, csv(grouped));
}
if (mode === '--check') {
  const staticColumns = ['issue_id', 'contract_id', 'surface', 'static_template_count', 'source_files_count', 'source', 'source_sha256'];
  const staticValues = entries => entries.map(row => staticColumns.map(column => String(row[column])));
  if (JSON.stringify(staticValues(savedRows)) !== JSON.stringify(staticValues(grouped))) {
    throw new Error('Interaction snapshot differs from current sources. Review changes, then regenerate with --write.');
  }
}
const selectedSurface = surfaceFlag?.slice('--surface='.length);
if (selectedSurface && !grouped.some(row => row.contract_id === selectedSurface)) {
  throw new Error(`Unknown surface contract: ${selectedSurface}`);
}
console.log(JSON.stringify(mode === '--list'
  ? rows.filter(row => !selectedSurface || row.contract_id === selectedSurface)
  : {
  baselineCommit: commit, rendererSourceFiles: files.length, registryFiles: 1,
  filesWithControls, indexedTemplates: rows.length, countByControl,
  countByContract: Object.fromEntries(families.map(([, id]) =>
    [id, rows.filter(row => row.contract_id === id).length]).concat([
    ['S35', rows.filter(row => row.contract_id === 'S35').length]
  ])), snapshot: path.relative(root, destination), semanticContracts: grouped.length, mode
}, null, 2));
