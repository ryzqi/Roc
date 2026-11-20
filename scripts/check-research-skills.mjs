import {readFileSync, writeFileSync, realpathSync, lstatSync} from 'node:fs';
import {resolve, relative, isAbsolute} from 'node:path';
import {importTypeScriptModule} from './lib/bundle-ts.mjs';

const {ResearchSkillRegistry} = await importTypeScriptModule('src/main/plugins/research/skill-registry.ts', {platform: 'node'});
const {researchStageSchema} = await importTypeScriptModule('src/shared/schemas/research.ts');
const {researchSkillManifestSchema} = await importTypeScriptModule('src/shared/schemas/research-skills.ts');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--write')) throw new Error('usage: check-research-skills.mjs [--write]');
const root = realpathSync('resources/research-skills');
const bundle = {schemaVersion: 1, manifests: [], resources: {}};
for (const stage of researchStageSchema.options) {
  const directory = resolve(root, stage);
  const read = path => {
    const target = resolve(directory, path), real = realpathSync(target);
    const inside = relative(directory, real);
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || real !== target || !lstatSync(target).isFile()) {
      throw new Error(`research_skill_resource_outside:${stage}/${path}`);
    }
    const content = readFileSync(target, 'utf8');
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error('research_skill_resource_too_large');
    return content;
  };
  const manifest = researchSkillManifestSchema.parse(JSON.parse(read('skill.manifest.json')));
  if (manifest.stage !== stage) throw new Error('research_skill_stage_mismatch');
  bundle.manifests.push(manifest);
  for (const resource of [manifest.entry, ...manifest.references, manifest.license.resource, ...manifest.evalCases]) {
    bundle.resources[`${stage}/${resource.path}`] = read(resource.path);
  }
}
const registry = new ResearchSkillRegistry(bundle);
registry.validateAll();
const encoded = JSON.stringify(bundle, null, 2) + '\n';
const target = resolve(root, 'catalog.json');
if (args[0] === '--write') writeFileSync(target, encoded);
else if (readFileSync(target, 'utf8') !== encoded) throw new Error('research_skill_catalog_stale: run node scripts/check-research-skills.mjs --write');
console.log(JSON.stringify({stages: registry.catalog().length, resources: Object.keys(bundle.resources).length, status: 'valid'}));
