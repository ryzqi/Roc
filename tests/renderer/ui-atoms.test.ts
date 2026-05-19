import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompactStatusPill } from '../../src/renderer/components/CompactStatusPill';
import { Metric } from '../../src/renderer/components/Metric';
import { PageHeading } from '../../src/renderer/components/PageHeading';
import { Row } from '../../src/renderer/components/Row';
import { StatusPill } from '../../src/renderer/components/StatusPill';
import { ToolRow } from '../../src/renderer/components/ToolRow';

describe('renderer ui atoms', () => {
  it('renders status pills without legacy dot nodes', () => {
    const fullHtml = renderToStaticMarkup(
      React.createElement(StatusPill, { label: '状态', value: '正常', tone: 'ok' })
    );
    const compactHtml = renderToStaticMarkup(
      React.createElement(CompactStatusPill, { className: 'pill', value: '已启用', tone: 'info' })
    );

    expect(fullHtml).toContain('status-pill ok');
    expect(fullHtml).toContain('状态');
    expect(fullHtml).toContain('正常');
    expect(fullHtml).not.toContain('status-dot');

    expect(compactHtml).toContain('pill info');
    expect(compactHtml).not.toContain('status-pill info');
    expect(compactHtml).toContain('已启用');
    expect(compactHtml).not.toContain('status-dot');
  });

  it('renders page heading without legacy kicker placeholders and supports meta text', () => {
    const html = renderToStaticMarkup(
      React.createElement(PageHeading, {
        title: '任务工作台',
        meta: '本机 3 个工作区 · 12 条历史'
      })
    );

    expect(html).toContain('page-title');
    expect(html).toContain('任务工作台');
    expect(html).toContain('page-meta');
    expect(html).toContain('本机 3 个工作区 · 12 条历史');
    expect(html).not.toContain('page-kicker');
    expect(html).not.toContain('工作区内');
    expect(html).not.toContain('右侧图标栏展开');
    expect(html).not.toContain('控制面');
  });

  it('renders metric, row, and tool row with shared semantic slots', () => {
    const metricHtml = renderToStaticMarkup(
      React.createElement(Metric, {
        label: '失败',
        note: '需要处理',
        tone: 'bad',
        value: 2
      })
    );
    const rowHtml = renderToStaticMarkup(
      React.createElement(Row, {
        title: '当前工作区',
        sub: 'F:\\Code\\Roc',
        tag: '已选择',
        tone: 'ok'
      })
    );
    const toolRowHtml = renderToStaticMarkup(
      React.createElement(ToolRow, {
        label: 'web_read',
        value: 'ready',
        tone: 'info'
      })
    );

    expect(metricHtml).toContain('metric-value');
    expect(metricHtml).toContain('metric-label');
    expect(metricHtml).toContain('metric-note');
    expect(rowHtml).toContain('row-copy');
    expect(rowHtml).toContain('row-title');
    expect(rowHtml).toContain('row-sub');
    expect(toolRowHtml).toContain('tool-row-label');
    expect(toolRowHtml).toContain('tool-row-value');
  });
});
