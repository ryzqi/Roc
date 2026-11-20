import type {ResearchProductionInput} from '../../../shared/schemas/research-production-inputs';

export function FigureSourceView({source}: {source: Extract<ResearchProductionInput['source'],{kind:'figure'}>}): React.JSX.Element {
  const figure=source.figure,options=figure.validation.options;
  return <section className="flex flex-col gap-2" data-testid="artifact-production-figure">
    <h2 className="font-medium">图稿发布来源</h2>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
      <dt>图稿标识</dt><dd className="break-all">{figure.id}</dd>
      <dt>执行标识</dt><dd className="break-all">{source.execution.id}</dd>
      <dt>源文件</dt><dd className="break-all">{figure.sourcePath}</dd>
      <dt>物理尺寸</dt><dd>{options.widthInches} × {options.heightInches} in <span className="ml-2">{options.dpi} DPI</span></dd>
      <dt>像素尺寸</dt><dd>{figure.validation.widthPixels} × {figure.validation.heightPixels} px</dd>
      <dt>随机种子</dt><dd>{options.seed}</dd>
      <dt>发布清单 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]">{figure.manifestHash}</dd>
      <dt>渲染器 SHA-256</dt><dd className="break-all font-mono text-[length:var(--font-meta-size)]">{figure.validation.rendererHash}</dd>
    </dl>
  </section>;
}
