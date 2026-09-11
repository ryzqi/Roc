import type { ResearchTemplate } from './types/research';

export function researchTemplatePreviewUrl(template: Pick<ResearchTemplate, 'projectId' | 'id' | 'pdfPath' | 'pdfHash'>): string | null {
  if (template.pdfPath === null || template.pdfHash === null) return null;
  return `roc-preview://research/templates/${encodeURIComponent(template.projectId)}/${encodeURIComponent(template.id)}/${template.pdfHash}.pdf`;
}
