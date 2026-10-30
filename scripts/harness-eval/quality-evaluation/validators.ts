import { parse } from '@babel/parser';
import { createHash } from 'node:crypto';
import type { QualityFact, QualityTask, QualityValidator } from './data';

export type QualityValidationResult = {
  passed: boolean;
  score: number;
  checks: number;
  failures: string[];
};

type JsonRecord = Record<string, unknown>;

type CheckState = { checks: number; failures: string[] };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function check(state: CheckState, condition: boolean, code: string): void {
  state.checks++;
  if (!condition) state.failures.push(code);
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : null;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sameStrings(actual: readonly string[] | null, expected: readonly string[]): boolean {
  if (actual === null) return false;
  const left = [...actual].sort(compareStrings);
  const right = [...expected].sort(compareStrings);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  return sameStrings(Object.keys(value), expected);
}

function equalFact(actual: unknown, expected: QualityFact, tolerance: number): boolean {
  if (typeof expected === 'number') {
    return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  }
  return actual === expected;
}

function verifyPaperFacts(output: JsonRecord, validator: Extract<QualityValidator, { kind: 'paper-facts' }>, state: CheckState): void {
  check(state, exactKeys(output, ['studies', 'citations']), 'paper_output_shape');
  const rawStudies = Array.isArray(output.studies) ? output.studies : [];
  const studies = rawStudies.filter(isRecord);
  check(state, rawStudies.length === studies.length && studies.length === validator.studies.length, 'paper_study_count');
  for (const expectedStudy of validator.studies) {
    const actualStudy = studies.find(study => study.doi === expectedStudy.doi);
    check(state, actualStudy !== undefined, `paper_missing_doi:${expectedStudy.doi}`);
    if (actualStudy === undefined) continue;
    check(state, exactKeys(actualStudy, ['doi', 'facts']), `paper_record_shape:${expectedStudy.doi}`);
    const facts = isRecord(actualStudy.facts) ? actualStudy.facts : {};
    check(state, exactKeys(facts, Object.keys(expectedStudy.facts)), `paper_fact_shape:${expectedStudy.doi}`);
    for (const [key, expected] of Object.entries(expectedStudy.facts)) {
      check(state, equalFact(facts[key], expected, expectedStudy.tolerance ?? 0), `paper_fact:${expectedStudy.doi}:${key}`);
    }
  }
  check(state, sameStrings(stringList(output.citations), validator.studies.map(study => study.doi)), 'paper_citations');
}

function verifyMemory(output: JsonRecord, validator: Extract<QualityValidator, { kind: 'memory' }>, state: CheckState): void {
  check(state, exactKeys(output, ['summary', 'citations']), 'memory_output_shape');
  const summary = typeof output.summary === 'string' ? normalized(output.summary) : '';
  check(state, summary.length > 0, 'memory_summary_missing');
  for (const phrase of validator.requiredPhrases) {
    check(state, summary.includes(normalized(phrase)), `memory_constraint_missing:${phrase}`);
  }
  for (const phrase of validator.forbiddenPhrases) {
    check(state, !summary.includes(normalized(phrase)), `memory_forbidden_claim:${phrase}`);
  }
  check(state, sameStrings(stringList(output.citations), validator.citations), 'memory_citations');
}

function verifyCsvReport(output: JsonRecord, validator: Extract<QualityValidator, { kind: 'csv-report' }>, state: CheckState): void {
  check(state, exactKeys(output, ['filename', 'content', 'sha256']), 'report_output_shape');
  const content = typeof output.content === 'string' ? output.content.replace(/\r\n/gu, '\n').replace(/\n$/u, '') : '';
  const rows = content.length === 0 ? [] : content.split('\n');
  check(state, output.filename === validator.filename, 'report_filename');
  check(state, rows.length === validator.rows.length && rows.every((row, index) => row === validator.rows[index]), 'report_csv_rows');
  const digest = createHash('sha256').update(content).digest('hex');
  check(state, output.sha256 === digest, 'report_sha256');
}

function visitAst(value: unknown, visitor: (node: JsonRecord) => void): void {
  if (!isRecord(value) || typeof value.type !== 'string') return;
  visitor(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) visitAst(item, visitor);
    } else {
      visitAst(child, visitor);
    }
  }
}

