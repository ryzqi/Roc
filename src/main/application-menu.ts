import type { MenuItemConstructorOptions } from 'electron';

import type { MenuPage } from '../shared/surfaces';

export function buildApplicationMenuTemplate(
  openMainPage: (page: MenuPage) => void
): MenuItemConstructorOptions[] {
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
    {
      label: '文件',
      submenu: [
        { id: 'new-research-project', label: '新建研究项目', accelerator: 'Command+N', click: () => openMainPage('research-new') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
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
