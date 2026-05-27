import { clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron';

type NativeContextMenuEditFlags = Pick<ContextMenuParams['editFlags'], 'canCopy' | 'canCut' | 'canPaste' | 'canSelectAll'>;

export type NativeContextMenuParams = {
  x: number;
  y: number;
  isEditable: boolean;
  selectionText: string;
  editFlags: NativeContextMenuEditFlags;
};

type NativeContextMenuDependencies = {
  buildFromTemplate: (template: MenuItemConstructorOptions[]) => { popup: (options: { x: number; y: number }) => void };
  writeText: (text: string) => void;
};

type NativeContextMenuEvent = {
  preventDefault: () => void;
};

export function buildNativeContextMenuTemplate(
  params: NativeContextMenuParams,
  clipboardApi: Pick<typeof clipboard, 'writeText'> = clipboard
): MenuItemConstructorOptions[] | null {
  if (params.isEditable) {
    return [
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    ];
  }

  const selectedText = params.selectionText.trim();
  if (selectedText.length === 0) {
    return null;
  }

  return [
    {
      label: '复制所选内容',
      click: () => {
        clipboardApi.writeText(selectedText);
      }
    }
  ];
}

export function createNativeContextMenuHandler(
  dependencies: NativeContextMenuDependencies = {
    buildFromTemplate: (template) => Menu.buildFromTemplate(template),
    writeText: (text) => clipboard.writeText(text)
  }
): (event: NativeContextMenuEvent, params: NativeContextMenuParams) => void {
  return (event, params) => {
    const template = buildNativeContextMenuTemplate(params, {
      writeText: dependencies.writeText
    });
    if (template === null) {
      return;
    }

    event.preventDefault();
    dependencies.buildFromTemplate(template).popup({
      x: params.x,
      y: params.y
    });
  };
}

export function bindNativeContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', createNativeContextMenuHandler());
}