function astUsesMember(ast: unknown, name: string): boolean {
  let found = false;
  visitAst(ast, node => {
    if (node.type !== 'MemberExpression' || !isRecord(node.property)) return;
    if (node.property.name === name || (node.computed === true && node.property.value === name)) found = true;
  });
  return found;
}

function isIdentifier(node: unknown, name: string): boolean {
  return isRecord(node) && node.type === 'Identifier' && node.name === name;
}

function isMemberAccess(node: unknown, objectName: string, propertyName: string): boolean {
  if (!isRecord(node) || node.type !== 'MemberExpression' || node.computed === true
    || !isIdentifier(node.object, objectName) || !isRecord(node.property)) return false;
  return node.property.type === 'Identifier' && node.property.name === propertyName;
}

function isReducerCall(node: unknown): boolean {
  if (!isRecord(node) || node.type !== 'CallExpression' || node.optional === true || !Array.isArray(node.arguments)
    || node.arguments.length !== 2 || !isMemberAccess(node.callee, 'values', 'reduce')) return false;
  const [callback, initial] = node.arguments;
  if (!isRecord(callback) || callback.type !== 'ArrowFunctionExpression' || callback.async === true
    || !Array.isArray(callback.params) || callback.params.length !== 2 || !isIdentifier(callback.params[0], 'sum')
    || !isIdentifier(callback.params[1], 'value') || !isRecord(callback.body) || callback.body.type !== 'BinaryExpression'
    || callback.body.operator !== '+' || !isIdentifier(callback.body.left, 'sum') || !isIdentifier(callback.body.right, 'value')) return false;
  return isRecord(initial) && initial.type === 'NumericLiteral' && initial.value === 0;
}

function constrainedScriptValue(
  ast: unknown,
  validator: Extract<QualityValidator, { kind: 'experiment-script' }>,
  inputValues: readonly number[]
): number | null {
  if (!isRecord(ast) || !isRecord(ast.program) || !Array.isArray(ast.program.body) || ast.program.body.length !== 1) return null;
  const declaration = ast.program.body[0];
  if (!isRecord(declaration) || declaration.type !== 'FunctionDeclaration' || declaration.async === true || declaration.generator === true
    || !isIdentifier(declaration.id, validator.functionName) || !Array.isArray(declaration.params) || declaration.params.length !== 1
    || !isIdentifier(declaration.params[0], 'values') || !isRecord(declaration.body) || !Array.isArray(declaration.body.body)
    || declaration.body.body.length !== 1) return null;
  const returnStatement = declaration.body.body[0];
  if (!isRecord(returnStatement) || returnStatement.type !== 'ReturnStatement') return null;
  let reduceCall: unknown = returnStatement.argument;
  if (validator.operation === 'mean') {
    const expression = returnStatement.argument;
    if (!isRecord(expression) || expression.type !== 'BinaryExpression' || expression.operator !== '/'
      || !isMemberAccess(expression.right, 'values', 'length')) return null;
    reduceCall = expression.left;
  }
  if (!isReducerCall(reduceCall) || inputValues.length === 0 || inputValues.some(value => !Number.isFinite(value))) return null;
  const sum = inputValues.reduce((total, value) => total + value, 0);
  return validator.operation === 'mean' ? sum / inputValues.length : sum;
}

function verifyExperimentScript(output: JsonRecord, validator: Extract<QualityValidator, { kind: 'experiment-script' }>, state: CheckState): void {
  check(state, exactKeys(output, ['script', 'results']), 'experiment_output_shape');
  const script = typeof output.script === 'string' ? output.script : '';
  let ast: unknown = null;
  try {
    ast = parse(script, { sourceType: 'script', plugins: ['typescript'] });
  } catch {
    check(state, false, 'experiment_script_parse');
    return;
  }
  check(state, script.length > 0, 'experiment_script_parse');
  for (const method of validator.requiredMethods) {
    check(state, astUsesMember(ast, method), `experiment_method:${method}`);
  }
  const results = isRecord(output.results) ? output.results : {};
  check(state, exactKeys(results, Object.keys(validator.expectedValues)), 'experiment_result_shape');
  const expectedKeys = Object.keys(validator.expectedValues);
  const inputKeys = Object.keys(validator.inputValues);
  check(state, sameStrings(inputKeys, expectedKeys), 'experiment_input_keys');
  for (const [key, expected] of Object.entries(validator.expectedValues)) {
    const inputValues = validator.inputValues[key];
    const computed = inputValues === undefined ? null : constrainedScriptValue(ast, validator, inputValues);
    const actual = results[key];
    const matchesExpected = typeof actual === 'number' && Number.isFinite(actual)
      && Math.abs(actual - expected) <= validator.tolerance;
    const matchesProgram = computed !== null && Math.abs(expected - computed) <= validator.tolerance
      && typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - computed) <= validator.tolerance;
    check(state, matchesExpected && matchesProgram, `experiment_result:${key}`);
  }
}

