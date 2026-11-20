import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { build as buildStyles } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import electronPath from 'electron';
import { _electron } from '@playwright/test';

const rendererCorpus = [
  {
    name: 'gfm',
    markdown: [
      '# Markdown compatibility',
      '',
      'Paragraph with ~~deleted~~, **bold**, and an autolink https://example.com/path.',
      '',
      '- [x] checked item',
      '- [ ] unchecked item',
      '',
      '| Name | Count |',
      '| :--- | ---: |',
      '| alpha | 3 |',
      '| beta | 11 |',
      '',
      'A footnote reference.[^note]',
      '',
      '[^note]: The footnote body.',
      '',
      '```ts',
      'const answer: number = 42;',
      '```'
    ].join('\n')
  },
  {
    name: 'incomplete-syntax',
    markdown: [
      'An unfinished *emphasis marker',
      '',
      'An unfinished [link](https://example.com/path',
      '',
      '```ts',
      'const unfinished = "value";'
    ].join('\n')
  },
  {
    name: 'links-images-and-html',
    markdown: [
      '[safe](https://example.com/safe) [relative](../private.md) [script](javascript:alert%281%29)',
      '',
      '![remote image](https://roc-test.invalid/image.png "diagram")',
      '',
      '![unsafe image](javascript:alert%281%29)',
      '',
      '<script>window.markdownGatePwned = true</script><img src=x onerror="window.markdownGatePwned = true">'
    ].join('\n')
  },
  {
    name: 'long-answer',
    markdown: Array.from(
      { length: 96 },
      (_, index) => `Paragraph ${index + 1}: a long answer keeps its complete sentence, link [source ${index + 1}](https://example.com/source/${index + 1}), and surrounding prose.`
    ).join('\n\n')
  }
];

