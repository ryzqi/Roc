import {
  assertLiveResearchToolchainForPackaging,
  createPackagingEnvironment,
  runCommand,
  sanitizeLanggraphSdkForPackaging,
  verifyWorkspaceBetterSqlite3
} from '../lib/native-packaging.mjs';

export default async function beforePack() {
  const langgraphSdkSanitize = sanitizeLanggraphSdkForPackaging();
  if (langgraphSdkSanitize.rewrittenFiles.length > 0) {
    console.log(
      `Sanitized @langchain/langgraph-sdk bundled pnpm imports in ${langgraphSdkSanitize.rewrittenFiles.length} file(s) for packaging.`
    );
  }
  verifyWorkspaceBetterSqlite3({
    run: (command, args, options) =>
      runCommand(command, args, {
        ...options,
        env: createPackagingEnvironment(options?.env)
      })
  });
  assertLiveResearchToolchainForPackaging();
}
