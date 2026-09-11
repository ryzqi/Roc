import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';
import { ResearchTemplateService } from '../../../../src/main/plugins/research/template-service';
import { ResearchToolchain } from '../../../../src/main/plugins/research/toolchain';

it('reports missing research resources without using host tools', async () => {
  await expect(new ResearchToolchain(null).status()).resolves.toEqual({ available: false, versions: null, error: 'research_toolchain_unavailable' });
});

const toolchainRoot = process.env.ROC_RESEARCH_TOOLCHAIN;
describe.skipIf(toolchainRoot === undefined)('bundled research toolchain integration', () => {
  it('imports a ZIP, compiles Chinese/math, renders and parses under the filesystem sandbox', async () => {
    if (toolchainRoot === undefined) throw new Error('research_toolchain_test_root_required');
    const artifacts = process.env.ROC_RESEARCH_ARTIFACT_ROOT;
    if (artifacts !== undefined) {
      if (!isAbsolute(artifacts)) throw new Error('research_artifact_root_must_be_absolute');
      await mkdir(artifacts, { recursive: true });
    }
    const root = await realpath(await mkdtemp(join(artifacts ?? tmpdir(), 'roc research integration-')));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);
    applyResearchDatabaseSchema(db);
    const repository = new ResearchRepository(db);
    const tools = new ResearchToolchain(toolchainRoot);
    const templates = new ResearchTemplateService(repository, tools);
    try {
      expect(await tools.status()).toMatchObject({ available: true, error: null });
      const zip = join(root, 'template.zip');
      const sample = fileURLToPath(new URL('../../../../scripts/research/smoke.py', import.meta.url));
      await promisify(execFile)(join(toolchainRoot, 'python/bin/python3'), ['-I', '-B', '-c',
        'import sys,zipfile,runpy\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[2]).parent))\nsample=runpy.run_path(sys.argv[2])\nexec(sample["PLOT"],{})\nwith zipfile.ZipFile(sys.argv[1],"w") as archive:\n archive.writestr("template/main.tex",sample["LATEX"])\n archive.write("figure.png","template/figure.png")', zip, sample],
        { cwd: root, env: { PATH: '/usr/bin:/bin', MPLCONFIGDIR: join(root, 'plot-cache') } });
      const project = repository.createProject({ title: 'Runtime smoke', description: 'Real bundled runtime', workspacePath: root });
      const imported = await templates.importTemplate({ projectId: project.id, sourcePath: zip });
      expect(imported.entryPath).toBe('template/main.tex');
      const compiled = await templates.compile({ projectId: project.id, templateId: imported.id });
      expect(compiled).toMatchObject({ status: 'ready', activeCompileId: null, compiledRevision: 1 });
      if (compiled.pdfPath === null || compiled.pdfHash === null) throw new Error('compiled_pdf_missing');
      expect((await templates.pdf({ projectId: project.id, templateId: imported.id, pdfHash: compiled.pdfHash })).subarray(0, 5).toString()).toBe('%PDF-');
      const renderJob = join(root, 'render-job');
      await mkdir(renderJob);
      const page = await tools.renderPdf({ projectRoot: root, sourcePath: compiled.pdfPath, outputDir: join(renderJob, 'output'), jobDir: renderJob, page: 1, scale: 2 });
      expect(page.text).toContain('研究数据与方法');
      expect((await readFile(page.path)).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const parseJob = join(root, 'parse-job');
      await mkdir(parseJob);
      const parsed = await tools.parseDocument({ projectRoot: root, sourcePath: page.path, outputDir: join(parseJob, 'output'), jobDir: parseJob });
      if (artifacts !== undefined) await writeFile(join(root, 'result.json'), JSON.stringify({ compiled, page, parsed }, null, 2));
      expect(parsed.content).toContain('研究数据与方法');
      expect(parsed.content).toContain('18');
      expect(parsed.blocks.some((block) => block.kind === 'table')).toBe(true);
      expect(parsed.blocks.some((block) => block.kind === 'formula')).toBe(true);
      expect(parsed.warnings).toEqual([]);
    } finally {
      await templates.shutdown();
      db.close();
      if (artifacts === undefined) await rm(root, { recursive: true, force: true });
    }
  }, 600_000);
});
