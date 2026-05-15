import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompactStatusPill } from '../../src/renderer/components/CompactStatusPill';
import { PageHeading } from '../../src/renderer/components/PageHeading';
import { StatusPill } from '../../src/renderer/components/StatusPill';

describe('renderer ui atoms', () => {
  it('renders status pills without legacy dot nodes', () => {
    const fullHtml = renderToStaticMarkup(
      React.createElement(StatusPill, { label: '状态', value: '正常', tone: 'ok' })
    );
    const compactHtml = renderToStaticMarkup(
      React.createElement(CompactStatusPill, { value: '已启用', tone: 'info' })
    );

    expect(fullHtml).toContain('status-pill ok');
    expect(fullHtml).toContain('状态');
    expect(fullHtml).toContain('正常');
    expect(fullHtml).not.toContain('status-dot');

    expect(compactHtml).toContain('status-pill info');
    expect(compactHtml).toContain('已启用');
    expect(compactHtml).not.toContain('status-dot');
  });

  it('renders page heading without legacy kicker placeholders and supports meta text', () => {
    const html = renderToStaticMarkup(
      React.createElement(PageHeading, {
        kicker: '控制面',
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
});
