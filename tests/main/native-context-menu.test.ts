import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  buildNativeContextMenuTemplate,
  createNativeContextMenuHandler,
  type NativeContextMenuParams
} from '../../src/main/native-context-menu';

describe('native context menu', () => {
  it('uses native editing roles for editable controls', () => {
    const template = buildNativeContextMenuTemplate({
      ...baseContextMenuParams(),
      isEditable: true,
      editFlags: {
        canCopy: true,
        canCut: true,
        canPaste: true,
        canSelectAll: true
      }
    });

    expect(template).toEqual([
      { role: 'cut', enabled: true },
      { role: 'copy', enabled: true },
      { role: 'paste', enabled: true },
      { type: 'separator' },
      { role: 'selectAll', enabled: true }
    ]);
  });

  it('offers copy selection for selected non-editable text', () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const template = buildNativeContextMenuTemplate(
      {
        ...baseContextMenuParams(),
        selectionText: 'diff --git a/file.ts b/file.ts'
      },
      {
        writeText
      }
    );

    expect(template).not.toBeNull();
    expect(template?.map((item) => item.label)).toEqual(['复制所选内容']);

    template?.[0]?.click?.({} as never, undefined, {} as never);

    expect(writeText).toHaveBeenCalledWith('diff --git a/file.ts b/file.ts');
  });

  it('does not show a menu for non-editable chrome without selected text', () => {
    expect(buildNativeContextMenuTemplate(baseContextMenuParams())).toBeNull();
  });

  it('binds the context-menu event and opens the native menu at the pointer position', () => {
    const popup = vi.fn();
    const buildFromTemplate = vi.fn((_template: MenuItemConstructorOptions[]) => ({ popup }));
    const event = {
      preventDefault: vi.fn()
    };
    const handler = createNativeContextMenuHandler({
      buildFromTemplate,
      writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    });

    handler(event, {
      ...baseContextMenuParams(),
      x: 42,
      y: 64,
      selectionText: 'selected message'
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(buildFromTemplate).toHaveBeenCalledWith([
      expect.objectContaining({
        label: '复制所选内容'
      })
    ]);
    expect(popup).toHaveBeenCalledWith({ x: 42, y: 64 });
  });

  function baseContextMenuParams(): NativeContextMenuParams {
    return {
      x: 0,
      y: 0,
      isEditable: false,
      selectionText: '',
      editFlags: {
        canCopy: false,
        canCut: false,
        canPaste: false,
        canSelectAll: false
      }
    };
  }
});
