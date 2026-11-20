import {diagramSourceLimit, validateDiagramSource} from '../../shared/research-diagram-policy';

// A private rendering entry, with no application shell, preload or native bridge.
Object.assign(window, {rocRenderDiagram: async (source: string, sourceHash: string) => {
  validateDiagramSource(source);
  const {default: mermaid} = await import('mermaid');
  mermaid.initialize({startOnLoad: false, securityLevel: 'strict', theme: 'default', htmlLabels: false,
    deterministicIds: true, deterministicIDSeed: sourceHash, maxTextSize: diagramSourceLimit, maxEdges: 500,
    flowchart: {htmlLabels: false}, fontFamily: 'Arial, sans-serif',
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart']});
  const {svg} = await mermaid.render('rocDiagram', source);
  if (svg.length > 4 * 1024 * 1024) throw new Error('research_diagram_output_limit');
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (document.querySelector('parsererror, script, foreignObject, image, a, iframe, object, embed')) throw new Error('research_diagram_unsafe_svg');
  for (const node of document.querySelectorAll('*')) for (const attribute of node.attributes) {
    if (/^on/iu.test(attribute.name) || /(?:href|src)$/iu.test(attribute.name) && !attribute.value.startsWith('#')) throw new Error('research_diagram_unsafe_svg');
  }
  if (/@import|url\(\s*['"]?(?!#)/iu.test(document.documentElement.textContent ?? '')) throw new Error('research_diagram_unsafe_svg');
  const viewBox = document.documentElement.getAttribute('viewBox')?.split(/[\s,]+/u).map(Number);
  if (!viewBox || viewBox.length !== 4) throw new Error('research_diagram_dimensions');
  const width = Math.ceil(viewBox[2]), height = Math.ceil(viewBox[3]);
  if (!Number.isFinite(width * height) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 12_000_000) throw new Error('research_diagram_dimensions');
  document.documentElement.setAttribute('width', String(width)); document.documentElement.setAttribute('height', String(height));
  document.documentElement.setAttribute('style', 'display:block');
  const clean = new XMLSerializer().serializeToString(document.documentElement);
  window.document.body.style.cssText = 'margin:0;background:white;';
  window.document.getElementById('diagram')!.innerHTML = clean;
  await window.document.fonts.ready;
  return {svg: clean, width, height};
}});
