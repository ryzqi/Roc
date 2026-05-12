import type { DiagnosticPackage } from '../../../shared/types';
import { Row } from '../../components/Row';

export function DiagnosticPackagePanel({ diagnosticPackage }: { diagnosticPackage: DiagnosticPackage | null }): React.JSX.Element {
  return (
    <section className="card" data-testid="diagnostic-package-status">
      <div className="card-title">诊断包</div>
      {diagnosticPackage === null ? (
        <p className="muted">尚未生成诊断包。</p>
      ) : (
        <>
          <Row title="任务" sub={diagnosticPackage.taskId} tag={diagnosticPackage.id} tone="info" />
          <Row title="脱敏" sub={diagnosticPackage.redacted ? '通过' : '未通过'} tag={diagnosticPackage.redacted ? '通过' : '失败'} tone={diagnosticPackage.redacted ? 'ok' : 'bad'} />
          <Row title="包含项" sub={diagnosticPackage.includes.join(', ')} tag="task_snapshot" tone="ok" />
          <Row title="路径" sub={diagnosticPackage.path} tag="本地" tone="info" />
        </>
      )}
    </section>
  );
}
