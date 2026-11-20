import type {z} from 'zod';
import type {ResearchJournalSelection, ResearchJournalMaterial, researchJournalCheckSchema} from '../../../shared/schemas/research-journal-compliance';

export function checkJournalCompliance(selection: ResearchJournalSelection, material: ResearchJournalMaterial):
  z.infer<typeof researchJournalCheckSchema>[] {
  const references = [...new Map(material.sources.map(source =>
    [source.bibliography?.itemId ?? source.source.evidence.id, source])).values()];
  return selection.profile.rules.map(rule => {
    let subjects: string[] = [];
    let detail: string;
    let status: 'pass' | 'fail' | 'manual' = 'pass';
    switch (rule.kind) {
      case 'sections':
        subjects = rule.titles.filter(title => !material.manuscript.sections.some(section => section.title === title));
        detail = '按保存小节标题精确匹配；不推断小节内容或语义等价。';
        break;
      case 'reference_count':
        subjects = references.length > rule.maximum ? references.map(source => source.source.evidence.id) : [];
        detail = `保存引用来源去重后 ${references.length} 条，规则上限 ${rule.maximum} 条。`;
        break;
      case 'reference_fields': {
        const unresolved = references.filter(source => source.bibliography === null);
        subjects = references.filter(source => {
          const bibliography = source.bibliography;
          return bibliography !== null && rule.fields.some(field => {
            const value = bibliography.entry[field];
            return value === null || (Array.isArray(value) ? value.length === 0 : String(value).trim().length === 0);
          });
        }).map(source => source.source.evidence.id);
        if (subjects.length === 0 && unresolved.length > 0) {
          status = 'manual';
          subjects = unresolved.map(source => source.source.evidence.id);
        }
        detail = '检查保存的引用元数据字段；无文献元数据的来源须人工核对，不能证明引用样式正确。';
        break;
      }
      case 'figure_files':
        subjects = material.figures.filter(figure => {
          const file = figure.validation.files.find(file => file.path === `figure.${rule.format}`);
          return file === undefined || file.size > rule.maximumBytes ||
            (rule.minimumDpi !== null && (
              figure.validation.widthPixels / (figure.validation.widthPoints / 72) < rule.minimumDpi ||
              figure.validation.heightPixels / (figure.validation.heightPoints / 72) < rule.minimumDpi)) ||
            (rule.maximumWidthPoints !== null && figure.validation.widthPoints > rule.maximumWidthPoints) ||
            (rule.maximumHeightPoints !== null && figure.validation.heightPoints > rule.maximumHeightPoints);
        }).map(figure => figure.id);
        if (material.figures.length === 0) status = 'manual';
        detail = '核对所选真实图稿的格式、字节大小及点尺寸；栅格 DPI 从像素和物理尺寸计算。未选图稿须核对适用性。';
        break;
      case 'supplements':
        subjects = rule.paths.filter(path => !material.supplements.some(file => file.path === path));
        detail = '核对明确选择的项目内补充文件及真实字节；文件存在不证明内容符合投稿要求。';
        break;
      case 'manual':
        status = 'manual';
        detail = '该规则需要人工判断。人工决定单独保存，不替代自动检查结果。';
        break;
      default: {
        const exhaustive: never = rule;
        throw new Error(`research_journal_rule_unsupported:${exhaustive}`);
      }
    }
    if (status === 'pass' && subjects.length > 0) status = 'fail';
    return {ruleId: rule.id, status, subjectIds: subjects, detail};
  });
}
