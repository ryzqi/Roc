import {useState} from 'react';
import type {PaperCardKnowledge} from '../../shared/schemas/research-paper-card-knowledge';
import type {WikiPaperKnowledgeSource} from '../../shared/schemas/research-wiki-pages';
import type {RocClient} from '../shared/roc-client';
import {formSecondaryButtonClass} from '../shared/form-ui';
import {scientificObject, scientificEntityLabels} from './scientific-wiki';
import {ScientificDocumentSource} from './ScientificDocumentSource';

const objectWarningLabels: Readonly<Record<string, string>> = {
  research_table_structure_missing: '未提取到表格结构，请核对原文。',
  research_table_structure_invalid: '表格结构未通过校验，请核对原文。',
  research_table_ragged_grid: '部分表格行列不完整，请核对原文。',
  research_table_cell_coordinates_missing: '未记录单元格精确区域，原文仅定位到页。',
  research_table_cell_coordinates_invalid: '单元格区域未通过校验，原文仅定位到页。',
  research_equation_number_ambiguous: '公式编号存在歧义，请核对原文。',
  research_equation_recognition_missing: '未识别出公式内容，请核对原始图像。',
  research_equation_latex_invalid: '公式 LaTeX 未通过校验，请核对原始图像。',
  research_equation_number_missing: '未记录公式编号。',
  research_visual_number_conflict: '图表编号与图注不一致，关联待核查。',
  research_visual_caption_missing: '未找到关联图注。',
  research_visual_caption_candidate: '图注关联仍为候选，请核对原文。'
};
const objectWarningLabel = (warning: string): string => objectWarningLabels[warning] ?? '此对象还有解析警告，请核对原文。';

