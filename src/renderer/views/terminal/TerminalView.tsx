import { CompactStatusPill } from '../../components/CompactStatusPill';
import { PageHeading } from '../../components/PageHeading';
import { Row } from '../../components/Row';
import { visibleWorkspaceCwd } from '../../app/view-routing';
import type { LoadedState } from '../../loaded-state';

export function TerminalView({ state }: { state: LoadedState }): React.JSX.Element {
  return (
    <>
      <PageHeading title="嵌入式终端" meta={`cwd · ${visibleWorkspaceCwd(state)}`} />
      <section className="canvas-stage stage-grid" data-testid="terminal-view">
        <section className="section">
          <div className="section-head">
            <h2 className="section-title">命令执行边界</h2>
            <CompactStatusPill tone="ok" value={`cwd: ${visibleWorkspaceCwd(state)}`} />
          </div>
          <div className="list-rows">
            <Row title="目的" sub="读取当前工作区状态并保留任务轨迹" tag="可见" tone="info" />
            <Row title="风险" sub="低风险命令直接执行，高风险命令进入确认策略" tag={state.rtkStatus.resourceState === 'ready' ? '低' : '缺失降级'} tone={state.rtkStatus.resourceState === 'ready' ? 'ok' : 'warn'} />
            <Row title="记录" sub="命令、输出、退出码写入任务轨迹" tag="开启" tone="ok" />
          </div>
        </section>
        <div className="terminal-surface terminal terminal--main" data-testid="terminal-raw-output">
          {state.workspace === null
            ? '未选择工作区。'
            : state.terminalSession === null
              ? '在聊天页右侧打开 Terminal 后建立真实终端会话。'
              : `${state.terminalSession.shell} ${state.terminalSession.cols}x${state.terminalSession.rows} (${state.terminalSession.status})`}
        </div>
      </section>
    </>
  );
}
