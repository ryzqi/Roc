import { readFileSync } from 'node:fs';

describe('package scripts', () => {
  it('does not expose the removed audit script anymore', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const removedScriptName = ['visual', 'audit'].join(':');
    expect(packageJson.scripts[removedScriptName]).toBeUndefined();
  });
});
