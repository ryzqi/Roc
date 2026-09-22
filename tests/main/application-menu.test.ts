import type { MenuItemConstructorOptions } from 'electron';
import { buildApplicationMenuTemplate } from '../../src/main/application-menu';

describe('macOS application menu', () => {
  it('provides native editing, window, close and quit actions plus settings navigation', () => {
    const openMainPage = vi.fn();
    const template = buildApplicationMenuTemplate(openMainPage);
    expect(template.map((item) => item.role ?? item.label)).toEqual(
      expect.arrayContaining(['文件', 'editMenu', 'windowMenu'])
    );
    const fileMenu = template.find((item) => item.label === '文件')?.submenu as MenuItemConstructorOptions[];
    const newProject = fileMenu.find((item) => item.accelerator === 'Command+N')!;
    newProject.click!({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    expect(openMainPage).toHaveBeenCalledWith('research-new');
    const appMenu = template[0].submenu as MenuItemConstructorOptions[];
    expect(appMenu.map((item) => item.role)).toEqual(
      expect.arrayContaining(['about', 'services', 'hide', 'quit'])
    );
    const settings = appMenu.find((item) => item.accelerator === 'Command+,')!;
    settings.click!({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    expect(openMainPage).toHaveBeenCalledWith('settings');
  });

});
