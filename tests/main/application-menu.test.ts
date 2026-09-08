import type { MenuItemConstructorOptions } from 'electron';
import { buildApplicationMenuTemplate } from '../../src/main/application-menu';

describe('macOS application menu', () => {
  it('provides native editing, window, close and quit actions plus settings navigation', () => {
    const openMainPage = vi.fn();
    const template = buildApplicationMenuTemplate('darwin', openMainPage)!;
    expect(template.map((item) => item.role)).toEqual(
      expect.arrayContaining(['fileMenu', 'editMenu', 'windowMenu'])
    );
    const appMenu = template[0].submenu as MenuItemConstructorOptions[];
    expect(appMenu.map((item) => item.role)).toEqual(
      expect.arrayContaining(['about', 'services', 'hide', 'quit'])
    );
    const settings = appMenu.find((item) => item.accelerator === 'Command+,')!;
    settings.click!({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    expect(openMainPage).toHaveBeenCalledWith('settings');
  });

  it.each(['win32', 'linux'] as const)('keeps the %s custom window menu behavior', (platform) => {
    expect(buildApplicationMenuTemplate(platform, vi.fn())).toBeNull();
  });
});