const longAnswer = rendererCorpus.find((item) => item.name === 'long-answer').markdown;
let tempDir;
let app;
let page;
let artifact;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-markdown-renderers-'));
  const stylesEntry = join(tempDir, 'styles-entry.js');
  writeFileSync(stylesEntry, `import ${JSON.stringify(join(process.cwd(), 'src/renderer/styles/index.css'))};`);
  const stylesBuild = await buildStyles({
    configFile: false,
    root: process.cwd(),
    plugins: [tailwindcss()],
    logLevel: 'silent',
    build: {
      write: false,
      cssCodeSplit: false,
      assetsInlineLimit: 10_000_000,
      rollupOptions: { input: stylesEntry }
    }
  });
  const stylesheet = stylesBuild.output.find((item) => item.type === 'asset' && item.fileName.endsWith('.css'));
  if (stylesheet === undefined || typeof stylesheet.source !== 'string') {
    throw new Error('renderer stylesheet was not emitted');
  }
  writeFileSync(join(tempDir, 'styles.css'), stylesheet.source);
  const source = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { Virtuoso } from 'react-virtuoso';
    import { markdownComponents } from './src/renderer/assistant/blocks/markdown-components.ts';
    import { MarkdownView } from './src/renderer/assistant/blocks/markdown-view.tsx';
    import { StreamingMarkdownView } from './src/renderer/assistant/blocks/streaming-markdown-view.tsx';
    import { CodeBlock } from './src/renderer/assistant/blocks/code-block.tsx';
    import { Streamdown } from 'streamdown';

    const roots = new Map();
    function CandidateStatic({ text }) {
      return React.createElement(
        'div',
        { className: 'roc-prose', 'data-testid': 'candidate-markdown' },
        React.createElement(Streamdown, {
          mode: 'static',
          animated: false,
          isAnimating: false,
          components: markdownComponents
        }, text)
      );
    }

    function TransitionList({ text, isStreaming }) {
      const messages = [
        { key: 'before', text: 'A preceding transcript message with stable content.' },
        { key: 'transition', text },
        { key: 'after', text: 'A following transcript message with stable content.' }
      ];
      return React.createElement(Virtuoso, {
        className: 'h-full',
        style: { height: '100%' },
        customScrollParent: document.getElementById('transition-scroll'),
        alignToBottom: true,
        followOutput: false,
        data: messages,
        computeItemKey: (_index, message) => message.key,
        itemContent: (index, message) => React.createElement(
          'div',
          { className: 'flex justify-start px-4 py-3', 'data-testid': 'assistant-message-assistant' },
          React.createElement(
            'article',
            { className: 'flex min-w-0 max-w-full flex-1 flex-col gap-3', 'data-testid': 'assistant-message-content' },
            index === 1
              ? React.createElement(
                  'div',
                  { 'data-transition-target': true },
                  React.createElement(StreamingMarkdownView, { text, isStreaming })
                )
              : React.createElement(MarkdownView, { text: message.text }),
            index === 1 && isStreaming
              ? React.createElement('span', { 'aria-hidden': true, className: 'mt-0.5 h-3.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none' })
              : index === 1
                ? React.createElement('button', { type: 'button', className: 'h-6 w-6 self-start' })
                : null
          )
        )
      });
    }

    function mount(id, component) {
      let root = roots.get(id);
      if (!root) {
        root = createRoot(document.getElementById(id));
        roots.set(id, root);
      }
      flushSync(() => root.render(component));
    }

    window.mountPair = text => {
      mount('current-root', React.createElement(MarkdownView, { text }));
      mount('candidate-root', React.createElement(CandidateStatic, { text }));
    };
    window.mountCodeBlock = (source, language) => mount(
      'candidate-root',
      React.createElement(CodeBlock, {
        children: React.createElement('code', { className: 'language-' + language }, source)
      })
    );
    window.codeBlockSnapshot = () => {
      const block = document.querySelector('#candidate-root [data-testid="assistant-code-block"]');
      const code = block?.querySelector('pre code');
      return {
        text: code?.textContent ?? null,
        spans: code?.querySelectorAll('span').length ?? 0,
        images: block?.querySelectorAll('img').length ?? 0,
        scripts: block?.querySelectorAll('script').length ?? 0,
        eventAttributes: Array.from(block?.querySelectorAll('*') ?? [])
          .flatMap(element => Array.from(element.attributes, attribute => attribute.name))
          .filter(name => /^on/iu.test(name)),
        pwned: window.markdownGatePwned === true
      };
    };
    window.mountTransition = (text, isStreaming) => {
      window.transitionText = text;
      mount('transition-root', React.createElement(TransitionList, { text, isStreaming }));
    };
    window.setTransitionStreaming = isStreaming => {
      mount('transition-root', React.createElement(TransitionList, { text: window.transitionText, isStreaming }));
    };
    window.snapshot = id => {
      const root = id === 'transition-root'
        ? document.querySelector('#transition-root [data-transition-target] .roc-prose')
        : document.querySelector('#' + id + ' .roc-prose');
      const selectors = 'h1,h2,h3,h4,p,a,img,ul,ol,li,input,table,thead,tbody,tr,th,td,del,pre,code,blockquote,hr';
      return {
        nodes: Array.from(root.querySelectorAll(selectors), node => ({
          tag: node.localName,
          text: node.matches('img,input,hr')
            ? null
            : node.matches('pre,code')
              ? node.textContent
              : node.textContent.replace(/\\s+/gu, ' ').trim(),
          href: node.getAttribute('href'),
          src: node.getAttribute('src'),
          alt: node.getAttribute('alt'),
          type: node.getAttribute('type'),
          checked: node.matches('input') ? node.checked : null,
          disabled: node.matches('input') ? node.disabled : null,
          language: node.matches('code') ? Array.from(node.classList).find(name => name.startsWith('language-')) ?? null : null
        })),
        codeBlocks: Array.from(root.querySelectorAll('pre'), node => node.outerHTML)
      };
    };
    window.imagesLoaded = selector => Array.from(document.querySelectorAll(selector))
      .every(image => image.complete && image.naturalWidth > 0);
    window.captureTransitionGeometry = (anchorIndex, anchorText) => {
      const scroller = document.getElementById('transition-scroll');
      const paragraphs = document.querySelectorAll('#transition-root [data-transition-target] .roc-prose p');
      const anchor = anchorText === undefined
        ? paragraphs[anchorIndex]
        : Array.from(paragraphs).find(node => node.textContent === anchorText) ?? paragraphs[anchorIndex];
      const anchorRect = anchor.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const root = document.querySelector('#transition-root [data-transition-target] .roc-prose');
      const rootRect = root.getBoundingClientRect();
      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        height: rootRect.height,
        rootTop: rootRect.top - scrollerRect.top,
        anchorText: anchor.textContent,
        anchorFound: anchorText === undefined || anchor.textContent === anchorText,
        anchorTop: anchorRect.top - scrollerRect.top,
        anchorTopWithinMarkdown: anchorRect.top - rootRect.top,
        anchorVisible: anchorRect.top >= scrollerRect.top && anchorRect.bottom <= scrollerRect.bottom,
        lineHeight: getComputedStyle(root).lineHeight,
        snapshot: window.snapshot('transition-root')
      };
    };
    window.waitForStableTransition = async (anchorIndex, anchorText) => {
      let previous = null;
      let stableSamples = 0;
      let geometry;
      for (let sample = 0; sample < 20; sample += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
        geometry = window.captureTransitionGeometry(anchorIndex, anchorText);
        const current = [geometry.scrollTop, geometry.scrollHeight, geometry.height, geometry.anchorTop];
        if (previous !== null && current.every((value, index) => Math.abs(value - previous[index]) < 0.5)) {
          stableSamples += 1;
          if (stableSamples === 2) return { ...geometry, stable: true };
        } else {
          stableSamples = 0;
        }
        previous = current;
      }
      return { ...geometry, stable: false };
    };
  `;
  await esbuild.build({
    stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'markdown-renderer-harness.tsx', loader: 'tsx' },
    outfile: join(tempDir, 'renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    logLevel: 'silent'
  });
  writeFileSync(
    join(tempDir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><body><div id="current-root"></div><div id="candidate-root"></div><div id="transition-scroll" style="height: 280px; width: 680px; overflow: auto"><div id="transition-root"></div></div><script src="renderer.js"></script></body>'
  );
  writeFileSync(
    join(tempDir, 'main.cjs'),
    `const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(join(tempDir, 'data'))});
      app.whenReady().then(() => {
        const window = new BrowserWindow({ show: false, width: 900, height: 800 });
        window.loadFile(${JSON.stringify(join(tempDir, 'index.html'))});
      });`
  );
  app = await _electron.launch({ executablePath: electronPath, args: [join(tempDir, 'main.cjs')] });
  page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  await page.route('https://roc-test.invalid/image.png', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
  }));
  await page.waitForFunction(() => typeof window.mountPair === 'function');
});

after(async () => {
  try {
    if (artifact !== undefined && process.env.ROC_MARKDOWN_GATE_ARTIFACT !== undefined) {
      const path = process.env.ROC_MARKDOWN_GATE_ARTIFACT;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    }
  } finally {
    try {
      await app?.close();
    } finally {
      if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test('behavior gate records parser incompatibilities and keeps renderers split', async () => {
  artifact = { gate: null, cases: [], transitions: [], transitionGate: null, security: null };
  const mismatches = [];
  for (const item of rendererCorpus) {
    await page.evaluate((text) => window.mountPair(text), item.markdown);
    await page.waitForFunction(() => window.imagesLoaded('#current-root img, #candidate-root img'));
    const current = await page.evaluate(() => window.snapshot('current-root'));
    const candidate = await page.evaluate(() => window.snapshot('candidate-root'));
    artifact.cases.push({ name: item.name, current, candidate });
    if (JSON.stringify(candidate) !== JSON.stringify(current)) {
      mismatches.push(item.name);
    }
  }
  artifact.gate = {
    passed: mismatches.length === 0,
    decision: mismatches.length === 0 ? 'unify' : 'keep-parser-split-and-share-component-mapping',
    mismatches
  };
  assert.deepEqual(
    mismatches,
    ['gfm', 'incomplete-syntax', 'links-images-and-html'],
    'the recorded parser differences changed; review the compatibility gate before unifying'
  );
  const linksCase = rendererCorpus.find((item) => item.name === 'links-images-and-html');
  await page.evaluate((text) => {
    window.markdownGatePwned = false;
    window.mountPair(text);
  }, linksCase.markdown);
  await page.waitForFunction(() => window.imagesLoaded('#current-root img, #candidate-root img'));
  const linksAndImages = artifact.cases.find((item) => item.name === 'links-images-and-html');
  const loadedImages = await page.evaluate(() => Array.from(document.querySelectorAll('#current-root img, #candidate-root img'))
    .map((image) => ({ src: image.getAttribute('src'), complete: image.complete, naturalWidth: image.naturalWidth })));
  assert.deepEqual(loadedImages, [
    { src: 'https://roc-test.invalid/image.png', complete: true, naturalWidth: 1 },
    { src: 'https://roc-test.invalid/image.png', complete: true, naturalWidth: 1 }
  ]);
  for (const renderer of [linksAndImages.current, linksAndImages.candidate]) {
    assert.deepEqual(renderer.nodes.filter((node) => node.tag === 'a').map((link) => link.href), ['https://example.com/safe']);
  }
  await page.waitForTimeout(50);
  const unsafe = await page.evaluate(() => ({
    currentScripts: document.querySelectorAll('#current-root script').length,
    candidateScripts: document.querySelectorAll('#candidate-root script').length,
    currentUnsafeImages: document.querySelectorAll('#current-root img[src^="javascript:"]').length,
    candidateUnsafeImages: document.querySelectorAll('#candidate-root img[src^="javascript:"]').length,
    eventAttributes: Array.from(document.querySelectorAll('#current-root, #current-root *, #candidate-root, #candidate-root *'))
      .flatMap((element) => Array.from(element.attributes, (attribute) => attribute.name))
      .filter((name) => /^on/iu.test(name)),
    pwned: window.markdownGatePwned === true
  }));
  artifact.security = unsafe;
  assert.deepEqual(unsafe, {
    currentScripts: 0,
    candidateScripts: 0,
    currentUnsafeImages: 0,
    candidateUnsafeImages: 0,
    eventAttributes: [],
    pwned: false
  });
});

test('streaming completion measures DOM, height, and scroll-anchor changes across the corpus', async () => {
  artifact.transitions = [];
  for (const item of rendererCorpus) {
    const text = item.name === 'incomplete-syntax'
      ? `${longAnswer}\n\n${item.markdown}`
      : item.name === 'long-answer'
        ? longAnswer
        : `${item.markdown}\n\n${longAnswer}`;
    await page.evaluate((value) => window.mountTransition(value, true), text);
    await page.waitForFunction(() => document.querySelector('#transition-root [data-transition-target] .roc-prose p') !== null);
    await page.waitForFunction(() => window.imagesLoaded('#transition-root [data-transition-target] .roc-prose img'));
    const before = await page.evaluate(() => {
      const scroller = document.getElementById('transition-scroll');
      const anchorIndex = 40;
      const anchor = document.querySelectorAll('#transition-root [data-transition-target] .roc-prose p')[anchorIndex];
      scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 80;
      return window.waitForStableTransition(anchorIndex);
    });
    assert.equal(before.stable, true, `${item.name}: streaming layout did not settle`);
    await page.evaluate(() => window.setTransitionStreaming(false));
    const after = await page.evaluate((anchorText) => window.waitForStableTransition(40, anchorText), before.anchorText);
    assert.equal(after.stable, true, `${item.name}: settled layout did not stabilize`);
    const result = {
      name: item.name,
      before,
      after,
      anchorTextChanged: before.anchorText !== after.anchorText,
      elementsChanged: JSON.stringify(after.snapshot.nodes) !== JSON.stringify(before.snapshot.nodes),
      codeBlocksChanged: JSON.stringify(after.snapshot.codeBlocks) !== JSON.stringify(before.snapshot.codeBlocks),
      heightDelta: after.height - before.height,
      anchorContentDelta: after.anchorTopWithinMarkdown - before.anchorTopWithinMarkdown,
      scrollHeightDelta: after.scrollHeight - before.scrollHeight,
      anchorDelta: after.anchorTop - before.anchorTop
    };
    artifact.transitions.push(result);
    assert.equal(before.anchorVisible, true, `${item.name}: anchor was not visible before completion`);
    assert.notEqual(before.lineHeight, 'normal', 'renderer stylesheet was not applied');
    assert.notEqual(after.lineHeight, 'normal', 'renderer stylesheet was not applied after completion');
  }

  const longAnswerTransition = artifact.transitions.find((item) => item.name === 'long-answer');
  assert.equal(longAnswerTransition.elementsChanged, false, 'long-answer elements changed on completion');
  assert.equal(longAnswerTransition.codeBlocksChanged, false);
  assert.ok(Math.abs(longAnswerTransition.heightDelta) <= 1, `long-answer content height changed by ${longAnswerTransition.heightDelta}px`);
  assert.ok(Math.abs(longAnswerTransition.anchorContentDelta) <= 1, `long-answer anchor moved within Markdown by ${longAnswerTransition.anchorContentDelta}px`);

  const gfmTransition = artifact.transitions.find((item) => item.name === 'gfm');
  assert.ok(gfmTransition.before.snapshot.codeBlocks.length > 0, 'GFM transition must exercise a fenced code block');
  for (const snapshot of [gfmTransition.before.snapshot, gfmTransition.after.snapshot]) {
    assert.ok(snapshot.nodes.some((node) => node.tag === 'code' && node.text.includes('const answer: number = 42;')));
  }
  artifact.transitionGate = {
    passed: artifact.transitions.every((item) =>
      !item.elementsChanged &&
      !item.codeBlocksChanged &&
      Math.abs(item.heightDelta) <= 1 &&
      Math.abs(item.scrollHeightDelta) <= 1 &&
      Math.abs(item.anchorDelta) <= 1 &&
      item.after.anchorFound &&
      item.after.anchorVisible
    ),
    failedCases: artifact.transitions.filter((item) =>
      item.elementsChanged ||
      item.codeBlocksChanged ||
      Math.abs(item.heightDelta) > 1 ||
      Math.abs(item.scrollHeightDelta) > 1 ||
      Math.abs(item.anchorDelta) > 1 ||
      !item.after.anchorFound ||
      !item.after.anchorVisible
    ).map((item) => item.name)
  };
  assert.equal(artifact.transitionGate.passed, false, 'transition output changed; review the unification decision');
  assert.ok(artifact.transitionGate.failedCases.includes('gfm'), 'GFM transition must remain part of the gate');
});

test('code highlighting renders forged HTML as source text', async () => {
  const source = '<img src=x onerror="window.markdownGatePwned = true"><script>window.markdownGatePwned = true</script>&amp;';
  await page.evaluate((code) => {
    window.markdownGatePwned = false;
    window.mountCodeBlock(code, 'html');
  }, source);
  await page.waitForFunction(() => document.querySelector('#candidate-root pre code span') !== null);
  await page.waitForTimeout(50);

  const result = await page.evaluate(() => window.codeBlockSnapshot());
  assert.equal(result.text, source);
  assert.ok(result.spans > 0, 'the test must exercise highlighted AST output');
  assert.equal(result.images, 0);
  assert.equal(result.scripts, 0);
  assert.deepEqual(result.eventAttributes, []);
  assert.equal(result.pwned, false);
});
