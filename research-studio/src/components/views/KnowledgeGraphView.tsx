import React, { useState, useRef } from 'react';
import { GraphNode, GraphLink } from '../../types/research';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Sparkles,
  Search,
  BookOpen
} from 'lucide-react';

interface KnowledgeGraphViewProps {
  nodes: GraphNode[];
  links: GraphLink[];
  selectedNodeId?: string;
  onSelectNode: (node: GraphNode) => void;
  onExpandGraphWithNode: (node: GraphNode) => void;
}

export const KnowledgeGraphView: React.FC<KnowledgeGraphViewProps> = ({
  nodes,
  links,
  selectedNodeId,
  onSelectNode,
  onExpandGraphWithNode
}) => {
  const [zoom, setZoom] = useState(1);
  const [filterText, setFilterText] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const svgRef = useRef<SVGSVGElement>(null);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0];

  const getCategoryColor = (cat: GraphNode['category']) => {
    switch (cat) {
      case 'model': return '#38bdf8'; // Sky
      case 'method': return '#c084fc'; // Purple
      case 'theory': return '#fbbf24'; // Amber
      case 'dataset': return '#34d399'; // Emerald
      default: return '#94a3b8';
    }
  };

  const filteredNodes = nodes.filter((node) => {
    const matchesText = node.label.toLowerCase().includes(filterText.toLowerCase()) || node.description.toLowerCase().includes(filterText.toLowerCase());
    const matchesCat = activeCategory === 'all' || node.category === activeCategory;
    return matchesText && matchesCat;
  });

  const connectedLinks = links.filter(
    (l) => l.source === selectedNode?.id || l.target === selectedNode?.id
  );

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-zinc-950 text-zinc-100 p-8 text-center space-y-3">
        <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-sky-400">
          <Sparkles size={24} />
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-zinc-200">知识图谱暂无节点</h3>
          <p className="text-xs text-zinc-500 max-w-sm leading-relaxed">
            导入论文文献后，系统将自动抽取算法实体、理论概念与演进关系，在此构建力导向知识拓扑图谱。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-zinc-950 text-zinc-100 overflow-hidden relative select-none">
      {/* Top Floating Controls */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2 bg-zinc-900/90 backdrop-blur-md p-1.5 rounded-xl border border-zinc-800 shadow-md text-xs max-w-[calc(100%-1.5rem)]">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-2 text-zinc-500" />
          <input
            type="text"
            placeholder="搜索..."
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-md pl-7 pr-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 w-28 sm:w-36 transition-colors"
          />
        </div>

        <div className="flex items-center gap-1 border-l border-zinc-800 pl-2 overflow-x-auto no-scrollbar">
          {[
            { id: 'all', label: '全部' },
            { id: 'model', label: '模型' },
            { id: 'method', label: '方法' },
            { id: 'theory', label: '理论' },
            { id: 'dataset', label: '数据' }
          ].map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                activeCategory === cat.id
                  ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5 border-l border-zinc-800 pl-2 shrink-0">
          <button
            onClick={() => setZoom((z) => Math.min(z + 0.15, 2.2))}
            title="放大"
            className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <ZoomIn size={13} />
          </button>
          <button
            onClick={() => setZoom((z) => Math.max(z - 0.15, 0.5))}
            title="缩小"
            className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <ZoomOut size={13} />
          </button>
          <button
            onClick={() => setZoom(1)}
            title="重置"
            className="p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>

      {/* Main SVG Canvas */}
      <div className="flex-1 h-full overflow-hidden flex items-center justify-center cursor-grab active:cursor-grabbing bg-zinc-950">
        <svg
          ref={svgRef}
          viewBox="0 0 600 480"
          className="w-full h-full"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', transition: 'transform 0.15s ease-out' }}
        >
          {/* Subtle Grid dots */}
          <pattern id="dotGridDark" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1" fill="#3f3f46" opacity="0.4" />
          </pattern>
          <rect width="100%" height="100%" fill="url(#dotGridDark)" />

          <defs>
            <marker
              id="arrowheadDark"
              markerWidth="6"
              markerHeight="6"
              refX="16"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 6 3, 0 6" fill="#71717a" />
            </marker>
            <marker
              id="arrowheadHighlight"
              markerWidth="6"
              markerHeight="6"
              refX="16"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 6 3, 0 6" fill="#38bdf8" />
            </marker>
          </defs>

          {/* Render Graph Links */}
          {links.map((link, idx) => {
            const sNode = nodes.find((n) => n.id === link.source);
            const tNode = nodes.find((n) => n.id === link.target);
            if (!sNode || !tNode) return null;
            const isHighlight = selectedNode?.id === sNode.id || selectedNode?.id === tNode.id;

            return (
              <g key={idx}>
                <line
                  x1={sNode.x}
                  y1={sNode.y}
                  x2={tNode.x}
                  y2={tNode.y}
                  stroke={isHighlight ? '#38bdf8' : '#3f3f46'}
                  strokeWidth={isHighlight ? 2 : 1}
                  strokeDasharray={isHighlight ? 'none' : '3 3'}
                  markerEnd={isHighlight ? 'url(#arrowheadHighlight)' : 'url(#arrowheadDark)'}
                  opacity={isHighlight ? 1 : 0.6}
                />
                {isHighlight && (
                  <text
                    x={(sNode.x + tNode.x) / 2}
                    y={(sNode.y + tNode.y) / 2 - 4}
                    fill="#38bdf8"
                    fontSize="9"
                    textAnchor="middle"
                    className="select-none font-mono font-medium"
                  >
                    {link.relationship}
                  </text>
                )}
              </g>
            );
          })}

          {/* Render Graph Nodes */}
          {filteredNodes.map((node) => {
            const isSelected = selectedNode?.id === node.id;
            const color = getCategoryColor(node.category);

            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                onClick={() => onSelectNode(node)}
                className="cursor-pointer transition-all duration-300 group"
              >
                {/* Selection ring */}
                {isSelected && (
                  <circle
                    r={node.val + 7}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeOpacity={0.5}
                  />
                )}

                {/* Node circle */}
                <circle
                  r={node.val}
                  fill={color}
                  stroke="var(--app-zinc-900)"
                  strokeWidth={2}
                  className="transition-transform group-hover:scale-110"
                />

                {/* Node Label */}
                <text
                  y={node.val + 13}
                  fill={isSelected ? 'var(--app-zinc-100)' : 'var(--app-zinc-300)'}
                  fontSize={isSelected ? '11' : '10'}
                  fontWeight={isSelected ? '600' : '500'}
                  textAnchor="middle"
                  className="select-none pointer-events-none font-sans"
                >
                  {node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Right Node Inspector Drawer */}
      {selectedNode && (
        <div className="w-64 sm:w-72 bg-zinc-900/90 backdrop-blur-md border-l border-zinc-800 p-3.5 sm:p-4 flex flex-col justify-between shrink-0 overflow-y-auto">
          <div className="space-y-3.5">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                {selectedNode.category}
              </span>
              <span className="text-[10px] text-zinc-500 font-mono">
                {selectedNode.id}
              </span>
            </div>

            <div>
              <h2 className="text-sm sm:text-base font-semibold text-zinc-100">{selectedNode.label}</h2>
              <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
                {selectedNode.description}
              </p>
            </div>

            {/* Connected Relations */}
            <div className="space-y-1.5 pt-2 border-t border-zinc-800">
              <span className="text-[11px] font-medium text-zinc-400 block">
                关联 ({connectedLinks.length})
              </span>
              <div className="space-y-1 text-xs">
                {connectedLinks.map((link, idx) => {
                  const otherNodeId = link.source === selectedNode.id ? link.target : link.source;
                  const otherNode = nodes.find((n) => n.id === otherNodeId);
                  return (
                    <div
                      key={idx}
                      className="p-1.5 bg-zinc-950 rounded-lg border border-zinc-850 flex items-center justify-between text-[11px]"
                    >
                      <span className="text-sky-400 font-medium truncate pr-2">{otherNode?.label}</span>
                      <span className="text-zinc-500 font-mono text-[10px] shrink-0">{link.relationship}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Referenced Papers */}
            {selectedNode.papers && selectedNode.papers.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t border-zinc-800">
                <span className="text-[11px] font-medium text-zinc-400 block">
                  文献
                </span>
                {selectedNode.papers.map((pId: string) => (
                  <div key={pId} className="flex items-center gap-1.5 text-xs text-purple-400 font-mono bg-purple-950/40 border border-purple-900/60 p-1.5 rounded-lg">
                    <BookOpen size={12} className="shrink-0" />
                    <span className="truncate">arXiv:{pId}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-3 border-t border-zinc-800">
            <button
              onClick={() => onExpandGraphWithNode(selectedNode)}
              className="w-full py-1.5 bg-zinc-100 hover:bg-white text-zinc-950 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors shadow-xs"
            >
              <Sparkles size={12} />
              <span>扩展</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
