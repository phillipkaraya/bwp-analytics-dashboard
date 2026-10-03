/** Official SDK native authentication only. No credential extraction or copying. */
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function nativeEnvironment(): Record<string, string> & { NODE_ENV: "production" } {
  return { NODE_ENV: "production", ...Object.fromEntries(["HOME", "PATH", "TMPDIR", "LANG", "USER", "LOGNAME", "SHELL", "TERM"]
    .flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])) };
}
export function nativeExecutable(): string {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  return sdkRequire.resolve(`${name}/${process.platform === "win32" ? "claude.exe" : "claude"}`);
}
export async function nativeSignedIn(): Promise<boolean> {
  return new Promise(resolve => {
    execFile(nativeExecutable(), ["auth", "status", "--json"], { env: nativeEnvironment(), timeout: 15_000, maxBuffer: 16_384 }, (_error, stdout) => {
      try {
        const info = JSON.parse(stdout);
        resolve(!_error && info.loggedIn === true && info.authMethod === "claude.ai" && info.apiProvider === "firstParty");
      } catch { resolve(false); }
    });
  });
}
async function main() {
  if (await nativeSignedIn()) console.log("Claude native sign-in: ready. Start the connector with pnpm chat:helper.");
  else {
    console.log("Claude native sign-in: needed. Complete the official login yourself, then rerun pnpm chat:doctor.");
    console.log(`Native login command: '${nativeExecutable()}' auth login`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(() => {
  console.error("The pinned native Claude runtime is missing. Run pnpm install in the dashboard folder.");
  process.exitCode = 1;
});
