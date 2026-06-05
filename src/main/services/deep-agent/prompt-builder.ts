/**
 * 提示块稳定性级别，决定缓存失效边界
 */
export enum BlockStability {
  STATIC = 'static',           // 跨所有会话不变
  WORKSPACE = 'workspace',     // 工作区级稳定
  SESSION = 'session',         // 会话级稳定
  CAPABILITY = 'capability',   // 能力集变化时失效
  REQUEST = 'request'          // 每请求重建
}

/**
 * 系统提示的可缓存块
 */
export interface PromptBlock {
  type: 'static' | 'workspace' | 'tools' | 'snapshot' | 'capability';
  content: string;
  stability: BlockStability;
  hash: string;  // SHA-256 前 16 字符
  metadata?: {
    tokenEstimate?: number;
    lastModified?: string;
  };
}

/**
 * 缓存节省指标
 */
export interface CacheSavings {
  percentSaved: number;  // 0-100
  tokensSaved: number;
}
