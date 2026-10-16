/**
 * Attribution of built chunks back to npm packages.
 *
 * Extracted from `check-renderer-chunks.mjs` (P3) for two reasons:
 *
 *   1. **It was wrong in a way nobody could see.** pnpm encodes a scope's `/` as
 *      `+` in the `.pnpm` directory name, so the region marker for xterm reads
 *      `@xterm+xterm@6.0.0/…`. The previous parser returned `@xterm+xterm`, which
 *      never equals the `@xterm/xterm` on the deny-list — the two scoped entries
 *      could never fire while the docs said they were enforced. Logic that decides
 *      whether a guard fires has to be testable on its own.
 *   2. The eager-graph check and the attribution report both need it; two copies
 *      would drift (they already had).
 *
 * Verified shapes this has to handle (all real, from `dist/renderer`):
 *   react@19.3.0/node_modules/react/index.js
 *   react-diff-view@3.3.3_react@19.3.0/node_modules/react-diff-view/es/index.js
 *   @xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs
 *   @xterm+addon-fit@0.11.0/node_modules/@xterm/addon-fit/lib/addon-fit.mjs
 *   motion-dom@14.2.0/node_modules/motion-dom/dist/es/…
 */

/** rolldown's region comment, capturing the pnpm directory plus the inner path. */
export const REGION_PATTERN = /\/\/#region[ \t]+node_modules\/\.pnpm\/([^\n]+)/gu;

/**
 * Packages that must never appear in the entry's static graph.
 *
 * Each one is reachable only from a lazily loaded surface: the Git panel
 * (`react-diff-view`), the terminal (`@xterm/*`), literature/Markdown (`katex`,
 * `react-markdown`, `streamdown`, `highlight.js`) and long transcript lists
 * (`react-virtuoso`). Adding a package here is the assertion that the lazy
 * boundary around it is intentional.
 *
 * `zod` (P8) is the same shape one level down: its only consumers are the
 * `src/shared/schemas/**` modules, which are imported by lazily loaded surfaces (the settings
 * centre's hooks editor and the assistant's persisted-thread history). It used to be guarded
 * only by the byte budget, which cannot distinguish "zod grew the lazy chunk" from "zod leaked
 * into every launch"; the P8 review asked for the assertion, and `report:renderer-eager` shows
 * the entry's four files carry no zod region.
 */
export const EAGER_FORBIDDEN_PACKAGES = [
  'react-diff-view',
  '@xterm/xterm',
  '@xterm/addon-fit',
  'katex',
  'highlight.js',
  'react-markdown',
  'streamdown',
  'react-virtuoso',
  'zod'
];

/**
 * The package a `.pnpm` region belongs to.
 *
 * `specifier` is everything after `node_modules/.pnpm/`, e.g.
 * `@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs`.
 *
 * Order matters: strip the inner path first (it contains a **second**
 * `/node_modules/`, and it also contains the real, un-encoded `@xterm/xterm`,
 * which is tempting and wrong — the outer directory is the authority), then the
 * pnpm peer suffix (`_react@19.3.0`), then the version, then decode `+` back to `/`.
 */
export function packageNameOf(specifier) {
  const directory = specifier.split('/node_modules/')[0];
  const withoutPeer = directory.split('_')[0];
  if (withoutPeer.startsWith('@')) {
    // `@xterm+xterm@6.0.0` → parts ['', 'xterm+xterm', '6.0.0']
    const parts = withoutPeer.split('@').filter((part) => part.length > 0);
    const scoped = parts[0];
    return scoped === undefined ? withoutPeer : `@${scoped.replaceAll('+', '/')}`;
  }
  return withoutPeer.split('@')[0];
}

/** Package name → number of regions, for one built file's source. */
export function scanPackageRegions(source) {
  const counts = new Map();
  for (const match of source.matchAll(REGION_PATTERN)) {
    const name = packageNameOf(match[1]);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * Deny-listed packages present in one built file's source (sorted, de-duplicated).
 *
 * This is the function the acceptance check turns into a build failure, so it is
 * the one that must not have a silent no-match path: anything on the deny-list that
 * the source contains is returned.
 */
export function findForbiddenPackages(source, denyList = EAGER_FORBIDDEN_PACKAGES) {
  const found = scanPackageRegions(source);
  return denyList.filter((name) => found.has(name)).sort();
}
