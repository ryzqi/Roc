import type { TraySummary } from '../../../shared/types';
import { Row } from '../../components/Row';

export function TraySummaryPanel({ traySummary }: { traySummary: TraySummary }): React.JSX.Element {
  return (
    <section className="section" data-testid="tray-summary">
      <div className="section-head">
        <h2 className="section-title">托盘摘要</h2>
      </div>
      <div className="list-rows">
        <Row title="常驻" sub={traySummary.residentEnabled ? '已启用' : '未启用'} tag="resident" tone="ok" />
        <Row
          title="后台执行"
          sub={traySummary.backgroundPaused ? '已暂停' : '运行中'}
          tag={`${traySummary.backgroundTasks.total} tasks`}
          tone={traySummary.backgroundPaused ? 'warn' : 'ok'}
        />
        <Row title="下次运行" sub={traySummary.nextRunAt === null ? '无' : traySummary.nextRunAt} tag="schedule" tone="info" />
      </div>
    </section>
  );
}
