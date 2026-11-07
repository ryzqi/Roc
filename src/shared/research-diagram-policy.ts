export const diagramRendererVersion = 'mermaid-12.3.0/roc-v1';
export const diagramSourceLimit = 50_000;
export function validateDiagramSource(source: string): void {
  if (!source.trim() || source.length > diagramSourceLimit || /\u0000/u.test(source)) throw new Error('research_diagram_source_limit');
  if (!/^\s*(?:flowchart\b|graph\b|sequenceDiagram\b|stateDiagram-v2\b|classDiagram\b|erDiagram\b)/u.test(source)) throw new Error('research_diagram_type_unsupported');
  // Configuration, interactions, HTML, external images/fonts and CSS URLs are outside this static format.
  if (/%%\s*\{|^\s*---|\b(?:click|href|callback|image|icon)\b|<|>|(?:https?|file|data|javascript):|@import|url\s*\(/imu.test(source.replace(/-->|==>|->>|-->>|->|<--|<->|<\|--|--\|>/gu, ''))) {
    throw new Error('research_diagram_unsafe_source');
  }
}
