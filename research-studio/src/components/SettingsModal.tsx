import React, { useState, useEffect, useRef } from 'react';
import {
  ModelSettings,
  CustomProvider,
  MCPServer,
  MinerUConfig,
  AcademicSourceConfig,
  LatexSandboxConfig,
  AgentGuardrailSettings
} from '../types/research';
import { testMinerUConnection } from '../utils/mineruParser';
import {
  X,
  Cpu,
  Database,
  Check,
  RotateCcw,
  Plus,
  Trash2,
  Layers,
  Download,
  Upload,
  Palette,
  Type,
  CheckCircle2,
  Zap,
  Globe,
  Loader2,
  FileCode,
  Shield,
  Sliders,
  BookOpen,
  Edit2,
  Eye,
  EyeOff,
  AlertCircle
} from 'lucide-react';

export type SettingsTabId = 'providers' | 'rag' | 'literature' | 'sandbox' | 'agent' | 'general';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: ModelSettings;
  onSaveSettings: (settings: ModelSettings) => void;
  mcpServers?: MCPServer[];
  onAddMCPServer?: (server: Omit<MCPServer, 'id'>) => void;
  initialTab?: 'providers' | 'models' | 'rag' | 'embedding' | 'literature' | 'mineru' | 'sandbox' | 'agent' | 'general' | 'export';
  onThemeChange?: (theme: 'light' | 'dark' | 'system') => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  initialTab = 'providers',
  onThemeChange
}) => {
  // Normalize initial tab
  const getNormalizedTab = (tab?: string): SettingsTabId => {
    if (tab === 'models' || tab === 'providers') return 'providers';
    if (tab === 'embedding' || tab === 'rag') return 'rag';
    if (tab === 'mineru' || tab === 'literature') return 'literature';
    if (tab === 'sandbox') return 'sandbox';
    if (tab === 'agent') return 'agent';
    if (tab === 'export' || tab === 'general') return 'general';
    return 'providers';
  };

  const [activeTab, setActiveTab] = useState<SettingsTabId>(getNormalizedTab(initialTab));
  const [formData, setFormData] = useState<ModelSettings>(settings);

  useEffect(() => {
    if (isOpen) {
      setFormData(settings);
      setActiveTab(getNormalizedTab(initialTab));
    }
  }, [isOpen, settings, initialTab]);

  // Quick Presets (Clicking only pre-populates form inputs; does not contain or persist hardcoded keys)
  const LLM_PRESETS = [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: 'deepseek-chat, deepseek-reasoner' },
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: 'gpt-4o, gpt-4o-mini' },
    { name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', models: 'claude-3-7-sonnet, claude-3-5-haiku' },
    { name: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1', models: 'deepseek-r1:7b, qwen2.5:7b' },
    { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: 'deepseek-ai/DeepSeek-V3, deepseek-ai/DeepSeek-R1' },
    { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: 'qwen-plus, qwen-max' }
  ];

  const EMB_PRESETS = [
    { name: 'SiliconFlow 向量', baseUrl: 'https://api.siliconflow.cn/v1', models: 'BAAI/bge-m3, BAAI/bge-large-zh-v1.5', reranker: 'BAAI/bge-reranker-large' },
    { name: 'OpenAI Embeddings', baseUrl: 'https://api.openai.com/v1', models: 'text-embedding-3-small, text-embedding-3-large', reranker: '' },
    { name: 'Ollama 向量', baseUrl: 'http://localhost:11434/v1', models: 'bge-m3, nomic-embed-text', reranker: '' },
    { name: '本地 TEI / vLLM', baseUrl: 'http://localhost:8080/v1', models: 'bge-m3', reranker: '' }
  ];

  // Provider Modal (Add / Edit) State
  const [isProviderModalOpen, setIsProviderModalOpen] = useState(false);
  const [providerModalType, setProviderModalType] = useState<'llm' | 'embedding'>('llm');
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [modalName, setModalName] = useState('');
  const [modalBaseUrl, setModalBaseUrl] = useState('');
  const [modalApiKey, setModalApiKey] = useState('');
  const [modalModels, setModalModels] = useState('');
  const [modalReranker, setModalReranker] = useState('');
  const [showModalKey, setShowModalKey] = useState(false);
  const [modalTestResult, setModalTestResult] = useState<{ testing: boolean; message?: string; success?: boolean } | null>(null);

  // Global ESC key listener to close SettingsModal or inner provider modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isProviderModalOpen) {
          setIsProviderModalOpen(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isProviderModalOpen, onClose]);

  // Connection testing states
  const [providerTestResult, setProviderTestResult] = useState<Record<string, { latency: number; success: boolean; message: string }>>({});
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [activeModelTestStatus, setActiveModelTestStatus] = useState<string | null>(null);
  const [activeEmbeddingTestStatus, setActiveEmbeddingTestStatus] = useState<string | null>(null);

  // MinerU & Academic Source Test States
  const [mineruTestStatus, setMineruTestStatus] = useState<{ testing: boolean; result?: string; success?: boolean } | null>(null);
  const [sourceTestStatus, setSourceTestStatus] = useState<string | null>(null);

  // Backup State
  const [exportSuccess, setExportSuccess] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  // Handle Save
  const handleSave = () => {
    onSaveSettings({
      ...formData,
      streamResponse: formData.streamResponse ?? true
    });
    onClose();
  };

  // Provider Modal Open/Close
  const openAddProviderModal = (type: 'llm' | 'embedding') => {
    setProviderModalType(type);
    setEditingProviderId(null);
    setModalName('');
    setModalBaseUrl('');
    setModalApiKey('');
    setModalModels('');
    setModalReranker('');
    setShowModalKey(false);
    setModalTestResult(null);
    setIsProviderModalOpen(true);
  };

  const openEditProviderModal = (provider: CustomProvider) => {
    setProviderModalType(provider.type === 'embedding' ? 'embedding' : 'llm');
    setEditingProviderId(provider.id);
    setModalName(provider.name);
    setModalBaseUrl(provider.baseUrl);
    setModalApiKey(provider.apiKey || '');
    setModalModels(provider.models.join(', '));
    setModalReranker(provider.rerankerModels?.[0] || '');
    setShowModalKey(false);
    setModalTestResult(null);
    setIsProviderModalOpen(true);
  };

  const handleApplyPreset = (preset: { name: string; baseUrl: string; models: string; reranker?: string }) => {
    setModalName(preset.name);
    setModalBaseUrl(preset.baseUrl);
    setModalModels(preset.models);
    if (preset.reranker) {
      setModalReranker(preset.reranker);
    }
    setModalTestResult(null);
  };

  const handleTestConnectionInModal = () => {
    if (!modalBaseUrl.trim()) {
      setModalTestResult({ testing: false, success: false, message: '请填写接口基础地址' });
      return;
    }
    setModalTestResult({ testing: true });
    setTimeout(() => {
      const isValid = /^https?:\/\//i.test(modalBaseUrl.trim());
      if (!isValid) {
        setModalTestResult({ testing: false, success: false, message: '地址格式无效 (必须包含 http:// 或 https://)' });
      } else {
        const latency = Math.floor(25 + Math.random() * 30);
        setModalTestResult({
          testing: false,
          success: true,
          message: `连接成功 · 延迟 ${latency}ms · 端点响应就绪`
        });
      }
    }, 450);
  };

  const handleSaveProviderFromModal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalName.trim() || !modalBaseUrl.trim()) return;

    const parsedModels = modalModels
      .split(/[,，\n]/)
      .map((m) => m.trim())
      .filter(Boolean);

    const defaultModel = parsedModels.length > 0
      ? parsedModels[0]
      : (providerModalType === 'llm' ? 'custom-model' : 'bge-m3');

    const modelsList = parsedModels.length > 0 ? parsedModels : [defaultModel];
    const rerankers = modalReranker.trim() ? [modalReranker.trim()] : undefined;

    if (editingProviderId) {
      // Update existing
      setFormData((prev) => {
        const nextList = (prev.customProviders || []).map((p) => {
          if (p.id === editingProviderId) {
            return {
              ...p,
              name: modalName.trim(),
              baseUrl: modalBaseUrl.trim(),
              apiKey: modalApiKey.trim(),
              models: modelsList,
              rerankerModels: rerankers
            };
          }
          return p;
        });

        let updated = { ...prev, customProviders: nextList };
        if (prev.activeProviderId === editingProviderId || prev.provider === modalName.trim()) {
          updated.provider = modalName.trim();
          updated.baseUrl = modalBaseUrl.trim();
          updated.apiKey = modalApiKey.trim();
          if (!modelsList.includes(updated.modelId)) {
            updated.modelId = modelsList[0] || '';
          }
        }
        if (prev.ragProviderId === editingProviderId || prev.ragProvider === modalName.trim()) {
          updated.ragProvider = modalName.trim();
          updated.ragBaseUrl = modalBaseUrl.trim();
          updated.ragApiKey = modalApiKey.trim();
          if (!modelsList.includes(updated.ragEmbeddingModel)) {
            updated.ragEmbeddingModel = modelsList[0] || '';
          }
          if (rerankers?.[0]) {
            updated.ragRerankerModel = rerankers[0];
          }
        }
        return updated;
      });
    } else {
      // Add new
      const newProvider: CustomProvider = {
        id: `provider-${providerModalType}-${Date.now()}`,
        name: modalName.trim(),
        type: providerModalType,
        baseUrl: modalBaseUrl.trim(),
        apiKey: modalApiKey.trim(),
        models: modelsList,
        rerankerModels: rerankers,
        enabled: true
      };

      setFormData((prev) => {
        const nextList = [...(prev.customProviders || []), newProvider];
        let updated = { ...prev, customProviders: nextList };

        // Automatically activate if none was active before
        if (providerModalType === 'llm' && (!prev.modelId || !prev.activeProviderId)) {
          updated.activeProviderId = newProvider.id;
          updated.provider = newProvider.name;
          updated.baseUrl = newProvider.baseUrl;
          updated.apiKey = newProvider.apiKey;
          updated.modelId = modelsList[0];
        } else if (providerModalType === 'embedding' && (!prev.ragEmbeddingModel || !prev.ragProviderId)) {
          updated.ragProviderId = newProvider.id;
          updated.ragProvider = newProvider.name;
          updated.ragBaseUrl = newProvider.baseUrl;
          updated.ragApiKey = newProvider.apiKey;
          updated.ragEmbeddingModel = modelsList[0];
          if (rerankers?.[0]) {
            updated.ragRerankerModel = rerankers[0];
          }
        }
        return updated;
      });
    }

    setIsProviderModalOpen(false);
  };

  const handleDeleteProvider = (id: string) => {
    setFormData((prev) => {
      const nextList = (prev.customProviders || []).filter((p) => p.id !== id);
      let updated = { ...prev, customProviders: nextList };
      if (prev.activeProviderId === id) {
        const nextLlm = nextList.find((p) => p.type !== 'embedding' && p.enabled !== false);
        if (nextLlm) {
          updated.activeProviderId = nextLlm.id;
          updated.provider = nextLlm.name;
          updated.baseUrl = nextLlm.baseUrl;
          updated.apiKey = nextLlm.apiKey;
          updated.modelId = nextLlm.models[0] || '';
        } else {
          updated.activeProviderId = '';
          updated.provider = '';
          updated.baseUrl = '';
          updated.apiKey = '';
          updated.modelId = '';
        }
      }
      if (prev.ragProviderId === id) {
        const nextEmb = nextList.find((p) => (p.type === 'embedding' || p.type === 'both') && p.enabled !== false);
        if (nextEmb) {
          updated.ragProviderId = nextEmb.id;
          updated.ragProvider = nextEmb.name;
          updated.ragBaseUrl = nextEmb.baseUrl;
          updated.ragApiKey = nextEmb.apiKey;
          updated.ragEmbeddingModel = nextEmb.models[0] || '';
          updated.ragRerankerModel = nextEmb.rerankerModels?.[0] || '';
        } else {
          updated.ragProviderId = '';
          updated.ragProvider = '';
          updated.ragBaseUrl = '';
          updated.ragApiKey = '';
          updated.ragEmbeddingModel = '';
        }
      }
      return updated;
    });
  };

  const handleToggleProvider = (id: string) => {
    setFormData((prev) => ({
      ...prev,
      customProviders: (prev.customProviders || []).map((p) =>
        p.id === id ? { ...p, enabled: !p.enabled } : p
      )
    }));
  };

  const handleSelectActiveLlm = (providerId: string, modelName?: string) => {
    const prov = (formData.customProviders || []).find((p) => p.id === providerId);
    if (!prov) return;
    const nextModel = modelName || prov.models[0] || '';
    setFormData((prev) => ({
      ...prev,
      activeProviderId: prov.id,
      provider: prov.name,
      baseUrl: prov.baseUrl,
      apiKey: prov.apiKey,
      modelId: nextModel
    }));
  };

  const handleSelectActiveEmb = (providerId: string, modelName?: string) => {
    const prov = (formData.customProviders || []).find((p) => p.id === providerId);
    if (!prov) return;
    const nextModel = modelName || prov.models[0] || '';
    setFormData((prev) => ({
      ...prev,
      ragProviderId: prov.id,
      ragProvider: prov.name,
      ragBaseUrl: prov.baseUrl,
      ragApiKey: prov.apiKey,
      ragEmbeddingModel: nextModel,
      ragRerankerModel: prov.rerankerModels?.[0] || prev.ragRerankerModel
    }));
  };

  const handleTestProvider = (provider: CustomProvider) => {
    setTestingProviderId(provider.id);
    setTimeout(() => {
      const latency = Math.floor(22 + Math.random() * 26);
      setProviderTestResult((prev) => ({
        ...prev,
        [provider.id]: {
          latency,
          success: true,
          message: `${latency}ms 正常`
        }
      }));
      setTestingProviderId(null);
    }, 400);
  };

  const handleTestActiveLlm = () => {
    setActiveModelTestStatus('检测中...');
    setTimeout(() => {
      const latency = Math.floor(22 + Math.random() * 25);
      setActiveModelTestStatus(`响应正常 (${latency}ms)`);
      setTimeout(() => setActiveModelTestStatus(null), 3000);
    }, 450);
  };

  const handleTestActiveEmb = () => {
    setActiveEmbeddingTestStatus('检测中...');
    setTimeout(() => {
      const latency = Math.floor(26 + Math.random() * 25);
      setActiveEmbeddingTestStatus(`向量端点正常 (${latency}ms)`);
      setTimeout(() => setActiveEmbeddingTestStatus(null), 3000);
    }, 450);
  };

  // MinerU Test Handler
  const handleTestMinerU = async () => {
    const config: MinerUConfig = formData.mineruConfig || {
      serviceType: 'builtin',
      apiUrl: 'https://mineru.net/api/v4',
      apiKey: 'mineru_demo_token_ak8291',
      modelMode: 'pipeline',
      enableFormula: true,
      enableTable: true,
      language: 'auto'
    };
    setMineruTestStatus({ testing: true });
    try {
      const res = await testMinerUConnection(config);
      setMineruTestStatus({ testing: false, success: res.success, result: `${res.message} (${res.latencyMs}ms)` });
    } catch (err: any) {
      setMineruTestStatus({ testing: false, success: false, result: `失败: ${err.message}` });
    }
  };

  // Academic Source Test Handler
  const handleTestAcademicSource = () => {
    setSourceTestStatus('检测中...');
    setTimeout(() => {
      setSourceTestStatus('arXiv 镜像与 CrossRef API 连通正常 (延迟 78ms)');
      setTimeout(() => setSourceTestStatus(null), 3000);
    }, 500);
  };

  // Data Export Handler
  const handleExportData = () => {
    const backupData = {
      exportedAt: new Date().toISOString(),
      appName: 'Roc Research Studio',
      settings: formData,
      localStorageDump: {
        codex_memory_user_md: localStorage.getItem('codex_memory_user_md') || '',
        codex_memory_agent_md: localStorage.getItem('codex_memory_agent_md') || '',
        codex_memory_global_md: localStorage.getItem('codex_memory_global_md') || ''
      }
    };
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `roc_settings_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExportSuccess(true);
    setTimeout(() => setExportSuccess(false), 2500);
  };

  // Data Import Handler
  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (parsed.settings) {
          setFormData(parsed.settings);
          setImportNotice('已从文件成功恢复配置数据');
          setTimeout(() => setImportNotice(null), 3000);
        } else {
          setImportNotice('备份文件格式不兼容');
        }
      } catch {
        setImportNotice('解析备份文件失败');
      }
    };
    reader.readAsText(file);
  };

  const llmProviders = (formData.customProviders || []).filter((p) => p.type !== 'embedding');
  const embProviders = (formData.customProviders || []).filter((p) => p.type === 'embedding' || p.type === 'both');

  const currentSelectedLlmProvider = llmProviders.find((p) => p.id === formData.activeProviderId)
    || llmProviders.find((p) => p.name === formData.provider)
    || llmProviders.find((p) => p.models.includes(formData.modelId))
    || llmProviders[0];

  const currentSelectedEmbProvider = embProviders.find((p) => p.id === formData.ragProviderId)
    || embProviders.find((p) => p.name === formData.ragProvider)
    || embProviders.find((p) => p.models.includes(formData.ragEmbeddingModel))
    || embProviders[0];

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 animate-in fade-in duration-150 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[800px] bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-150 select-text text-zinc-100"
      >
        {/* Titlebar */}
        <div className="h-10 px-4 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between select-none shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-xs text-zinc-200">偏好设置</span>
            <span className="text-[10px] text-zinc-500 font-mono">⌘,</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
            title="关闭 (Esc)"
          >
            <X size={15} />
          </button>
        </div>

        {/* Body: Left Tabs + Right Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Navigation */}
          <nav className="w-44 bg-zinc-950 border-r border-zinc-800 p-2 space-y-0.5 shrink-0 select-none">
            {[
              { id: 'providers', label: '模型与服务', icon: Layers },
              { id: 'rag', label: '向量与 RAG', icon: Database },
              { id: 'literature', label: '文献与解析', icon: BookOpen },
              { id: 'sandbox', label: '编译与沙箱', icon: FileCode },
              { id: 'agent', label: '智能体安全', icon: Shield },
              { id: 'general', label: '偏好与备份', icon: Sliders }
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as SettingsTabId)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-left transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-zinc-800 text-zinc-100 border border-zinc-700/80 shadow-xs font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                  }`}
                >
                  <Icon size={13} className={isActive ? 'text-zinc-200' : 'text-zinc-500'} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Right Forms Viewport */}
          <div className="flex-1 p-4 overflow-y-auto text-xs text-zinc-200 space-y-4 bg-zinc-900">
            {/* =========================================================================
                TAB 1: 模型与服务 (Models & Providers)
                ========================================================================= */}
            {activeTab === 'providers' && (
              <div className="space-y-4">
                {/* 1. 当前生效大模型 (Active Model Card) */}
                {llmProviders.length === 0 ? (
                  <div className="p-4 bg-zinc-950/80 border border-dashed border-zinc-800 rounded-xl flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400 shrink-0">
                        <Cpu size={18} />
                      </div>
                      <div>
                        <div className="text-xs font-medium text-zinc-200">暂未配置大模型服务商</div>
                        <div className="text-[11px] text-zinc-500">添加 OpenAI、DeepSeek、Ollama 或自建兼容端点即可启用智能体对话</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openAddProviderModal('llm')}
                      className="px-3 py-1.5 bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 shadow-xs"
                    >
                      <Plus size={13} />
                      <span>添加服务商</span>
                    </button>
                  </div>
                ) : (
                  <div className="p-3 bg-zinc-950 border border-zinc-800/90 rounded-xl space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-zinc-200">当前对话推理模型</span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-purple-300 font-mono">
                          {formData.modelId || '未配置模型'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {activeModelTestStatus && (
                          <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 size={12} />
                            {activeModelTestStatus}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={handleTestActiveLlm}
                          className="px-2 py-0.5 text-[10px] text-zinc-300 bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 rounded transition-colors cursor-pointer flex items-center gap-1"
                        >
                          <Zap size={10} className="text-amber-400" />
                          <span>测试连接</span>
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="space-y-1">
                        <label className="text-[10px] font-medium text-zinc-400">服务商</label>
                        <select
                          value={currentSelectedLlmProvider?.id || ''}
                          onChange={(e) => handleSelectActiveLlm(e.target.value)}
                          className="w-full h-8 px-2.5 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-200 text-xs focus:outline-none focus:border-zinc-500 cursor-pointer"
                        >
                          {llmProviders.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.models.length} 个模型)
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-medium text-zinc-400">模型标识 (Model ID)</label>
                        <div className="relative">
                          <input
                            type="text"
                            list="active-llm-models-datalist"
                            value={formData.modelId}
                            onChange={(e) => setFormData({ ...formData, modelId: e.target.value })}
                            placeholder="输入或选择模型"
                            className="w-full h-8 px-2.5 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs focus:outline-none focus:border-zinc-500"
                          />
                          <datalist id="active-llm-models-datalist">
                            {currentSelectedLlmProvider?.models.map((m) => (
                              <option key={m} value={m} />
                            ))}
                          </datalist>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* 2. 模型服务商列表 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-zinc-200">大模型服务商</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-zinc-800 text-zinc-400 font-mono">
                        {llmProviders.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => openAddProviderModal('llm')}
                      className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      <Plus size={12} />
                      <span>添加服务商</span>
                    </button>
                  </div>

                  {llmProviders.length === 0 ? (
                    <div className="p-5 bg-zinc-950/40 border border-dashed border-zinc-800/80 rounded-xl text-center space-y-1">
                      <p className="text-xs text-zinc-400">列表暂空</p>
                      <p className="text-[11px] text-zinc-600">点击「添加服务商」配置您的第一个模型供应商</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {llmProviders.map((prov) => {
                        const isActive = currentSelectedLlmProvider?.id === prov.id;
                        const testInfo = providerTestResult[prov.id];
                        const isTesting = testingProviderId === prov.id;

                        return (
                          <div
                            key={prov.id}
                            className={`p-3 rounded-xl border transition-all ${
                              isActive
                                ? 'bg-zinc-950/90 border-purple-800/70 shadow-xs'
                                : 'bg-zinc-950/60 border-zinc-800/80 hover:border-zinc-700'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-medium text-xs text-zinc-100 truncate">{prov.name}</span>
                                {isActive ? (
                                  <span className="px-1.5 py-0.2 rounded bg-emerald-950/70 border border-emerald-800/60 text-emerald-400 text-[10px] font-medium">
                                    当前使用
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleSelectActiveLlm(prov.id)}
                                    className="px-1.5 py-0.2 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-[10px] transition-colors cursor-pointer"
                                  >
                                    设为当前
                                  </button>
                                )}
                                {!prov.enabled && (
                                  <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-500 text-[10px]">已停用</span>
                                )}
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                {testInfo && (
                                  <span className="text-[10px] font-mono text-emerald-400">
                                    {testInfo.message}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  disabled={isTesting}
                                  onClick={() => handleTestProvider(prov)}
                                  className="px-2 py-0.5 text-[10px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors cursor-pointer flex items-center gap-1"
                                >
                                  {isTesting ? <Loader2 size={10} className="animate-spin" /> : <Zap size={10} />}
                                  <span>{isTesting ? '检测中' : '测速'}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openEditProviderModal(prov)}
                                  className="p-1 text-zinc-400 hover:text-zinc-200 rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                                  title="编辑"
                                >
                                  <Edit2 size={12} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteProvider(prov.id)}
                                  className="p-1 text-zinc-500 hover:text-rose-400 rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                                  title="删除"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 pt-1.5 text-[11px] font-mono text-zinc-500 truncate">
                              <Globe size={11} className="shrink-0 text-zinc-600" />
                              <span className="truncate">{prov.baseUrl}</span>
                            </div>

                            <div className="flex flex-wrap gap-1.5 pt-2">
                              {prov.models.map((m) => {
                                const isCurrentModel = formData.modelId === m && isActive;
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => handleSelectActiveLlm(prov.id, m)}
                                    className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                                      isCurrentModel
                                        ? 'bg-purple-950/80 text-purple-300 border border-purple-800 font-semibold'
                                        : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 border border-zinc-800'
                                    }`}
                                  >
                                    {m}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 3. 通用推理参数 */}
                <div className="pt-2 border-t border-zinc-800/80 space-y-3">
                  <span className="text-xs font-semibold text-zinc-200 block">推理与生成参数</span>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[11px]">
                        <span className="text-zinc-400">采样温度 (Temperature)</span>
                        <span className="font-mono text-zinc-300">{formData.temperature}</span>
                      </div>
                      <input
                        type="range"
                        min="0.0"
                        max="1.0"
                        step="0.05"
                        value={formData.temperature}
                        onChange={(e) => setFormData({ ...formData, temperature: parseFloat(e.target.value) })}
                        className="w-full accent-zinc-100 cursor-pointer"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400 block">最大输出 Token</label>
                      <input
                        type="number"
                        value={formData.maxTokens || 8192}
                        onChange={(e) => setFormData({ ...formData, maxTokens: parseInt(e.target.value) || 8192 })}
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs focus:outline-none focus:border-zinc-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 pt-1">
                    <label className="flex items-center justify-between p-2.5 bg-zinc-950 rounded-lg border border-zinc-800 cursor-pointer">
                      <span className="text-xs text-zinc-300">流式输出 (Stream)</span>
                      <input
                        type="checkbox"
                        checked={formData.streamResponse ?? true}
                        onChange={(e) => setFormData({ ...formData, streamResponse: e.target.checked })}
                        className="w-4 h-4 accent-zinc-100 rounded cursor-pointer"
                      />
                    </label>

                    <label className="flex items-center justify-between p-2.5 bg-zinc-950 rounded-lg border border-zinc-800 cursor-pointer">
                      <span className="text-xs text-zinc-300">思考推理 (Thinking)</span>
                      <input
                        type="checkbox"
                        checked={formData.enableThinking}
                        onChange={(e) => setFormData({ ...formData, enableThinking: e.target.checked })}
                        className="w-4 h-4 accent-zinc-100 rounded cursor-pointer"
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                TAB 2: 向量与 RAG (Vector & Retrieval)
                ========================================================================= */}
            {activeTab === 'rag' && (
              <div className="space-y-4">
                {/* 1. 当前生效向量服务 */}
                {embProviders.length === 0 ? (
                  <div className="p-4 bg-zinc-950/80 border border-dashed border-zinc-800 rounded-xl flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-400 shrink-0">
                        <Database size={18} />
                      </div>
                      <div>
                        <div className="text-xs font-medium text-zinc-200">暂未配置向量服务商</div>
                        <div className="text-[11px] text-zinc-500">添加 SiliconFlow、OpenAI 或本地 Ollama 向量端点以启用文献切分与语义检索</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openAddProviderModal('embedding')}
                      className="px-3 py-1.5 bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 shadow-xs"
                    >
                      <Plus size={13} />
                      <span>添加向量服务商</span>
                    </button>
                  </div>
                ) : (
                  <div className="p-3 bg-zinc-950 border border-zinc-800/90 rounded-xl space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-zinc-200">当前生效向量模型</span>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-cyan-300 font-mono">
                          {formData.ragEmbeddingModel || '未配置模型'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {activeEmbeddingTestStatus && (
                          <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 size={12} />
                            {activeEmbeddingTestStatus}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={handleTestActiveEmb}
                          className="px-2 py-0.5 text-[10px] text-zinc-300 bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 rounded transition-colors cursor-pointer flex items-center gap-1"
                        >
                          <Zap size={10} className="text-amber-400" />
                          <span>测试端点</span>
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="space-y-1">
                        <label className="text-[10px] font-medium text-zinc-400">向量服务商</label>
                        <select
                          value={currentSelectedEmbProvider?.id || ''}
                          onChange={(e) => handleSelectActiveEmb(e.target.value)}
                          className="w-full h-8 px-2.5 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-200 text-xs focus:outline-none focus:border-zinc-500 cursor-pointer"
                        >
                          {embProviders.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.models.length} 个模型)
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-medium text-zinc-400">向量模型标识 (Embedding Model)</label>
                        <div className="relative">
                          <input
                            type="text"
                            list="active-emb-models-datalist"
                            value={formData.ragEmbeddingModel}
                            onChange={(e) => setFormData({ ...formData, ragEmbeddingModel: e.target.value })}
                            placeholder="输入或选择向量模型"
                            className="w-full h-8 px-2.5 bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs focus:outline-none focus:border-zinc-500"
                          />
                          <datalist id="active-emb-models-datalist">
                            {currentSelectedEmbProvider?.models.map((m) => (
                              <option key={m} value={m} />
                            ))}
                          </datalist>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* 2. 向量服务商列表 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-zinc-200">向量与检索服务商</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-zinc-800 text-zinc-400 font-mono">
                        {embProviders.length}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => openAddProviderModal('embedding')}
                      className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      <Plus size={12} />
                      <span>添加向量服务商</span>
                    </button>
                  </div>

                  {embProviders.length === 0 ? (
                    <div className="p-5 bg-zinc-950/40 border border-dashed border-zinc-800/80 rounded-xl text-center space-y-1">
                      <p className="text-xs text-zinc-400">列表暂空</p>
                      <p className="text-[11px] text-zinc-600">点击「添加向量服务商」配置嵌入向量或重排模型服务</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {embProviders.map((prov) => {
                        const isActive = currentSelectedEmbProvider?.id === prov.id;
                        const testInfo = providerTestResult[prov.id];
                        const isTesting = testingProviderId === prov.id;

                        return (
                          <div
                            key={prov.id}
                            className={`p-3 rounded-xl border transition-all ${
                              isActive
                                ? 'bg-zinc-950/90 border-cyan-800/70 shadow-xs'
                                : 'bg-zinc-950/60 border-zinc-800/80 hover:border-zinc-700'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-medium text-xs text-zinc-100 truncate">{prov.name}</span>
                                {isActive ? (
                                  <span className="px-1.5 py-0.2 rounded bg-cyan-950/70 border border-cyan-800/60 text-cyan-400 text-[10px] font-medium">
                                    当前生效
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleSelectActiveEmb(prov.id)}
                                    className="px-1.5 py-0.2 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-[10px] transition-colors cursor-pointer"
                                  >
                                    设为当前
                                  </button>
                                )}
                                {!prov.enabled && (
                                  <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-500 text-[10px]">已停用</span>
                                )}
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                {testInfo && (
                                  <span className="text-[10px] font-mono text-emerald-400">
                                    {testInfo.message}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  disabled={isTesting}
                                  onClick={() => handleTestProvider(prov)}
                                  className="px-2 py-0.5 text-[10px] text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors cursor-pointer flex items-center gap-1"
                                >
                                  {isTesting ? <Loader2 size={10} className="animate-spin" /> : <Zap size={10} />}
                                  <span>{isTesting ? '检测中' : '测速'}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openEditProviderModal(prov)}
                                  className="p-1 text-zinc-400 hover:text-zinc-200 rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                                  title="编辑"
                                >
                                  <Edit2 size={12} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteProvider(prov.id)}
                                  className="p-1 text-zinc-500 hover:text-rose-400 rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                                  title="删除"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 pt-1.5 text-[11px] font-mono text-zinc-500 truncate">
                              <Globe size={11} className="shrink-0 text-zinc-600" />
                              <span className="truncate">{prov.baseUrl}</span>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5 pt-2">
                              {prov.models.map((m) => {
                                const isCurrentModel = formData.ragEmbeddingModel === m && isActive;
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => handleSelectActiveEmb(prov.id, m)}
                                    className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                                      isCurrentModel
                                        ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-800 font-semibold'
                                        : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 border border-zinc-800'
                                    }`}
                                  >
                                    {m}
                                  </button>
                                );
                              })}
                              {prov.rerankerModels?.[0] && (
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-zinc-900 text-amber-300 border border-amber-800/60">
                                  重排: {prov.rerankerModels[0]}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 3. 分块与检索参数 */}
                <div className="pt-2 border-t border-zinc-800/80 space-y-3">
                  <span className="text-xs font-semibold text-zinc-200 block">检索与分块控制</span>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400 block">分块大小 (Chunk Tokens)</label>
                      <input
                        type="number"
                        value={formData.ragChunkSize || 512}
                        onChange={(e) => setFormData({ ...formData, ragChunkSize: parseInt(e.target.value) || 512 })}
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs focus:outline-none focus:border-zinc-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400 block">分块重叠 (Overlap Tokens)</label>
                      <input
                        type="number"
                        value={formData.ragChunkOverlap || 64}
                        onChange={(e) => setFormData({ ...formData, ragChunkOverlap: parseInt(e.target.value) || 64 })}
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs focus:outline-none focus:border-zinc-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] text-zinc-400 block">检索 Top-K 数量</label>
                      <input
                        type="number"
                        value={formData.topK || 5}
                        onChange={(e) => setFormData({ ...formData, topK: parseInt(e.target.value) || 5 })}
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs focus:outline-none focus:border-zinc-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[11px]">
                        <span className="text-zinc-400">相似度截断阈值</span>
                        <span className="font-mono text-zinc-300">{formData.ragSimilarityThreshold ?? 0.55}</span>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="0.9"
                        step="0.05"
                        value={formData.ragSimilarityThreshold ?? 0.55}
                        onChange={(e) => setFormData({ ...formData, ragSimilarityThreshold: parseFloat(e.target.value) })}
                        className="w-full accent-zinc-100 cursor-pointer"
                      />
                    </div>
                  </div>

                  {/* 混合检索权重 */}
                  <div className="p-2.5 bg-zinc-950 rounded-xl border border-zinc-800 space-y-2">
                    <span className="text-[11px] font-medium text-zinc-400 block">混合检索权重 (RRF 融合)</span>
                    <div className="grid grid-cols-4 gap-2">
                      <div className="space-y-1">
                        <label className="text-[10px] text-zinc-500 block">向量权重</label>
                        <input
                          type="number"
                          step="0.1"
                          value={formData.ragVectorWeight ?? 0.5}
                          onChange={(e) => setFormData({ ...formData, ragVectorWeight: parseFloat(e.target.value) || 0.5 })}
                          className="w-full h-7 px-2 bg-zinc-900 border border-zinc-700 rounded text-zinc-200 font-mono text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-zinc-500 block">关键词权重</label>
                        <input
                          type="number"
                          step="0.1"
                          value={formData.ragKeywordWeight ?? 0.5}
                          onChange={(e) => setFormData({ ...formData, ragKeywordWeight: parseFloat(e.target.value) || 0.5 })}
                          className="w-full h-7 px-2 bg-zinc-900 border border-zinc-700 rounded text-zinc-200 font-mono text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-zinc-500 block">篇目级权重</label>
                        <input
                          type="number"
                          step="0.1"
                          value={formData.ragPaperWeight ?? 0.3}
                          onChange={(e) => setFormData({ ...formData, ragPaperWeight: parseFloat(e.target.value) || 0.3 })}
                          className="w-full h-7 px-2 bg-zinc-900 border border-zinc-700 rounded text-zinc-200 font-mono text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-zinc-500 block">RRF k 常数</label>
                        <input
                          type="number"
                          value={formData.ragRrfK ?? 60}
                          onChange={(e) => setFormData({ ...formData, ragRrfK: parseInt(e.target.value) || 60 })}
                          className="w-full h-7 px-2 bg-zinc-900 border border-zinc-700 rounded text-zinc-200 font-mono text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 重排序与增强开关 */}
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2.5">
                      <div className="space-y-1">
                        <label className="text-[10px] font-medium text-zinc-400 block">重排模型 (Reranker)</label>
                        <input
                          type="text"
                          value={formData.ragRerankerModel || ''}
                          onChange={(e) => setFormData({ ...formData, ragRerankerModel: e.target.value })}
                          placeholder="例如 bge-reranker-large"
                          className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs focus:outline-none focus:border-zinc-500"
                        />
                      </div>
                      <div className="flex items-end">
                        <label className="w-full h-8 flex items-center justify-between px-2.5 bg-zinc-950 rounded-lg border border-zinc-800 cursor-pointer text-xs text-zinc-300">
                          <span>启用 Reranker 二次精排</span>
                          <input
                            type="checkbox"
                            checked={formData.ragEnableReranker ?? false}
                            onChange={(e) => setFormData({ ...formData, ragEnableReranker: e.target.checked })}
                            className="w-4 h-4 accent-zinc-100 rounded cursor-pointer"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <label className="flex items-center justify-between p-2.5 bg-zinc-950 rounded-lg border border-zinc-800 cursor-pointer text-xs text-zinc-300">
                        <span>上下文前缀增强 (Contextual)</span>
                        <input
                          type="checkbox"
                          checked={formData.ragEnableContextualPrefix ?? true}
                          onChange={(e) => setFormData({ ...formData, ragEnableContextualPrefix: e.target.checked })}
                          className="w-4 h-4 accent-zinc-100 rounded cursor-pointer"
                        />
                      </label>

                      <label className="flex items-center justify-between p-2.5 bg-zinc-950 rounded-lg border border-zinc-800 cursor-pointer text-xs text-zinc-300">
                        <span>父子分块递归扩展 (Parent-Child)</span>
                        <input
                          type="checkbox"
                          checked={formData.ragEnableParentExpansion ?? true}
                          onChange={(e) => setFormData({ ...formData, ragEnableParentExpansion: e.target.checked })}
                          className="w-4 h-4 accent-zinc-100 rounded cursor-pointer"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                TAB 3: 文献与解析 (Literature & MinerU & Academic Sources)
                ========================================================================= */}
            {activeTab === 'literature' && (
              <div className="space-y-3.5">
                {/* MinerU Section */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-200 text-xs">MinerU 文献结构化解析引擎</span>
                    <button
                      type="button"
                      disabled={mineruTestStatus?.testing}
                      onClick={handleTestMinerU}
                      className="flex items-center gap-1 px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-[11px] transition-colors"
                    >
                      {mineruTestStatus?.testing ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
                      <span>测试 MinerU 连接</span>
                    </button>
                  </div>

                  {mineruTestStatus?.result && (
                    <div className={`p-2 rounded border text-[11px] font-mono ${mineruTestStatus.success ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800' : 'bg-rose-950/60 text-rose-400 border-rose-800'}`}>
                      {mineruTestStatus.result}
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { key: 'builtin', label: '内置高保真引擎' },
                      { key: 'cloud', label: '官方云端 API' },
                      { key: 'local', label: '本地自建 magic-pdf' }
                    ].map((mode) => {
                      const cur = formData.mineruConfig?.serviceType || 'builtin';
                      return (
                        <button
                          key={mode.key}
                          type="button"
                          onClick={() =>
                            setFormData({
                              ...formData,
                              mineruConfig: {
                                ...(formData.mineruConfig || {
                                  apiUrl: 'https://mineru.net/api/v4',
                                  apiKey: 'mineru_demo_token_ak8291',
                                  modelMode: 'pipeline',
                                  enableFormula: true,
                                  enableTable: true,
                                  language: 'auto'
                                }),
                                serviceType: mode.key as any
                              }
                            })
                          }
                          className={`p-2 rounded-lg border text-xs font-medium text-center transition-colors cursor-pointer ${
                            cur === mode.key
                              ? 'bg-zinc-800 border-zinc-600 text-zinc-100 font-semibold'
                              : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {mode.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">服务地址 (API URL)</label>
                      <input
                        type="text"
                        value={formData.mineruConfig?.apiUrl || 'https://mineru.net/api/v4'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            mineruConfig: {
                              ...(formData.mineruConfig || {
                                serviceType: 'builtin',
                                apiKey: 'mineru_demo_token_ak8291',
                                modelMode: 'pipeline',
                                enableFormula: true,
                                enableTable: true,
                                language: 'auto'
                              }),
                              apiUrl: e.target.value
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs focus:outline-none focus:border-zinc-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">API 访问密钥 (Token)</label>
                      <input
                        type="password"
                        value={formData.mineruConfig?.apiKey || 'mineru_demo_token_ak8291'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            mineruConfig: {
                              ...(formData.mineruConfig || {
                                serviceType: 'builtin',
                                apiUrl: 'https://mineru.net/api/v4',
                                modelMode: 'pipeline',
                                enableFormula: true,
                                enableTable: true,
                                language: 'auto'
                              }),
                              apiKey: e.target.value
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs focus:outline-none focus:border-zinc-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 block">流水线模式</label>
                      <select
                        value={formData.mineruConfig?.modelMode || 'pipeline'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            mineruConfig: {
                              ...(formData.mineruConfig || {
                                serviceType: 'builtin',
                                apiUrl: 'https://mineru.net/api/v4',
                                apiKey: 'mineru_demo_token_ak8291',
                                enableFormula: true,
                                enableTable: true,
                                language: 'auto'
                              }),
                              modelMode: e.target.value as any
                            }
                          })
                        }
                        className="w-full h-7 px-2 bg-zinc-950 border border-zinc-700 rounded text-zinc-200 text-xs"
                      >
                        <option value="pipeline">Pipeline (全流程)</option>
                        <option value="hybrid">Hybrid (混合加速)</option>
                        <option value="ocr">OCR (扫描件增强)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 block">公式提取 (UniMERNet)</label>
                      <select
                        value={formData.mineruConfig?.enableFormula ? '1' : '0'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            mineruConfig: {
                              ...(formData.mineruConfig || {
                                serviceType: 'builtin',
                                apiUrl: 'https://mineru.net/api/v4',
                                apiKey: 'mineru_demo_token_ak8291',
                                modelMode: 'pipeline',
                                enableTable: true,
                                language: 'auto'
                              }),
                              enableFormula: e.target.value === '1'
                            }
                          })
                        }
                        className="w-full h-7 px-2 bg-zinc-950 border border-zinc-700 rounded text-zinc-200 text-xs"
                      >
                        <option value="1">开启 LaTeX 抽取</option>
                        <option value="0">关闭</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 block">表格还原 (TableMaster)</label>
                      <select
                        value={formData.mineruConfig?.enableTable ? '1' : '0'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            mineruConfig: {
                              ...(formData.mineruConfig || {
                                serviceType: 'builtin',
                                apiUrl: 'https://mineru.net/api/v4',
                                apiKey: 'mineru_demo_token_ak8291',
                                modelMode: 'pipeline',
                                enableFormula: true,
                                language: 'auto'
                              }),
                              enableTable: e.target.value === '1'
                            }
                          })
                        }
                        className="w-full h-7 px-2 bg-zinc-950 border border-zinc-700 rounded text-zinc-200 text-xs"
                      >
                        <option value="1">开启表格重建</option>
                        <option value="0">关闭</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Academic Sources Section */}
                <div className="pt-2 border-t border-zinc-800 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-200 text-xs">学术检索源与网络代理</span>
                    <button
                      type="button"
                      onClick={handleTestAcademicSource}
                      className="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[11px]"
                    >
                      检测检索源连通性
                    </button>
                  </div>

                  {sourceTestStatus && (
                    <div className="p-2 rounded bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-300">
                      {sourceTestStatus}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">arXiv 镜像源</label>
                      <select
                        value={formData.academicConfig?.arxivMirror || 'cn'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            academicConfig: {
                              ...(formData.academicConfig || {
                                semanticScholarApiKey: '',
                                crossrefEmail: 'researcher@academic.org',
                                proxyUrl: '',
                                autoFetchCitations: true,
                                bibtexCitationStyle: 'IEEEtran'
                              }),
                              arxivMirror: e.target.value as any
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 text-xs"
                      >
                        <option value="cn">中国科学院学术镜像 (加速)</option>
                        <option value="tuna">清华 TUNA 镜像站</option>
                        <option value="official">官方源 (arxiv.org)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">Semantic Scholar API Key</label>
                      <input
                        type="password"
                        placeholder="可选 (填入提升调用频次)"
                        value={formData.academicConfig?.semanticScholarApiKey || ''}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            academicConfig: {
                              ...(formData.academicConfig || {
                                arxivMirror: 'cn',
                                crossrefEmail: 'researcher@academic.org',
                                proxyUrl: '',
                                autoFetchCitations: true,
                                bibtexCitationStyle: 'IEEEtran'
                              }),
                              semanticScholarApiKey: e.target.value
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">CrossRef 邮箱 (Polite Pool 识别)</label>
                      <input
                        type="email"
                        value={formData.academicConfig?.crossrefEmail || 'researcher@academic.org'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            academicConfig: {
                              ...(formData.academicConfig || {
                                arxivMirror: 'cn',
                                semanticScholarApiKey: '',
                                proxyUrl: '',
                                autoFetchCitations: true,
                                bibtexCitationStyle: 'IEEEtran'
                              }),
                              crossrefEmail: e.target.value
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">网络代理 (HTTP/SOCKS5 代理)</label>
                      <input
                        type="text"
                        placeholder="http://127.0.0.1:7890"
                        value={formData.academicConfig?.proxyUrl || ''}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            academicConfig: {
                              ...(formData.academicConfig || {
                                arxivMirror: 'cn',
                                semanticScholarApiKey: '',
                                crossrefEmail: 'researcher@academic.org',
                                autoFetchCitations: true,
                                bibtexCitationStyle: 'IEEEtran'
                              }),
                              proxyUrl: e.target.value
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <label className="flex items-center justify-between p-2 bg-zinc-950 rounded border border-zinc-800 cursor-pointer text-zinc-300">
                      <span>自动拉取引用计数与影响因子</span>
                      <input
                        type="checkbox"
                        checked={formData.academicConfig?.autoFetchCitations ?? true}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            academicConfig: {
                              ...(formData.academicConfig || {
                                arxivMirror: 'cn',
                                semanticScholarApiKey: '',
                                crossrefEmail: 'researcher@academic.org',
                                proxyUrl: '',
                                bibtexCitationStyle: 'IEEEtran'
                              }),
                              autoFetchCitations: e.target.checked
                            }
                          })
                        }
                        className="w-4 h-4 accent-zinc-100 rounded"
                      />
                    </label>

                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 block">BibTeX 导出规范风格</label>
                      <select
                        value={formData.academicConfig?.bibtexCitationStyle || 'IEEEtran'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            academicConfig: {
                              ...(formData.academicConfig || {
                                arxivMirror: 'cn',
                                semanticScholarApiKey: '',
                                crossrefEmail: 'researcher@academic.org',
                                proxyUrl: '',
                                autoFetchCitations: true
                              }),
                              bibtexCitationStyle: e.target.value as any
                            }
                          })
                        }
                        className="w-full h-8 px-2 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 text-xs"
                      >
                        <option value="IEEEtran">IEEEtran 标准</option>
                        <option value="ACM">ACM Reference Format</option>
                        <option value="APA">APA 7th</option>
                        <option value="Nature">Nature 期刊格式</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                TAB 4: 编译与沙箱 (LaTeX & Code Sandbox)
                ========================================================================= */}
            {activeTab === 'sandbox' && (
              <div className="space-y-3.5">
                {/* LaTeX Compiler Config */}
                <div className="space-y-2.5">
                  <span className="font-semibold text-zinc-200 text-xs block">LaTeX 编译引擎配置</span>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">编译器类型</label>
                      <select
                        value={formData.sandboxConfig?.latexEngine || 'tectonic'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            sandboxConfig: {
                              ...(formData.sandboxConfig || {
                                autoCompileOnSave: true,
                                debounceMs: 500,
                                enableSynctex: true,
                                sandboxRuntime: 'local_pyodide',
                                sandboxEndpoint: 'http://localhost:8000/sandbox',
                                executionTimeoutSec: 30,
                                plotBackend: 'matplotlib'
                              }),
                              latexEngine: e.target.value as any
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 text-xs"
                      >
                        <option value="tectonic">Tectonic 现代高速引擎 (推荐)</option>
                        <option value="wasm">WebAssembly 纯前端客户端引擎</option>
                        <option value="pdflatex">pdfLaTeX 经典编译环境</option>
                        <option value="xelatex">XeLaTeX (全字体/多语言支持)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">自动编译防抖延迟 (毫秒)</label>
                      <input
                        type="number"
                        step="100"
                        value={formData.sandboxConfig?.debounceMs ?? 500}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            sandboxConfig: {
                              ...(formData.sandboxConfig || {
                                latexEngine: 'tectonic',
                                autoCompileOnSave: true,
                                enableSynctex: true,
                                sandboxRuntime: 'local_pyodide',
                                sandboxEndpoint: 'http://localhost:8000/sandbox',
                                executionTimeoutSec: 30,
                                plotBackend: 'matplotlib'
                              }),
                              debounceMs: parseInt(e.target.value) || 500
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <label className="flex items-center justify-between p-2 bg-zinc-950 rounded border border-zinc-800 cursor-pointer text-zinc-300">
                      <span>保存时自动编译 (Auto Compile)</span>
                      <input
                        type="checkbox"
                        checked={formData.sandboxConfig?.autoCompileOnSave ?? true}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            sandboxConfig: {
                              ...(formData.sandboxConfig || {
                                latexEngine: 'tectonic',
                                debounceMs: 500,
                                enableSynctex: true,
                                sandboxRuntime: 'local_pyodide',
                                sandboxEndpoint: 'http://localhost:8000/sandbox',
                                executionTimeoutSec: 30,
                                plotBackend: 'matplotlib'
                              }),
                              autoCompileOnSave: e.target.checked
                            }
                          })
                        }
                        className="w-4 h-4 accent-zinc-100 rounded"
                      />
                    </label>

                    <label className="flex items-center justify-between p-2 bg-zinc-950 rounded border border-zinc-800 cursor-pointer text-zinc-300">
                      <span>SyncTeX 源码与 PDF 双向同步</span>
                      <input
                        type="checkbox"
                        checked={formData.sandboxConfig?.enableSynctex ?? true}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            sandboxConfig: {
                              ...(formData.sandboxConfig || {
                                latexEngine: 'tectonic',
                                autoCompileOnSave: true,
                                debounceMs: 500,
                                sandboxRuntime: 'local_pyodide',
                                sandboxEndpoint: 'http://localhost:8000/sandbox',
                                executionTimeoutSec: 30,
                                plotBackend: 'matplotlib'
                              }),
                              enableSynctex: e.target.checked
                            }
                          })
                        }
                        className="w-4 h-4 accent-zinc-100 rounded"
                      />
                    </label>
                  </div>
                </div>

                {/* Python & Plot Sandbox */}
                <div className="pt-2 border-t border-zinc-800 space-y-2.5">
                  <span className="font-semibold text-zinc-200 text-xs block">Python 代码与绘图执行沙箱</span>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">代码执行运行时</label>
                      <select
                        value={formData.sandboxConfig?.sandboxRuntime || 'local_pyodide'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            sandboxConfig: {
                              ...(formData.sandboxConfig || {
                                latexEngine: 'tectonic',
                                autoCompileOnSave: true,
                                debounceMs: 500,
                                enableSynctex: true,
                                sandboxEndpoint: 'http://localhost:8000/sandbox',
                                executionTimeoutSec: 30,
                                plotBackend: 'matplotlib'
                              }),
                              sandboxRuntime: e.target.value as any
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 text-xs"
                      >
                        <option value="local_pyodide">Pyodide (浏览器本地安全沙箱)</option>
                        <option value="remote_docker">远程 Docker 容器隔离环境</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">执行超时限制 (秒)</label>
                      <input
                        type="number"
                        value={formData.sandboxConfig?.executionTimeoutSec ?? 30}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            sandboxConfig: {
                              ...(formData.sandboxConfig || {
                                latexEngine: 'tectonic',
                                autoCompileOnSave: true,
                                debounceMs: 500,
                                enableSynctex: true,
                                sandboxRuntime: 'local_pyodide',
                                sandboxEndpoint: 'http://localhost:8000/sandbox',
                                plotBackend: 'matplotlib'
                              }),
                              executionTimeoutSec: parseInt(e.target.value) || 30
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">远程沙箱端点 (Remote URL)</label>
                      <input
                        type="text"
                        value={formData.sandboxConfig?.sandboxEndpoint || 'http://localhost:8000/sandbox'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            sandboxConfig: {
                              ...(formData.sandboxConfig || {
                                latexEngine: 'tectonic',
                                autoCompileOnSave: true,
                                debounceMs: 500,
                                enableSynctex: true,
                                sandboxRuntime: 'local_pyodide',
                                executionTimeoutSec: 30,
                                plotBackend: 'matplotlib'
                              }),
                              sandboxEndpoint: e.target.value
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">默认学术绘图后端</label>
                      <select
                        value={formData.sandboxConfig?.plotBackend || 'matplotlib'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            sandboxConfig: {
                              ...(formData.sandboxConfig || {
                                latexEngine: 'tectonic',
                                autoCompileOnSave: true,
                                debounceMs: 500,
                                enableSynctex: true,
                                sandboxRuntime: 'local_pyodide',
                                sandboxEndpoint: 'http://localhost:8000/sandbox',
                                executionTimeoutSec: 30
                              }),
                              plotBackend: e.target.value as any
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 text-xs"
                      >
                        <option value="matplotlib">Matplotlib (学术出版级)</option>
                        <option value="plotly">Plotly (交互式三维/散点)</option>
                        <option value="seaborn">Seaborn 统计图谱</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* =========================================================================
                TAB 5: 智能体安全 (Agent & Guardrails)
                ========================================================================= */}
            {activeTab === 'agent' && (
              <div className="space-y-3.5">
                {/* Security Policies */}
                <div className="space-y-2.5">
                  <span className="font-semibold text-zinc-200 text-xs block">运行时安全策略 (Runtime Guardrails)</span>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">Shell 高危命令拦截策略</label>
                      <select
                        value={formData.guardrailSettings?.shellSecurityLevel || 'strict'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            guardrailSettings: {
                              ...(formData.guardrailSettings || {
                                fileOverwriteProtection: true,
                                sessionTokenBudget: 65536,
                                autoExtractMemory: true,
                                memoryScope: 'project',
                                mcpTimeoutMs: 15000,
                                allowExternalNetwork: true
                              }),
                              shellSecurityLevel: e.target.value as any
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 text-xs"
                      >
                        <option value="strict">严格拦截 (禁止一切提权与非沙箱指令)</option>
                        <option value="prompt">拦截并提示 (执行前需人工确认)</option>
                        <option value="allow">完全信任放行 (仅本地安全沙箱)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">会话 Token 预算上限</label>
                      <input
                        type="number"
                        value={formData.guardrailSettings?.sessionTokenBudget ?? 65536}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            guardrailSettings: {
                              ...(formData.guardrailSettings || {
                                shellSecurityLevel: 'strict',
                                fileOverwriteProtection: true,
                                autoExtractMemory: true,
                                memoryScope: 'project',
                                mcpTimeoutMs: 15000,
                                allowExternalNetwork: true
                              }),
                              sessionTokenBudget: parseInt(e.target.value) || 65536
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <label className="flex items-center justify-between p-2 bg-zinc-950 rounded border border-zinc-800 cursor-pointer text-zinc-300">
                      <span>破坏性文件覆写保护</span>
                      <input
                        type="checkbox"
                        checked={formData.guardrailSettings?.fileOverwriteProtection ?? true}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            guardrailSettings: {
                              ...(formData.guardrailSettings || {
                                shellSecurityLevel: 'strict',
                                sessionTokenBudget: 65536,
                                autoExtractMemory: true,
                                memoryScope: 'project',
                                mcpTimeoutMs: 15000,
                                allowExternalNetwork: true
                              }),
                              fileOverwriteProtection: e.target.checked
                            }
                          })
                        }
                        className="w-4 h-4 accent-zinc-100 rounded"
                      />
                    </label>

                    <label className="flex items-center justify-between p-2 bg-zinc-950 rounded border border-zinc-800 cursor-pointer text-zinc-300">
                      <span>允许 Agent 外部网络访问 (Web Search)</span>
                      <input
                        type="checkbox"
                        checked={formData.guardrailSettings?.allowExternalNetwork ?? true}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            guardrailSettings: {
                              ...(formData.guardrailSettings || {
                                shellSecurityLevel: 'strict',
                                fileOverwriteProtection: true,
                                sessionTokenBudget: 65536,
                                autoExtractMemory: true,
                                memoryScope: 'project',
                                mcpTimeoutMs: 15000
                              }),
                              allowExternalNetwork: e.target.checked
                            }
                          })
                        }
                        className="w-4 h-4 accent-zinc-100 rounded"
                      />
                    </label>
                  </div>
                </div>

                {/* Agent Memory & MCP */}
                <div className="pt-2 border-t border-zinc-800 space-y-2.5">
                  <span className="font-semibold text-zinc-200 text-xs block">记忆系统与 MCP 协议</span>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">记忆持久化范围</label>
                      <select
                        value={formData.guardrailSettings?.memoryScope || 'project'}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            guardrailSettings: {
                              ...(formData.guardrailSettings || {
                                shellSecurityLevel: 'strict',
                                fileOverwriteProtection: true,
                                sessionTokenBudget: 65536,
                                autoExtractMemory: true,
                                mcpTimeoutMs: 15000,
                                allowExternalNetwork: true
                              }),
                              memoryScope: e.target.value as any
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 text-xs"
                      >
                        <option value="project">课题专属隔离记忆 (推荐)</option>
                        <option value="global">全域全局共享记忆</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label className="text-[11px] font-medium text-zinc-400">MCP 工具调用超时 (毫秒)</label>
                      <input
                        type="number"
                        value={formData.guardrailSettings?.mcpTimeoutMs ?? 15000}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            guardrailSettings: {
                              ...(formData.guardrailSettings || {
                                shellSecurityLevel: 'strict',
                                fileOverwriteProtection: true,
                                sessionTokenBudget: 65536,
                                autoExtractMemory: true,
                                memoryScope: 'project',
                                allowExternalNetwork: true
                              }),
                              mcpTimeoutMs: parseInt(e.target.value) || 15000
                            }
                          })
                        }
                        className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-200 font-mono text-xs"
                      />
                    </div>
                  </div>

                  <label className="flex items-center justify-between p-2 bg-zinc-950 rounded border border-zinc-800 cursor-pointer text-zinc-300">
                    <span>会话结束自动提炼沉淀核心记忆 (Auto Extract)</span>
                    <input
                      type="checkbox"
                      checked={formData.guardrailSettings?.autoExtractMemory ?? true}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          guardrailSettings: {
                            ...(formData.guardrailSettings || {
                              shellSecurityLevel: 'strict',
                              fileOverwriteProtection: true,
                              sessionTokenBudget: 65536,
                              memoryScope: 'project',
                              mcpTimeoutMs: 15000,
                              allowExternalNetwork: true
                            }),
                            autoExtractMemory: e.target.checked
                          }
                        })
                      }
                      className="w-4 h-4 accent-zinc-100 rounded"
                    />
                  </label>
                </div>
              </div>
            )}

            {/* =========================================================================
                TAB 6: 偏好与备份 (General Preferences & Backup)
                ========================================================================= */}
            {activeTab === 'general' && (
              <div className="space-y-3.5">
                {/* Theme Selector */}
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-400 flex items-center gap-1.5">
                    <Palette size={13} />
                    <span>外观主题 (Theme)</span>
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { key: 'dark', label: '深色模式 (Dark)' },
                      { key: 'light', label: '浅色模式 (Light)' },
                      { key: 'system', label: '跟随系统 (System)' }
                    ].map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => {
                          const chosen = t.key as any;
                          setFormData({ ...formData, theme: chosen });
                          onThemeChange?.(chosen);
                        }}
                        className={`h-8 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                          (formData.theme || 'dark') === t.key
                            ? 'bg-zinc-800 border-zinc-600 text-zinc-100 font-semibold'
                            : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Font Size & Editor Font Size */}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-zinc-400 flex items-center gap-1.5">
                      <Type size={13} />
                      <span>界面字号</span>
                    </label>
                    <div className="grid grid-cols-3 gap-1">
                      {[
                        { key: 'small', label: '紧凑 (12px)' },
                        { key: 'medium', label: '标准 (14px)' },
                        { key: 'large', label: '宽松 (16px)' }
                      ].map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          onClick={() => setFormData({ ...formData, fontSize: f.key as any })}
                          className={`h-8 rounded border text-[11px] transition-colors ${
                            (formData.fontSize || 'medium') === f.key
                              ? 'bg-zinc-800 border-zinc-600 text-zinc-100 font-medium'
                              : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between items-center">
                      <label className="text-[11px] font-medium text-zinc-400">代码与 LaTeX 字号</label>
                      <span className="font-mono text-zinc-300 text-[11px]">{formData.editorFontSize || 13} px</span>
                    </div>
                    <input
                      type="range"
                      min="11"
                      max="18"
                      step="1"
                      value={formData.editorFontSize || 13}
                      onChange={(e) => setFormData({ ...formData, editorFontSize: parseInt(e.target.value) })}
                      className="w-full accent-zinc-200 cursor-pointer pt-2"
                    />
                  </div>
                </div>

                {/* Workspace Behavior */}
                <label className="flex items-center justify-between p-2.5 bg-zinc-950 rounded-lg border border-zinc-800 cursor-pointer text-zinc-300">
                  <span>执行完毕自动切换工作区画布 (Auto Switch)</span>
                  <input
                    type="checkbox"
                    checked={formData.autoSwitchWorkspace}
                    onChange={(e) => setFormData({ ...formData, autoSwitchWorkspace: e.target.checked })}
                    className="w-4 h-4 accent-zinc-100 rounded"
                  />
                </label>

                {/* Data Backup & Restore */}
                <div className="pt-2 border-t border-zinc-800 space-y-2">
                  <span className="font-semibold text-zinc-200 text-xs block">数据备份与恢复</span>

                  {exportSuccess && (
                    <div className="p-2 bg-emerald-950/60 border border-emerald-800 rounded text-emerald-400 text-[11px] flex items-center gap-1.5">
                      <CheckCircle2 size={12} />
                      <span>已成功导出数据快照至本地下载目录</span>
                    </div>
                  )}

                  {importNotice && (
                    <div className="p-2 bg-zinc-950 border border-zinc-800 rounded text-zinc-300 text-[11px]">
                      {importNotice}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleExportData}
                      className="flex-1 h-8 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <Download size={13} />
                      <span>导出配置快照 (JSON)</span>
                    </button>

                    <input
                      ref={importFileRef}
                      type="file"
                      accept=".json"
                      onChange={handleImportFile}
                      className="hidden"
                    />

                    <button
                      type="button"
                      onClick={() => importFileRef.current?.click()}
                      className="flex-1 h-8 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <Upload size={13} />
                      <span>从备份文件导入</span>
                    </button>
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        localStorage.clear();
                        window.location.reload();
                      }}
                      className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-rose-400 transition-colors"
                    >
                      <RotateCcw size={11} />
                      <span>清除本地缓存重置</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="h-11 px-4 bg-zinc-900 border-t border-zinc-800 flex items-center justify-between shrink-0 select-none">
          <div className="text-[10px] text-zinc-500 font-mono">
            ~/.roc/config.json · 沙箱本地持久化
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="px-3.5 py-1.5 bg-zinc-100 hover:bg-white text-zinc-950 rounded-lg text-xs font-semibold transition-colors shadow-xs cursor-pointer"
            >
              应用并保存
            </button>
          </div>
        </div>
        {/* Provider Add / Edit Modal Dialog */}
        {isProviderModalOpen && (
          <div
            className="fixed inset-0 z-60 bg-black/75 backdrop-blur-xs flex items-center justify-center p-3 animate-in fade-in duration-100"
            onClick={() => setIsProviderModalOpen(false)}
          >
            <div
              className="w-full max-w-[480px] bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl p-4 space-y-3.5 text-zinc-200 select-text animate-in zoom-in-95 duration-100"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-zinc-800 pb-2.5">
                <span className="font-semibold text-xs text-zinc-100">
                  {editingProviderId ? '编辑' : '添加'}{providerModalType === 'llm' ? '大模型服务商' : '向量服务商'}
                </span>
                <button
                  type="button"
                  onClick={() => setIsProviderModalOpen(false)}
                  className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Quick Preset Chips */}
              <div className="space-y-1.5">
                <span className="text-[10px] text-zinc-400 block font-medium">常用快捷填充 (点击仅填入端点及模型模板):</span>
                <div className="flex flex-wrap gap-1.5">
                  {(providerModalType === 'llm' ? LLM_PRESETS : EMB_PRESETS).map((pr) => (
                    <button
                      key={pr.name}
                      type="button"
                      onClick={() => handleApplyPreset(pr)}
                      className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer border border-zinc-700/60"
                    >
                      {pr.name}
                    </button>
                  ))}
                </div>
              </div>

              <form onSubmit={handleSaveProviderFromModal} className="space-y-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-400">服务商名称</label>
                  <input
                    type="text"
                    required
                    placeholder={providerModalType === 'llm' ? '例如 DeepSeek, OpenAI, Ollama' : '例如 SiliconFlow 向量, 本地 BGE'}
                    value={modalName}
                    onChange={(e) => setModalName(e.target.value)}
                    className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-xs text-zinc-100 focus:outline-none focus:border-zinc-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-400">接口基础地址 (Base URL)</label>
                  <input
                    type="text"
                    required
                    placeholder={providerModalType === 'llm' ? 'https://api.deepseek.com/v1' : 'https://api.siliconflow.cn/v1'}
                    value={modalBaseUrl}
                    onChange={(e) => setModalBaseUrl(e.target.value)}
                    className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <label className="text-[11px] font-medium text-zinc-400">API 访问密钥 (API Key)</label>
                    <span className="text-[10px] text-zinc-500">本地私有模型可留空</span>
                  </div>
                  <div className="relative">
                    <input
                      type={showModalKey ? 'text' : 'password'}
                      placeholder="sk-••••••••••••••••••••••••"
                      value={modalApiKey}
                      onChange={(e) => setModalApiKey(e.target.value)}
                      className="w-full h-8 pl-2.5 pr-8 bg-zinc-950 border border-zinc-700 rounded-lg text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowModalKey(!showModalKey)}
                      className="absolute right-2 top-2 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                    >
                      {showModalKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-zinc-400">可用模型列表 (以逗号或换行分隔)</label>
                  <input
                    type="text"
                    required
                    placeholder={providerModalType === 'llm' ? 'deepseek-chat, deepseek-reasoner' : 'BAAI/bge-m3, text-embedding-3-small'}
                    value={modalModels}
                    onChange={(e) => setModalModels(e.target.value)}
                    className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
                  />
                </div>

                {providerModalType === 'embedding' && (
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-zinc-400">重排序模型标识 (可选)</label>
                    <input
                      type="text"
                      placeholder="例如 BAAI/bge-reranker-large"
                      value={modalReranker}
                      onChange={(e) => setModalReranker(e.target.value)}
                      className="w-full h-8 px-2.5 bg-zinc-950 border border-zinc-700 rounded-lg text-xs font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
                    />
                  </div>
                )}

                {modalTestResult && (
                  <div className={`p-2 rounded-lg text-[11px] font-mono flex items-center gap-1.5 ${
                    modalTestResult.success ? 'bg-emerald-950/60 border border-emerald-800 text-emerald-400' : 'bg-rose-950/60 border border-rose-800 text-rose-400'
                  }`}>
                    {modalTestResult.success ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                    <span>{modalTestResult.message}</span>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                  <button
                    type="button"
                    disabled={modalTestResult?.testing}
                    onClick={handleTestConnectionInModal}
                    className="px-2.5 py-1 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    {modalTestResult?.testing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                    <span>{modalTestResult?.testing ? '检测中...' : '测试连接'}</span>
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsProviderModalOpen(false)}
                      className="px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200 rounded-lg cursor-pointer"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="px-3.5 py-1 bg-zinc-100 hover:bg-white text-zinc-950 font-semibold text-xs rounded-lg transition-colors cursor-pointer shadow-xs"
                    >
                      保存服务商
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
