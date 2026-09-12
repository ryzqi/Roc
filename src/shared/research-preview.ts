import type { ResearchTemplate } from './types/research';

export function researchTemplatePreviewUrl(template: Pick<ResearchTemplate, 'projectId' | 'id' | 'pdfPath' | 'pdfHash'>): string | null {
  if (template.pdfPath === null || template.pdfHash === null) return null;
  return `roc-preview://research/templates/${encodeURIComponent(template.projectId)}/${encodeURIComponent(template.id)}/${template.pdfHash}.pdf`;
}

export function researchDocumentSourceUrl(document: { id: string; sourceHash: string }): string {
  return `roc-preview://research/documents/${encodeURIComponent(document.id)}/source/${document.sourceHash}`;
}

export function researchDocumentAssetUrl(documentId: string, parseId: string, asset: { id: string; sha256: string }): string {
  return `roc-preview://research/documents/${encodeURIComponent(documentId)}/parses/${encodeURIComponent(parseId)}/${encodeURIComponent(asset.id)}/${asset.sha256}.png`;
}

export function researchIndexedSourceUrl(source: { projectId: string; fileId: string; sourceHash: string }): string {
  return `roc-preview://research/project-files/${encodeURIComponent(source.projectId)}/${encodeURIComponent(source.fileId)}/${source.sourceHash}`;
}

export function researchExperimentSourceUrl(projectId: string, runId: string, file: { area: string; path: string; sha256: string }): string {
  return `roc-preview://research/experiments/${encodeURIComponent(projectId)}/${encodeURIComponent(runId)}/${file.area}/${encodeURIComponent(file.path)}/${file.sha256}`;
}
