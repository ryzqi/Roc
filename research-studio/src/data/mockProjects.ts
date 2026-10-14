import {
  PaperProject,
  ProjectWorkspaceData,
  VirtualFile,
  ResearchPaper,
  ChatSession
} from '../types/research';
import {
  INITIAL_PAPERS,
  INITIAL_GRAPH_NODES,
  INITIAL_GRAPH_LINKS,
  INITIAL_RAG_WIKI,
  INITIAL_FILES,
  INITIAL_COMMITS,
  INITIAL_MEMORIES,
  INITIAL_SKILLS,
  INITIAL_MCP_SERVERS,
  INITIAL_SCHEDULED_TASKS,
  INITIAL_SESSIONS,
  INITIAL_GUARDRAILS,
  INITIAL_TELEMETRY,
  INITIAL_BENCHMARKS
} from './mockResearchData';

export const INITIAL_PROJECTS: PaperProject[] = [
  {
    id: 'proj-reasoning',
    slug: 'Transformer-Reasoning-Distillation',
    title: '基于组相对策略优化(GRPO)的大模型长思维链推理能力蒸馏研究',
    description: '探索在消费级低资源算力下，通过纯强化学习驱动的自反思机制激发 7B/14B 小规模语言模型的深层逻辑推理，并在 AIME/MATH 上实现高准确率蒸馏。',
    field: '强化学习与大模型推理',
    targetVenue: 'NeurIPS 2026',
    status: 'experiment',
    updatedAt: '10 分钟前',
    createdAt: '2026-09-15',
    tags: ['GRPO', 'Reasoning', 'Distillation', 'AIME 2024', 'Self-Reflection'],
    paperCount: 12,
    fileCount: 8,
    wordCount: 8420,
    isStarred: true
  },
  {
    id: 'proj-embodied',
    slug: 'Embodied-Diffusion-Manipulation',
    title: '面向灵巧双臂协作的端到端三维扩散运动策略与触觉力控融合',
    description: '结合多视角点云表示与视觉触觉跨模态感知，采用条件去噪扩散隐空间策略生成高自由度灵巧机械手闭环轨迹。',
    field: '具身智能与机器人学习',
    targetVenue: 'CoRL 2026',
    status: 'drafting',
    updatedAt: '昨天',
    createdAt: '2026-09-28',
    tags: ['Diffusion Policy', 'Robotics', 'Tactile Sensing', 'Bimanual Manipulation'],
    paperCount: 8,
    fileCount: 6,
    wordCount: 4650,
    isStarred: false
  },
  {
    id: 'proj-genomics',
    slug: 'BioMed-Genomic-Pretraining',
    title: '跨组织单细胞转录组与基因调控网络的大规模掩码图预训练基础模型',
    description: '构建覆盖 2000 万人类单细胞图谱的基础模型，结合空间转录组学重构复杂微环境中细胞通讯拓扑与致病靶点筛选。',
    field: '计算生物学与基因组学',
    targetVenue: 'Nature Machine Intelligence',
    status: 'reviewing',
    updatedAt: '3 天前',
    createdAt: '2026-08-10',
    tags: ['Single-Cell', 'Graph Foundation', 'Gene Regulatory', 'Target Discovery'],
    paperCount: 15,
    fileCount: 9,
    wordCount: 11200,
    isStarred: true
  }
];

export const STORAGE_KEY_PROJECTS = 'codex_projects_list';
export const STORAGE_PREFIX_PROJECT_DATA = 'codex_project_data_';

export function loadProjectsFromStorage(): PaperProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROJECTS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('Failed to load projects from localStorage:', err);
  }
  return INITIAL_PROJECTS;
}

export function saveProjectsToStorage(projects: PaperProject[]): void {
  try {
    localStorage.setItem(STORAGE_KEY_PROJECTS, JSON.stringify(projects));
  } catch (err) {
    console.error('Failed to save projects to localStorage:', err);
  }
}

