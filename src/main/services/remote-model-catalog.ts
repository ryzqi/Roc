import { RocDomainError } from './errors';

/**
 * 「这个端点上到底有哪些模型」 (P10)。
 *
 * 设置页让用户手填端点与模型标识，但没有人记得住 `deepseek-chat` 与
 * `deepseek-reasoner` 的拼写，而拼错一个字符的后果是运行时 404。OpenAI-compatible
 * 家族都提供 `GET <base>/models`，所以这里只做一件事：取回那个列表，让用户勾选。
 *
 * ## 为什么容忍两种形状
 *
 * - OpenAI / DeepSeek / vLLM / LM Studio / Ollama（`/v1/models`）：`{ data: [{ id, owned_by }] }`
 * - 部分自建网关与 Ollama 原生 `/api/tags`：`{ models: [{ name }] }`
 *
 * 两者都归一成 `{ id, ownedBy }`，`id` 优先取 `id`，其次 `name`。形状不认识时抛
 * `remote_model_list_malformed`，而不是返回空列表——空列表会被读成「这个端点没有模型」，
 * 那是另一种事实。
 *
 * ## 401/404 是两件事
 *
 * 401 说明端点对但凭据不对（用户能改），404 说明路径不对（用户该检查端点是不是少了
 * `/v1`）。错误消息带上 HTTP 状态码，因为这是用户唯一能自查的线索。
 */

export type RemoteModelEntry = { id: string; ownedBy: string | null };

export type RemoteModelListResult = {
  endpoint: string;
  models: RemoteModelEntry[];
  latencyMs: number;
};

const requestTimeoutMs = 20_000;

function trimSlashes(value: string): string {
  return value.replace(/\/+$/u, '');
}

/** `https://x/v1` → `https://x/v1/models`；已经指向 `/models` 的原样返回。 */
export function resolveModelListUrl(endpoint: string): string {
  const base = trimSlashes(endpoint.trim());
  if (base.endsWith('/models')) {
    return base;
  }
  return `${base}/models`;
}

/**
 * 发请求前的最后一次校验，然后把 URL 原样交给 fetch。
 *
 * SSRF 的常规防御是「主机白名单」，这里刻意不做：模型端点本来就是用户自己填的
 * （`http://127.0.0.1:1234/v1` 这类本机推理服务是主要用例之一），把 loopback 或私有网段
 * 禁掉会让功能对目标用户不可用。所以这里守的是另外三件事：协议只能是 http/https、
 * URL 里不能夹带凭据（凭据走 Authorization 头）、以及不接受非 URL 的字符串。
 * 与 `web_read` 的公开 URL 白名单不同：那是把任意网页内容读进来（跨信任边界），
 * 这里只是把用户自己的端点列一下模型。
 */
function requireModelListUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RocDomainError({
      code: 'remote_model_endpoint_invalid',
      message: `不是合法的 URL：${raw}`,
      category: 'validation',
      retryable: false,
      userAction: '检查接入地址是否拼写正确。'
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RocDomainError({
      code: 'remote_model_endpoint_invalid',
      message: `只支持 http/https：${raw}`,
      category: 'validation',
      retryable: false,
      userAction: '把接入地址改成 http:// 或 https:// 开头。'
    });
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new RocDomainError({
      code: 'remote_model_endpoint_invalid',
      message: '接入地址里不要写用户名或密码。',
      category: 'validation',
      retryable: false,
      userAction: '凭据请填在 API Key 一栏（保存在系统钥匙串里）。'
    });
  }
  return parsed.toString();
}

function readEntries(payload: unknown): RemoteModelEntry[] | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : null;
  if (rows === null) {
    return null;
  }
  const entries: RemoteModelEntry[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      if (row.trim().length > 0) {
        entries.push({ id: row.trim(), ownedBy: null });
      }
      continue;
    }
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const item = row as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : null;
    if (id === null || id.trim().length === 0) {
      continue;
    }
    const ownedByRaw = item.owned_by ?? item.ownedBy;
    entries.push({ id: id.trim(), ownedBy: typeof ownedByRaw === 'string' && ownedByRaw.length > 0 ? ownedByRaw : null });
  }
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

export async function listRemoteModels(input: {
  endpoint: string;
  apiKey: string | null;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<RemoteModelListResult> {
  const endpoint = trimSlashes(input.endpoint.trim());
  if (endpoint.length === 0) {
    throw new RocDomainError({
      code: 'remote_model_endpoint_empty',
      message: '请先填写接入地址。',
      category: 'validation',
      retryable: false,
      userAction: '在上面的「接入地址」里填入例如 https://api.openai.com/v1。'
    });
  }
  if (!/^https?:\/\//u.test(endpoint)) {
    throw new RocDomainError({
      code: 'remote_model_endpoint_invalid',
      message: '接入地址必须以 http:// 或 https:// 开头。',
      category: 'validation',
      retryable: false,
      userAction: '补上协议前缀后重试。'
    });
  }

  const url = resolveModelListUrl(endpoint);
  // pi-lens-ignore: ts-ssrf — 默认 fetch 只是一个透传实现；真正发出请求前的校验在 requestModels → requireModelListUrl（协议/凭据），主机不能白名单化因为本机推理服务是主要用例
  const fetchImpl = input.fetchImpl ?? ((target: string, init: RequestInit) => fetch(target, init));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.apiKey !== null && input.apiKey.length > 0) {
    headers.authorization = `Bearer ${input.apiKey}`;
  }
  // 先过校验再计时：地址不合法时应该直接报「地址不合法」，而不是被下面的
  // 连接失败分支包成「无法连接 https://…」——后者会让用户去查网络。
  const target = requireModelListUrl(url);
  const startedAt = Date.now();
  let response: Response;
  try {
    // pi-lens-ignore: ts-ssrf — 已由 requireModelListUrl 校验过协议与凭据
    response = await fetchImpl(target, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
  } catch (error) {
    throw new RocDomainError({
      code: 'remote_model_list_unreachable',
      message: `无法连接 ${url}：${error instanceof Error ? error.message : String(error)}`,
      category: 'external',
      retryable: true,
      userAction: '检查端点地址、网络与本地服务是否在运行。'
    });
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new RocDomainError({
      code: 'remote_model_list_http_error',
      message: `读取模型列表失败：HTTP ${response.status}${detail.length > 0 ? ` ${detail}` : ''}`,
      category: 'external',
      retryable: response.status >= 500 || response.status === 429,
      userAction:
        response.status === 401 || response.status === 403
          ? '端点可达，但凭据被拒绝：请先保存 API Key 再拉取。'
          : '确认接入地址是否需要带 /v1 这类前缀。'
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RocDomainError({
      code: 'remote_model_list_malformed',
      message: `${url} 返回的不是 JSON。`,
      category: 'external',
      retryable: false,
      userAction: '确认该地址是 OpenAI-compatible 的 /models 接口。'
    });
  }
  const models = readEntries(payload);
  if (models === null) {
    throw new RocDomainError({
      code: 'remote_model_list_malformed',
      message: `${url} 的响应里没有 data / models 数组。`,
      category: 'external',
      retryable: false,
      userAction: '确认该地址是 OpenAI-compatible 的 /models 接口。'
    });
  }
  return { endpoint: url, models, latencyMs: Date.now() - startedAt };
}
