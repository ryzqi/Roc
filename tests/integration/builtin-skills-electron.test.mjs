import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import { _electron, expect } from '@playwright/test';
import { navigate } from '../../scripts/lib/gate-harness.mjs';

// Run after pnpm build. This exercises the real UI, IPC, bundled archives and skill loader.
test('built app reinstalls only skills, confirms completion, and preserves user state', { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'roc-builtin-skills-electron-'));
  const skillsDir = join(root, 'skills');
  const workspace = join(root, 'workspace');
  const artifactDir = resolve('.artifacts/builtin-skills-reinstall');
  mkdirSync(workspace);
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config', 'builtin-skills.json'), JSON.stringify({
    schemaVersion: 1, autoUpdate: false, lastCheckedAt: null, sources: {}
  }));
  mkdirSync(join(skillsDir, 'user-note'), { recursive: true });
  const customSkill = '---\nname: user-note\ndescription: User content must survive reinstall.\n---\n';
  writeFileSync(join(skillsDir, 'user-note', 'SKILL.md'), customSkill);
  let app;
  const errors = [];
  try {
    const env = { ...process.env, ROC_SMOKE: '1', ROC_DATA_ROOT: root };
    delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: electronPath,
      args: [resolve('dist/main/index.js'), `--user-data-dir=${join(root, 'electron-profile')}`], env });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('[data-testid="portal"]', { timeout: 40_000 });
    const project = await page.evaluate(async path => {
      const selected = await window.roc.workspace.select({ path });
      if (!selected.ok) return selected;
      return await window.roc.research.createProject({
        title: 'Builtin skills verification', description: 'Verify skill-only reinstall in an isolated configuration.',
        workspacePath: path, language: 'zh'
      });
    }, workspace);
    assert.equal(project.ok, true, JSON.stringify(project));
    await navigate(page, `page=research&project=${project.data.id}&view=latex`);
    await page.getByTestId('titlebar-management').click();
    await page.getByTestId('mgmt-tab-skills').click();

    const status = await page.evaluate(() => window.roc.skills.builtinStatus());
    assert.equal(status.ok, true);
    // Roc creates its own tools directory at startup. Reinstall must not add integrations there.
    const integrationDirectories = ['.claude', '.codex', 'commands', 'hooks', 'agents', 'tools'];
    const integrationFiles = () => integrationDirectories.map(directory => {
      const path = join(root, directory);
      return [directory, existsSync(path) ? readdirSync(path, { recursive: true }).sort() : null];
    });
    const integrationsBefore = integrationFiles();
    const installedIds = ['user-note'];
    for (const source of status.data.sources) {
      const restore = page.getByTestId(`mgmt-skills-builtin-restore-${source.id}`);
      await restore.click();
      const receipt = page.getByTestId('mgmt-skills-builtin-restored');
      await expect(receipt).toContainText(source.displayName);
      await expect(restore).toBeEnabled();
      const listed = await page.evaluate(() => window.roc.skills.list());
      assert.equal(listed.ok, true);
      const skills = listed.data.filter(skill => skill.sourceId === source.id);
      assert.ok(skills.length >= 2);
      await expect(receipt).toContainText(`${skills.length} 个技能`);
      for (const skill of skills) {
        assert.equal(skill.status, 'ready', `${skill.id}: ${skill.lastError}`);
        installedIds.push(skill.id);
      }

      // Reinstall the same commit after an edit and a deletion, keeping a disabled skill disabled.
      const edited = join(skillsDir, skills[0].id, 'SKILL.md');
      const deleted = join(skillsDir, skills[1].id, 'SKILL.md');
      const original = readFileSync(edited, 'utf8');
      const deletedOriginal = readFileSync(deleted, 'utf8');
      const enabled = page.getByTestId(`mgmt-skill-enabled-${skills[0].id}`);
      await enabled.uncheck();
      await expect(enabled).toBeEnabled();
      writeFileSync(edited, original + '\nLOCAL EDIT TO REPAIR\n');
      rmSync(deleted);
      await restore.click();
      await expect(restore).toBeEnabled();
      await expect(receipt).toContainText(source.displayName);
      assert.equal(readFileSync(edited, 'utf8'), original);
      assert.equal(readFileSync(deleted, 'utf8'), deletedOriginal);
      await expect(enabled).not.toBeChecked();
      assert.equal(JSON.parse(readFileSync(join(skillsDir, skills[0].id, 'roc.skill.json'), 'utf8')).enabled, false);
      console.log(`${source.displayName}: ${skills.length} ready; same-commit repair and disabled state verified`);
    }

    assert.deepEqual(readdirSync(skillsDir).sort(), [...installedIds, '_bundles'].sort());
    assert.deepEqual(readdirSync(join(skillsDir, '_bundles')), ['academic-research-skills']);
    assert.deepEqual(readdirSync(join(skillsDir, '_bundles', 'academic-research-skills')), ['shared']);
    assert.equal(readFileSync(join(skillsDir, 'user-note', 'SKILL.md'), 'utf8'), customSkill);
    assert.deepEqual(integrationFiles(), integrationsBefore, 'reinstall must not install repository integrations');
    const final = await page.evaluate(() => window.roc.skills.list());
    assert.equal(final.ok, true);
    assert.equal(final.data.length, installedIds.length);
    assert.ok(final.data.every(skill => skill.status === 'ready'));
    await page.getByTestId('mgmt-skills-builtin-restored').scrollIntoViewIfNeeded();
    mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: join(artifactDir, 'reinstall-success.png') });
    assert.deepEqual(errors, []);
  } finally {
    try { await app?.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
