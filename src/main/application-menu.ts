import type { MenuItemConstructorOptions } from 'electron';

export function buildApplicationMenuTemplate(
  platform: NodeJS.Platform,
  openMainPage: (page: string) => void
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') {
    return null;
  }
  return [
    {
      label: 'Roc',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { id: 'settings', label: '设置...', accelerator: 'Command+,', click: () => openMainPage('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: '显示',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
}
