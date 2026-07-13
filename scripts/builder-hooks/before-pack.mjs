import {
  createPackagingEnvironment,
  prepareAndVerifyWorkspaceBetterSqlite3,
  runCommand,
  sanitizeLanggraphSdkForPackaging,
  terminateRunningPackagedApp
} from '../lib/native-packaging.mjs';

export default async function beforePack() {
  terminateRunningPackagedApp();
  const langgraphSdkSanitize = sanitizeLanggraphSdkForPackaging();
  if (langgraphSdkSanitize.rewrittenFiles.length > 0) {
    console.log(
      `Sanitized @langchain/langgraph-sdk bundled pnpm imports in ${langgraphSdkSanitize.rewrittenFiles.length} file(s) for packaging.`
    );
  }
  prepareAndVerifyWorkspaceBetterSqlite3({
    run: (command, args, options) =>
      runCommand(command, args, {
        ...options,
        env: createPackagingEnvironment(options?.env)
      })
  });
}
