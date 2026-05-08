import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ComposerActionIcon } from '../../src/renderer/chat-composer-icons';

describe('chat composer icons', () => {
  it('renders the approved lucide icons for each composer action', () => {
    const attachmentHtml = renderToStaticMarkup(React.createElement(ComposerActionIcon, { kind: 'attachment' }));
    const toolsHtml = renderToStaticMarkup(React.createElement(ComposerActionIcon, { kind: 'tools' }));
    const skillsHtml = renderToStaticMarkup(React.createElement(ComposerActionIcon, { kind: 'skills' }));
    const modelHtml = renderToStaticMarkup(React.createElement(ComposerActionIcon, { kind: 'model' }));

    expect(attachmentHtml).toContain('lucide-file-up');
    expect(toolsHtml).toContain('lucide-wrench');
    expect(skillsHtml).toContain('lucide-sparkles');
    expect(modelHtml).toContain('lucide-bot');
  });
});