export function ScientificObjectView({client, projectId, reference, card, objectId}: {
  client: RocClient; projectId: string; reference: WikiPaperKnowledgeSource;
  card: PaperCardKnowledge; objectId: string
}): React.JSX.Element {
  const [sourceOpen, setSourceOpen] = useState(false);
  const object = scientificObject(card, objectId);
  if (object === null) return <p role="alert">此版本中没有原始对象，请重新核对来源。</p>;
  return <section className="min-w-0 space-y-3" data-testid="wiki-scientific-object">
    <h4 className="font-medium">{scientificEntityLabels[object.kind]}原始记录</h4>
    {object.kind === 'Table' ? <>
      <p className="text-xs text-muted">结构状态：{object.value.data.status === 'parsed' ? '已解析' : object.value.data.status === 'missing' ? '缺失' : '无效'}</p>
      {object.value.data.caption ? <p className="whitespace-pre-wrap break-words">{object.value.data.caption}</p> : null}
      <div className="ui-scroll-region max-h-96" tabIndex={0} aria-label="原始表格完整网格">
        <table className="w-full border-collapse text-left text-xs" data-testid="wiki-scientific-table">
          <caption className="text-left text-muted">{object.value.data.tableNumber ?? '未记录表号'}</caption>
          <tbody>{object.value.data.rows.map(row => <tr key={row.index}>
            {row.cells.map(cell => cell.header ?
              <th key={cell.id} rowSpan={cell.rowSpan} colSpan={cell.colSpan}
                className="whitespace-pre-wrap border-[0.5px] border-line p-2 font-medium">{cell.text}</th> :
              <td key={cell.id} rowSpan={cell.rowSpan} colSpan={cell.colSpan}
                className="whitespace-pre-wrap border-[0.5px] border-line p-2 tabular-nums">{cell.text}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <dl className="space-y-1 text-xs">{object.value.data.columns.map(column => <div key={column.index} className="flex flex-wrap gap-x-2">
        <dt>第 {column.index + 1} 列</dt><dd className="whitespace-pre-wrap break-words">{column.header || '表头未记录'}</dd>
        <dd>单位：{column.unit ?? '未记录'}</dd>
      </div>)}</dl>
      {object.value.data.footnotes.map((note, index) => <p key={index} className="whitespace-pre-wrap break-words text-xs">{note}</p>)}
      {object.value.data.warnings.map((warning, index) => <p key={index} role="note" className="text-xs text-muted">{objectWarningLabel(warning)}</p>)}
      <details><summary className="cursor-pointer text-xs">原始表格 HTML</summary>
        <pre className="ui-scroll-region max-h-60 whitespace-pre-wrap break-words text-xs">{object.value.data.rawHtml ?? '未记录'}</pre>
      </details>
    </> : object.kind === 'Equation' ? <>
      <p className="text-xs text-muted">公式 {object.value.data.equationNumber ?? '未编号'}，{object.value.data.status === 'parsed' ? '已解析' : object.value.data.status === 'missing' ? '缺失' : '无效'}</p>
      <label className="block space-y-1 text-xs"><span>原始 LaTeX</span>
        <pre className="ui-scroll-region max-h-72 whitespace-pre-wrap break-words" data-testid="wiki-scientific-latex">{object.value.data.rawLatex ?? '未记录'}</pre>
      </label>
      <details><summary className="cursor-pointer text-xs">规范化 LaTeX</summary>
        <pre className="ui-scroll-region max-h-60 whitespace-pre-wrap break-words text-xs">{object.value.data.normalizedLatex ?? '未记录'}</pre>
      </details>
      {object.value.data.numberEvidence ? <p className="whitespace-pre-wrap break-words text-xs">编号依据：{
        object.value.data.numberEvidence.kind === 'latex' ? object.value.data.numberEvidence.text : object.value.data.numberEvidence.evidence.text}</p> : null}
      <ObjectPassages title="解释上下文" passages={object.value.data.contexts.map(value => ({text: value.text, locator: value.locator}))}/>
      <ObjectPassages title="公式引用" passages={object.value.data.references.map(value => ({
        text: value.evidence.text, locator: value.evidence.locator, status: value.status === 'linked' ? '已关联' : '候选关联'}))}/>
      <ObjectPassages title="变量定义" passages={object.value.data.variables.map(value => ({
        text: `${value.symbol}: ${value.definition}\n${value.evidence.text}`, locator: value.evidence.locator}))}/>
      {object.value.data.warnings.map((warning, index) => <p key={index} role="note" className="text-xs text-muted">{objectWarningLabel(warning)}</p>)}
    </> : object.kind === 'Figure' ? <>
      <p className="text-xs text-muted">图 {object.value.data.objectNumber ?? '未编号'}</p>
      <ObjectPassages title="图注" passages={object.value.data.captions.map(value => ({
        text: value.evidence.text, locator: value.evidence.locator, status: value.status === 'linked' ? '已关联' : '候选关联'}))}/>
      <ObjectPassages title="图像引用" passages={object.value.data.references.map(value => ({
        text: value.evidence.text, locator: value.evidence.locator, status: value.status === 'linked' ? '已关联' : '候选关联'}))}/>
      {object.value.data.warnings.map((warning, index) => <p key={index} role="note" className="text-xs text-muted">{objectWarningLabel(warning)}</p>)}
    </> : <>
      <p className="whitespace-pre-wrap break-words">{object.value.text}</p>
      <ObjectPassages title="算法步骤" passages={object.value.steps.map(value => ({text: value.text, locator: value.sourceLocator.rawLocator}))}/>
    </>}
    <button type="button" className={formSecondaryButtonClass} aria-expanded={sourceOpen}
      onClick={() => setSourceOpen(value => !value)}>核对原始 PDF 与图像</button>
    {sourceOpen ? <ScientificDocumentSource client={client} projectId={projectId} reference={reference}
      object={{id: object.value.id, objectType: object.kind, locator: object.value.sourceLocator}}/> : null}
  </section>;
}

/** Complete passages are paginated rather than truncated; candidate associations remain explicit. */
function ObjectPassages({title, passages}: {title: string; passages: {text: string; locator: string; status?: string}[]}): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  return <details><summary className="cursor-pointer text-xs">{title}（{passages.length} 条）</summary>
    <ul className="space-y-2 py-2 text-xs">{passages.slice(offset, offset + 10).map((passage, index) => <li key={offset + index}>
      <p className="break-words text-muted">{passage.locator}{passage.status ? `，${passage.status}` : ''}</p>
      <p className="whitespace-pre-wrap break-words">{passage.text}</p>
    </li>)}</ul>
    {passages.length > 10 ? <nav className="flex flex-wrap gap-2" aria-label={`${title}分页`}>
      <button className={formSecondaryButtonClass} disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 10))}>前 10 条</button>
      <button className={formSecondaryButtonClass} disabled={offset + 10 >= passages.length} onClick={() => setOffset(value => value + 10)}>后 10 条</button>
    </nav> : null}
  </details>;
}
