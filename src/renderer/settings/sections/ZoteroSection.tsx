import {useState} from 'react';
import type {RocClient} from '../../shared/roc-client';
import {useAsyncResource} from '../../app/use-async-resource';
import {formSecondaryButtonClass} from '../../shared/form-ui';
import {AlertTriangle} from 'lucide-react';
import type {ZoteroStatus} from '../../../shared/schemas/research-zotero';

const CONNECTION_LABELS: Record<ZoteroStatus['connection']['status'], string> = {
  connected: '已连接', disabled: '未启用通信', unreachable: '不可达',
  unsupported: '版本不支持', invalid_response: '响应无效'
};

export function ZoteroSection({client}: {client: RocClient}): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const resource = useAsyncResource(attempt === 0 ? null : `settings:zotero:${attempt}`,
    () => client.api.research.getZoteroStatus({}), {label: '检测 Zotero'});
  // A new probe must not display the previous connection as current.
  const status = resource.status === 'ready' ? resource.data : null;
  const connection = status?.connection;
  return (
    <section className="flex flex-col gap-2 border-t-[0.5px] border-line pt-3" aria-label="Zotero" data-testid="settings-zotero">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[length:var(--font-body-size)] font-medium text-ink">Zotero</h3>
        <button type="button" className={`${formSecondaryButtonClass} border-[0.5px]`} disabled={resource.status === 'loading'}
          data-testid="settings-zotero-check" onClick={() => setAttempt(current => current + 1)}>
          {resource.status === 'loading' ? '检测中…' : '检测连接'}
        </button>
      </div>
      {status === null ? null : (
        <dl className="flex flex-col gap-1 text-[length:var(--font-meta-size)]" data-testid="settings-zotero-status">
          <StatusRow label="应用目录" testId="settings-zotero-installation"
            value={status.installation.status === 'found' ? `已发现（${status.installation.location === 'system' ? '系统' : '用户'}应用目录）` : '常用应用目录未发现 Zotero'} />
          <StatusRow label="本地 API" value={CONNECTION_LABELS[status.connection.status]} testId="settings-zotero-connection" />
          {status.connection.status === 'connected' ? (
            <>
              <StatusRow label="接口版本" value={`API ${status.connection.apiVersion}`} testId="settings-zotero-api" />
              <StatusRow label="能力" value="读取文库、集合、题录并预览收录" testId="settings-zotero-capabilities" />
            </>
          ) : null}
        </dl>
      )}
      {connection?.status === 'disabled' ? <p className="text-[length:var(--font-meta-size)] text-muted" data-testid="settings-zotero-help">
        在 Zotero 的高级设置中允许其他应用通信，然后重新检测。
      </p> : connection?.status === 'unreachable' ? <p className="text-[length:var(--font-meta-size)] text-muted" data-testid="settings-zotero-help">
        打开 Zotero 后重新检测。应用目录检测范围为 /Applications 与 ~/Applications。
      </p> : connection?.status === 'unsupported' ? <p className="text-[length:var(--font-meta-size)] text-muted" data-testid="settings-zotero-help">
        需要支持实例标识的 Zotero 10 或更新版本。
      </p> : connection?.status === 'invalid_response' ? <p className="text-[length:var(--font-meta-size)] text-muted" data-testid="settings-zotero-help">
        本地服务响应不符合 Zotero API 合同，请检查客户端。
      </p> : null}
      {resource.error === null ? null : <p role="alert" className="flex items-start gap-1 text-[length:var(--font-meta-size)] text-[var(--st-warn)]" data-testid="settings-zotero-error"><AlertTriangle size={14} aria-hidden="true" />{resource.error}</p>}
    </section>
  );
}

function StatusRow({label, value, testId}: {label: string; value: string; testId: string}): React.JSX.Element {
  return <div className="flex gap-3" data-testid={testId}>
    <dt className="w-24 shrink-0 text-subtle">{label}</dt>
    <dd className="min-w-0 break-words text-muted">{value}</dd>
  </div>;
}
