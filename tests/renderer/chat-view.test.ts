import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatView } from '../../src/renderer/chat/chat-view';
import { createLoadedState } from './view-test-helpers';

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('window', {
    roc: {
      chat: {
        onRunEvent: () => () => {},
        resumeRun: async () => ({ ok: true })
      },
      tasks: {
        getThreadMessages: async () => ({ ok: true, data: [] })
      },
      files: {
        selectFromDialog: async () => ({ ok: true, data: null })
      }
    }
  });
  Object.defineProperty(globalThis.window, 'roc', {
    configurable: true,
    value: globalThis.window.roc
  });
});

describe('chat view', () => {
  it('renders the new centered empty-state copy when there is no transcript yet', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatView, {
        chatSelectionVersion: 1,
        selectedThreadId: null,
        state: createLoadedState({}),
        updateLoadedState: () => {},
        onSubmitChatTask: async () => ({ ok: true as const })
      })
    );

    expect(html).toContain('data-testid="chat-empty-state"');
    expect(html).toContain('Roc 本地工作台');
    expect(html).toContain('问问 Roc 或交给它一个任务');
    expect(html).toContain('class="chat-bottom-stack chat-bottom-stack--empty"');
  });

  it('does not add extra bottom offset for the empty chat composer layout', () => {
    const entryCss = readFileSync('src/renderer/styles/main.css', 'utf8');
    const chatCss = readFileSync('src/renderer/styles/chat.css', 'utf8');

    expect(entryCss).toContain("@import './chat.css';");
    expect(chatCss).toContain('.chat-bottom-stack--empty {');
    expect(chatCss).toContain('padding: 0;');
    expect(chatCss).not.toContain('.chat-bottom-stack--empty {\r\n  justify-items: center;\r\n  padding: 0 0 36px;');
    expect(chatCss).not.toContain('.chat-bottom-stack--empty {\n  justify-items: center;\n  padding: 0 0 36px;');
  });
});
