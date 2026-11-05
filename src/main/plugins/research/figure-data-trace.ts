import {createHash} from 'node:crypto';
import {researchFigureDataTraceSchema, type ResearchFigureDataTrace} from '../../../shared/schemas/research-figure-data';
import {ResearchProcessError} from './process-runner';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(code: string): never {throw new ResearchProcessError(code);}

/** Capture final data attached to emitted scene items, after Vega's transforms. */
export function collectFigureDataTrace(compiledSpec: unknown, scenegraph: unknown, sourceHash: string,
  rendererHash: string): ResearchFigureDataTrace {
  const definitions = new Map<string, ResearchFigureDataTrace['marks'][number]>();
  const collectDefinitions = (scope: unknown, depth: number): void => {
    if (depth > 64 || !object(scope)) fail('research_figure_data_trace_invalid');
    if (!Object.hasOwn(scope, 'marks')) return;
    if (!Array.isArray(scope.marks)) fail('research_figure_data_trace_invalid');
    for (const mark of scope.marks) {
      if (!object(mark) || typeof mark.type !== 'string') fail('research_figure_data_trace_invalid');
      if (mark.type === 'group') {collectDefinitions(mark, depth + 1); continue;}
      if (typeof mark.name !== 'string' || definitions.has(mark.name)) fail('research_figure_data_mark_ambiguous');
      if (!object(mark.encode)) fail('research_figure_data_trace_invalid');
      const directFields: Record<string, string> = {}, constantChannels: string[] = [], unsupportedChannels: string[] = [];
      const enter = object(mark.encode.enter) ? mark.encode.enter : {};
      const update = object(mark.encode.update) ? mark.encode.update : {};
      for (const [channel, ref] of Object.entries({...enter, ...update})) {
        // Conditional, expression and nested-path encodings remain explicit for human review.
        if (object(ref) && typeof ref.field === 'string' && !/[.[\]\\]/u.test(ref.field) &&
          !Object.hasOwn(ref, 'signal') && !Object.hasOwn(ref, 'test')) directFields[channel] = ref.field;
        else if (object(ref) && Object.hasOwn(ref, 'value') && !Object.hasOwn(ref, 'signal') && !Object.hasOwn(ref, 'field')) {
          constantChannels.push(channel);
        } else unsupportedChannels.push(channel);
      }
      definitions.set(mark.name, {name: mark.name, markType: mark.type, encoding: JSON.stringify(mark.encode),
        directFields, constantChannels, unsupportedChannels, items: []});
      if (definitions.size > 1000) fail('research_figure_data_mark_limit');
    }
  };
  collectDefinitions(compiledSpec, 0);
  if (!object(scenegraph) || !object(scenegraph.root)) fail('research_figure_data_trace_invalid');
  let itemCount = 0;
  const visit = (mark: unknown, path: number[]): void => {
    if (!object(mark) || !Array.isArray(mark.items) || path.length > 126) fail('research_figure_data_trace_invalid');
    const definition = typeof mark.name === 'string' ? definitions.get(mark.name) : undefined;
    if (mark.marktype !== 'group' && mark.role === 'mark' && definition === undefined) fail('research_figure_data_mark_ambiguous');
    if (definition !== undefined && definition.markType !== mark.marktype) fail('research_figure_data_trace_invalid');
    for (let index = 0; index < mark.items.length; index++) {
      const item = mark.items[index], scenePath = [...path, index];
      if (!object(item)) fail('research_figure_data_trace_invalid');
      if (++itemCount > 100_000) fail('research_figure_data_item_limit');
      if (mark.marktype === 'group') {
        if (!Array.isArray(item.items)) fail('research_figure_data_trace_invalid');
        item.items.forEach((child, position) => visit(child, [...scenePath, position]));
      } else if (definition !== undefined) {
        if (!object(item.datum)) fail('research_figure_data_trace_invalid');
        const numericFields: Record<string, number> = {}, unavailableFields: string[] = [];
        for (const [field, value] of Object.entries(item.datum)) {
          if (typeof value !== 'number') continue;
          if (Number.isFinite(value)) numericFields[field] = value;
          else unavailableFields.push(field);
        }
        definition.items.push({scenePath, numericFields, unavailableFields,
          opacity: typeof item.opacity === 'number' ? item.opacity : null});
      }
    }
  };
  visit(scenegraph.root, []);
  return researchFigureDataTraceSchema.parse({schemaVersion: 1, sourceHash, rendererHash,
    compiledSpecHash: createHash('sha256').update(JSON.stringify(compiledSpec)).digest('hex'),
    marks: [...definitions.values()]});
}