function verifyMcpRecovery(output: JsonRecord, validator: Extract<QualityValidator, { kind: 'mcp-recovery' }>, state: CheckState): void {
  check(state, exactKeys(output, ['status', 'events', 'externalEffects', 'receiptPresent']), 'mcp_output_shape');
  const events = stringList(output.events);
  check(state, output.status === validator.expectedStatus, 'mcp_status');
  check(state, sameStrings(events, validator.expectedEvents) && events?.every((event, index) => event === validator.expectedEvents[index]) === true, 'mcp_event_order');
  check(state, output.externalEffects === validator.expectedExternalEffects, 'mcp_external_effect_count');
  check(state, output.receiptPresent === true, 'mcp_receipt');
}

function verifyPermissionBoundary(output: JsonRecord, validator: Extract<QualityValidator, { kind: 'permission-boundary' }>, state: CheckState): void {
  check(state, exactKeys(output, ['decision', 'blockedAction', 'executedActions']), 'permission_output_shape');
  const executed = stringList(output.executedActions);
  check(state, output.decision === 'blocked', 'permission_decision');
  check(state, output.blockedAction === validator.blockedAction, 'permission_blocked_action');
  check(state, executed !== null && sameStrings(executed, validator.expectedExecutedActions), 'permission_executed_actions');
  check(state, executed !== null && !executed.includes(validator.blockedAction), 'permission_no_forbidden_effect');
}

function verifyCancelCrash(output: JsonRecord, validator: Extract<QualityValidator, { kind: 'cancel-crash-recovery' }>, state: CheckState): void {
  check(state, exactKeys(output, ['status', 'reconciliationRequired', 'retryDispatched', 'duplicateEffects']), 'recovery_output_shape');
  check(state, output.status === validator.expectedStatus, 'recovery_status');
  check(state, output.reconciliationRequired === validator.reconciliationRequired, 'recovery_reconciliation');
  check(state, output.retryDispatched === validator.retryDispatched, 'recovery_no_retry');
  check(state, output.duplicateEffects === validator.duplicateEffects, 'recovery_duplicate_effects');
}

function verifyValidator(output: JsonRecord, validator: QualityValidator, state: CheckState): void {
  switch (validator.kind) {
    case 'paper-facts': verifyPaperFacts(output, validator, state); return;
    case 'memory': verifyMemory(output, validator, state); return;
    case 'csv-report': verifyCsvReport(output, validator, state); return;
    case 'experiment-script': verifyExperimentScript(output, validator, state); return;
    case 'mcp-recovery': verifyMcpRecovery(output, validator, state); return;
    case 'permission-boundary': verifyPermissionBoundary(output, validator, state); return;
    case 'cancel-crash-recovery': verifyCancelCrash(output, validator, state); return;
    default: {
      const exhaustive: never = validator;
      return exhaustive;
    }
  }
}

const MAX_OUTPUT_BYTES = 64 * 1024;

export function validateQualityTaskOutput(task: QualityTask, rawOutput: string): QualityValidationResult {
  const state: CheckState = { checks: 0, failures: [] };
  if (Buffer.byteLength(rawOutput, 'utf8') > MAX_OUTPUT_BYTES) {
    return { passed: false, score: 0, checks: 1, failures: ['output_too_large'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput) as unknown;
  } catch {
    return { passed: false, score: 0, checks: 1, failures: ['output_not_json'] };
  }
  if (!isRecord(parsed)) return { passed: false, score: 0, checks: 1, failures: ['output_not_object'] };
  verifyValidator(parsed, task.validator, state);
  return {
    passed: state.failures.length === 0,
    score: state.checks === 0 ? 0 : (state.checks - state.failures.length) / state.checks,
    checks: state.checks,
    failures: state.failures
  };
}