/**
 * Generate starter files for a newly created project
 */
export function createStarterFiles(projectName: string, title: string, field: string): VirtualFile[] {
  return [
    {
      path: 'main.tex',
      name: 'main.tex',
      type: 'tex',
      content: `\\documentclass[11pt,twocolumn]{article}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{cite}
\\usepackage{hyperref}
\\usepackage{booktabs}

\\title{\\textbf{${title}}}
\\author{Research Scholar \\and Autonomous Scientific Agent \\\\ Institute for Frontier Computing}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
本文针对 ${field} 领域面临的关键科学瓶颈展开系统性探索。我们提出了一种创新的研究范式，通过理论推导与大规模实证评测，全面验证了方法的有效性与优越性。
\\end{abstract}

\\section{Introduction (引言)}
在 ${field} 方向的最新发展中，如何构建高效、鲁棒且具备可解释性的系统是一个核心挑战。传统基线方法受限于算力开销与数据泛化能力，难以满足前沿学术标准。

\\section{Methodology (方法设计)}
我们设计了模块化的端到端架构。形式化定义如下：
\\begin{equation}
\\mathcal{L}(\\theta) = \\mathbb{E}_{x \\sim \\mathcal{D}} \\left[ \\| f_\\theta(x) - y \\|^2 \\right] + \\lambda \\mathcal{R}(\\theta)
\\end{equation}

\\section{Experiments and Results (实验分析)}
实验在标准基准集上展开，对比了当前主流 SOTA 方案。

\\section{Conclusion (结论)}
本研究提供了全新的视角与可复现的代码基准，后续工作将进一步拓展到更大规模的验证场景。

\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}`
    },
    {
      path: 'references.bib',
      name: 'references.bib',
      type: 'bib',
      content: `@article{vaswani2017attention,
  title={Attention is all you need},
  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and others},
  journal={Advances in Neural Information Processing Systems},
  volume={30},
  year={2017}
}

@article{foundation2026survey,
  title={A Comprehensive Survey of Frontier AI in Scientific Discovery},
  author={Scholar, Codex and Team, Research},
  journal={arXiv preprint arXiv:2601.00001},
  year={2026}
}`
    },
    {
      path: 'src/train_eval.py',
      name: 'train_eval.py',
      type: 'py',
      content: `import os
import sys
import numpy as np

def run_experiment():
    print("=" * 60)
    print("Initiating ${projectName} Experiment Pipeline...")
    print("Domain: ${field}")
    print("=" * 60)
    
    epochs = 10
    for epoch in range(1, epochs + 1):
        loss = 1.0 / (epoch + 1) + np.random.normal(0, 0.02)
        acc = min(0.98, 0.65 + 0.03 * epoch + np.random.normal(0, 0.01))
        print(f"[Epoch {epoch:02d}/{epochs:02d}] Loss: {max(0.01, loss):.4f} | Acc: {acc*100:.2f}% | Evaluated")
    
    print("\nExperiment completed successfully. Benchmark weights saved.")

if __name__ == "__main__":
    run_experiment()`
    },
    {
      path: 'docs/research_notes.md',
      name: 'research_notes.md',
      type: 'md',
      content: `# ${title}

- **项目标识**: \`${projectName}\`
- **学科领域**: ${field}
- **创建时间**: ${new Date().toLocaleDateString()}

## 待办与里程碑
- [x] 构建 LaTeX 论文初稿框架
- [ ] 检索并整理近三年 10+ 篇顶级期刊相关文献
- [ ] 编写核心实验评测与消融实验代码
- [ ] 生成高分辨率图表与消融对比图
`
    }
  ];
}

/**
 * Creates or retrieves initial isolated workspace data for a project
 */
