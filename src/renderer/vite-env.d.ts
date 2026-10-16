/**
 * Asset type declarations for the renderer.
 *
 * The legacy shell owned the only `declare module '*.css'` in the repository, so the new shell
 * type-checked *through* it. Deleting the legacy tree on cutover day exposed that: three CSS
 * side-effect imports (`styles/index.css`, `react-diff-view/style/index.css`,
 * `@xterm/xterm/css/xterm.css`) stopped resolving. The declaration lives here now, next to the
 * shell that uses it (F26 ①).
 */

declare module '*.css';
