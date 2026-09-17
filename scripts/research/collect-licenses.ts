import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

export type PythonLicenseRecord = {
  name: string;
  version: string;
  licenseExpression: string | null;
  license: string | null;
  licenseClassifiers: string[];
  projectUrls: string[];
  licenseFiles: string[];
};

const LICENSE_NAME = /license|copying|notice|copyright/iu;
const LICENSE_DIR = new Set(['licenses', 'license', 'build_licenses', 'notices']);

function fail(code: string): never {
  throw new Error(code);
}

async function pathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseMetadata(text: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let name: string | null = null;
  for (const raw of text.split(/\r?\n/u)) {
    if (raw === '') break;
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && name !== null) {
      const values = fields.get(name);
      if (values === undefined) continue;
      values[values.length - 1] += `\n${raw.slice(1)}`;
      continue;
    }
    const index = raw.indexOf(':');
    if (index <= 0) continue;
    name = raw.slice(0, index).trim().toLowerCase();
    const value = raw.slice(index + 1).trim();
    const values = fields.get(name);
    if (values === undefined) fields.set(name, [value]);
    else values.push(value);
  }
  return fields;
}

function first(fields: Map<string, string[]>, name: string): string | null {
  const value = fields.get(name)?.[0];
  return value === undefined || value === '' ? null : value;
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }
      if (character === '"') {
        quoted = false;
        continue;
      }
      field += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ',') {
      fields.push(field);
      field = '';
      continue;
    }
    field += character;
  }
  if (quoted) throw new Error('research_python_metadata_invalid');
  fields.push(field);
  return fields;
}

function parseRecord(text: string): string[] {
  return text.split(/\r?\n/u).flatMap((line) => {
    if (line === '') return [];
    const path = parseCsvRow(line)[0];
    return path === undefined || path === '' ? [] : [path];
  });
}

function isLicensePath(relativePath: string): boolean {
  const parts = relativePath.split('/');
  const name = parts.at(-1) ?? '';
  return LICENSE_NAME.test(name) || parts.some((part) => LICENSE_DIR.has(part.toLowerCase()));
}

async function collectDistribution(
  root: string,
  sitePackages: string,
  distInfo: string
): Promise<PythonLicenseRecord | null> {
  const metadataPath = join(distInfo, 'METADATA');
  const eggInfo = join(distInfo, 'PKG-INFO');
  const source = await pathInfo(metadataPath) !== null ? metadataPath : eggInfo;
  if (await pathInfo(source) === null) return null;
  const fields = parseMetadata(await readFile(source, 'utf8'));
  const name = first(fields, 'name');
  const version = first(fields, 'version');
  if (name === null || version === null) fail('research_python_metadata_invalid');
  const recordPath = join(distInfo, 'RECORD');
  const licenseFiles: string[] = [];
  if (await pathInfo(recordPath) !== null) {
    for (const entry of parseRecord(await readFile(recordPath, 'utf8'))) {
      const parts = entry.split('/');
      if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..') || !isLicensePath(entry)) continue;
      const full = join(sitePackages, ...parts);
      const info = await pathInfo(full);
      if (info === null || !info.isFile() || info.isSymbolicLink()) continue;
      const resolved = await realpath(full);
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) continue;
      licenseFiles.push(relative(root, resolved).split(sep).join(posix.sep));
    }
  }
  return {
    name,
    version,
    licenseExpression: first(fields, 'license-expression'),
    license: first(fields, 'license'),
    licenseClassifiers: (fields.get('classifier') ?? []).filter((item) => item.startsWith('License ::')),
    projectUrls: fields.get('project-url') ?? [],
    licenseFiles: [...new Set(licenseFiles)].sort()
  };
}

async function findSitePackages(root: string): Promise<string[]> {
  const lib = join(root, 'python/lib');
  const info = await pathInfo(lib);
  if (info === null || !info.isDirectory()) fail('research_python_site_packages_missing');
  const found: string[] = [];
  for (const entry of await readdir(lib, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^python\d+\.\d+$/u.test(entry.name)) continue;
    const site = join(lib, entry.name, 'site-packages');
    const siteInfo = await pathInfo(site);
    if (siteInfo?.isDirectory()) found.push(site);
  }
  if (found.length === 0) fail('research_python_site_packages_missing');
  return found;
}

export async function collectPythonLicenses(rootPath: string): Promise<PythonLicenseRecord[]> {
  const root = await realpath(rootPath);
  const records: PythonLicenseRecord[] = [];
  for (const sitePackages of await findSitePackages(root)) {
    for (const entry of await readdir(sitePackages, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/\.(?:dist-info|egg-info)$/u.test(entry.name)) continue;
      const record = await collectDistribution(root, sitePackages, join(sitePackages, entry.name));
      if (record !== null) records.push(record);
    }
  }
  return records.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || left.version.localeCompare(right.version));
}