export function getInitialProjectData(project: PaperProject): ProjectWorkspaceData {
  // If it's the primary reasoning project, initialize with the comprehensive preset data
  if (project.id === 'proj-reasoning') {
    return {
      papers: INITIAL_PAPERS,
      activePaperId: INITIAL_PAPERS[0]?.id,
      files: INITIAL_FILES,
      activeFilePath: 'main.tex',
      gitCommits: INITIAL_COMMITS,
      wikiEntries: INITIAL_RAG_WIKI,
      graphNodes: INITIAL_GRAPH_NODES,
      graphLinks: INITIAL_GRAPH_LINKS,
      selectedGraphNodeId: 'deepseek-r1',
      memories: INITIAL_MEMORIES,
      skills: INITIAL_SKILLS,
      mcpServers: INITIAL_MCP_SERVERS,
      scheduledTasks: INITIAL_SCHEDULED_TASKS,
      guardrails: INITIAL_GUARDRAILS,
      telemetry: INITIAL_TELEMETRY,
      benchmarks: INITIAL_BENCHMARKS,
      sessions: INITIAL_SESSIONS,
      activeSessionId: INITIAL_SESSIONS[0]?.id || 's-1'
    };
  }

  // If it's the embodied project
  if (project.id === 'proj-embodied') {
    const embodiedPaper: ResearchPaper = {
      id: 'paper-embodied-1',
      arxivId: '2403.01234',
      title: 'Diffusion Policy: Visuomotor Policy Learning via Action Diffusion',
      authors: ['Cheng Chi', 'Siyuan Feng', 'Yilun Du', 'Zhenjia Xu', 'Eric Cousineau', 'Benjamin Burchfiel', 'Shuran Song'],
      year: 2024,
      conference: 'RSS 2024 (Best Paper)',
      citations: 620,
      version: 'v3',
      fileType: 'pdf',
      abstract: 'We present Diffusion Policy, a new way of generating robot behaviors by representing a visuomotor policy as a conditional denoising diffusion process on robot action space. Diffusion Policy handles multimodal action distributions, high-dimensional action spaces, and graceful degradation.',
      tldr: '将扩散生成模型引入机械臂视觉运动控制，有效表达多峰动作分布并具备出色平滑性与稳定性。',
      tags: ['Diffusion Policy', 'Visuomotor', 'Robotics', 'Action Denoising'],
      pdfUrl: 'https://arxiv.org/pdf/2303.04137.pdf',
      bibtex: `@article{chi2023diffusionpolicy,
  title={Diffusion Policy: Visuomotor Policy Learning via Action Diffusion},
  author={Chi, Cheng and Feng, Siyuan and Du, Yilun and others},
  journal={arXiv preprint arXiv:2303.04137},
  year={2023}
}`,
      keyFormulas: [
        {
          name: '动作去噪扩散目标函数',
          latex: '\\mathcal{L}_{\\text{diff}}(\\theta) = \\mathbb{E}_{k, \\mathbf{a}_0, \\boldsymbol{\\epsilon}, \\mathbf{O}} \\left[ \\| \\boldsymbol{\\epsilon} - \\boldsymbol{\\epsilon}_\\theta(\\mathbf{a}_k, k, \\mathbf{O}) \\|^2 \\right]',
          explanation: '条件观测空间 O (多视角图像与机械臂关节姿态) 条件下去噪噪声预测器参数学习。'
        }
      ],
      sections: [
        {
          id: 'sec-embodied-1',
          title: '1. 双臂协作与扩散动作空间定义',
          level: 1,
          content: '传统行为克隆由于单模态假设难以表达双臂协作中的多种动作解空间，引入时序动作块去噪生成有效解决了抖动与滞后问题。'
        }
      ]
    };

    const starterFiles = createStarterFiles(project.slug, project.title, project.field);
    const session: ChatSession = {
      id: `s-embodied-${Date.now()}`,
      title: '具身机器人扩散策略与力控闭环讨论',
      createdAt: '2026-09-28',
      updatedAt: '昨天',
      messages: [
        {
          id: 'msg-e1',
          sender: 'assistant',
          text: '欢迎进入《面向灵巧双臂协作的端到端三维扩散运动策略与触觉力控融合》课题工作台。当前已载入 Diffusion Policy 与视觉触觉多模态基准文献，您可以随时让我协助撰写方法章节或生成轨迹可视化代码。',
          timestamp: '昨天 10:15'
        }
      ]
    };

    return {
      papers: [embodiedPaper, ...INITIAL_PAPERS.slice(1, 3)],
      activePaperId: embodiedPaper.id,
      files: starterFiles,
      activeFilePath: 'main.tex',
      gitCommits: INITIAL_COMMITS.slice(0, 3),
      wikiEntries: INITIAL_RAG_WIKI.slice(0, 3),
      graphNodes: INITIAL_GRAPH_NODES.slice(0, 4),
      graphLinks: INITIAL_GRAPH_LINKS.slice(0, 3),
      selectedGraphNodeId: INITIAL_GRAPH_NODES[0]?.id || 'node-1',
      memories: INITIAL_MEMORIES.slice(0, 3),
      skills: INITIAL_SKILLS,
      mcpServers: INITIAL_MCP_SERVERS,
      scheduledTasks: INITIAL_SCHEDULED_TASKS.slice(0, 2),
      guardrails: INITIAL_GUARDRAILS,
      telemetry: INITIAL_TELEMETRY,
      benchmarks: INITIAL_BENCHMARKS.slice(0, 3),
      sessions: [session],
      activeSessionId: session.id
    };
  }

  // If it's the genomics project
  if (project.id === 'proj-genomics') {
    const genomicsPaper: ResearchPaper = {
      id: 'paper-genomics-1',
      arxivId: '2405.09988',
      title: 'Single-cell Multi-omic Foundation Models with Masked Graph Transformers',
      authors: ['H. Zhang', 'M. Chen', 'L. Wang', 'K. Davis', 'et al.'],
      year: 2025,
      conference: 'Nature Machine Intelligence',
      citations: 410,
      version: 'v1',
      fileType: 'pdf',
      abstract: 'We present GeneGraph-FM, a 20-million cell foundation model pretrained on masked gene regulatory networks. It enables zero-shot cell type annotation and in-silico perturbation screening.',
      tldr: '基于掩码图注意力自监督学习的单细胞多组学基础大模型，实现零样本细胞分型与基因扰动推断。',
      tags: ['Single-Cell', 'Genomics', 'Foundation Model', 'Graph Transformers'],
      pdfUrl: 'https://arxiv.org/pdf/2405.09988.pdf',
      bibtex: `@article{genegraph2025,
  title={Single-cell Multi-omic Foundation Models with Masked Graph Transformers},
  author={Zhang, H. and Chen, M. and others},
  journal={Nature Machine Intelligence},
  year={2025}
}`,
      keyFormulas: [
        {
          name: '掩码基因节点重构目标',
          latex: '\\mathcal{L}_{\\text{gene}} = - \\sum_{i \\in \\mathcal{M}} \\log P(x_i \\mid \\mathcal{G}_{\\setminus \\mathcal{M}})',
          explanation: '基于未被遮蔽的邻接基因表达状态重构被掩蔽的细胞内靶向基因信号。'
        }
      ],
      sections: [
        {
          id: 'sec-genomics-1',
          title: '1. 跨组织异质性与单细胞图拓扑构建',
          level: 1,
          content: '单细胞测序数据存在严重的批次效应与降维稀疏性，掩码图建模有效捕捉了高阶非线性调控依赖。'
        }
      ]
    };

    const starterFiles = createStarterFiles(project.slug, project.title, project.field);
    const session: ChatSession = {
      id: `s-genomics-${Date.now()}`,
      title: '基因调控网络图预训练方法论讨论',
      createdAt: '2026-08-10',
      updatedAt: '3天前',
      messages: [
        {
          id: 'msg-g1',
          sender: 'assistant',
          text: '欢迎进入《跨组织单细胞转录组与基因调控网络的大规模掩码图预训练基础模型》课题工作台。当前处于同行评审反馈阶段，需补充对空间转录组数据的基准测试。',
          timestamp: '3天前 14:20'
        }
      ]
    };

    return {
      papers: [genomicsPaper, ...INITIAL_PAPERS.slice(0, 2)],
      activePaperId: genomicsPaper.id,
      files: starterFiles,
      activeFilePath: 'main.tex',
      gitCommits: INITIAL_COMMITS.slice(0, 3),
      wikiEntries: INITIAL_RAG_WIKI.slice(0, 3),
      graphNodes: INITIAL_GRAPH_NODES.slice(0, 4),
      graphLinks: INITIAL_GRAPH_LINKS.slice(0, 3),
      selectedGraphNodeId: INITIAL_GRAPH_NODES[0]?.id || 'node-1',
      memories: INITIAL_MEMORIES.slice(0, 3),
      skills: INITIAL_SKILLS,
      mcpServers: INITIAL_MCP_SERVERS,
      scheduledTasks: INITIAL_SCHEDULED_TASKS.slice(0, 2),
      guardrails: INITIAL_GUARDRAILS,
      telemetry: INITIAL_TELEMETRY,
      benchmarks: INITIAL_BENCHMARKS.slice(0, 3),
      sessions: [session],
      activeSessionId: session.id
    };
  }

  // Generic new project
  const starterFiles = createStarterFiles(project.slug, project.title, project.field);
  const session: ChatSession = {
    id: `s-new-${Date.now()}`,
    title: '课题启动与大纲讨论',
    createdAt: new Date().toLocaleDateString(),
    updatedAt: '刚刚',
    messages: [
      {
        id: `msg-n1-${Date.now()}`,
        sender: 'assistant',
        text: `您好！课题《${project.title}》已成功初始化。我是您的科研助手，已为您准备好标准双栏 LaTeX 论文模板（main.tex）与实验脚本骨架。您可以随时让我检索文献、编写公式或拟定大纲。`,
        timestamp: '刚刚'
      }
    ]
  };

  return {
    papers: INITIAL_PAPERS.slice(0, 2),
    activePaperId: INITIAL_PAPERS[0]?.id,
    files: starterFiles,
    activeFilePath: 'main.tex',
    gitCommits: [
      {
        hash: 'init001',
        message: `chore: 初始化论文课题 ${project.slug}`,
        date: '刚刚',
        author: 'Lead Researcher',
        changedFiles: 4
      }
    ],
    wikiEntries: INITIAL_RAG_WIKI.slice(0, 2),
    graphNodes: INITIAL_GRAPH_NODES.slice(0, 3),
    graphLinks: INITIAL_GRAPH_LINKS.slice(0, 2),
    selectedGraphNodeId: INITIAL_GRAPH_NODES[0]?.id || 'node-1',
    memories: INITIAL_MEMORIES.slice(0, 2),
    skills: INITIAL_SKILLS,
    mcpServers: INITIAL_MCP_SERVERS,
    scheduledTasks: [],
    guardrails: INITIAL_GUARDRAILS,
    telemetry: INITIAL_TELEMETRY,
    benchmarks: [],
    sessions: [session],
    activeSessionId: session.id
  };
}

export function loadProjectWorkspaceData(project: PaperProject): ProjectWorkspaceData {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX_PROJECT_DATA}${project.id}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.files) && Array.isArray(parsed.papers)) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn(`Failed to parse saved data for project ${project.id}:`, err);
  }
  return getInitialProjectData(project);
}

export function saveProjectWorkspaceData(projectId: string, data: ProjectWorkspaceData): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX_PROJECT_DATA}${projectId}`, JSON.stringify(data));
  } catch (err) {
    console.error(`Failed to save project data for ${projectId}:`, err);
  }
}
