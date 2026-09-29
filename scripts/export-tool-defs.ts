// Writes lib/chat/tools/defs.json from TOOL_DEFS for the future Python MCP
// twin (section 1.6). The JSON is the plain ToolDef shape in the fixed tool
// order. Run: pnpm exec tsx scripts/export-tool-defs.ts
// scripts/chat-tools-check.ts asserts the file matches TOOL_DEFS, so rerun
// this after any edit to lib/chat/tools/defs.ts.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TOOL_DEFS } from "../lib/chat/tools/defs";

export const DEFS_JSON_PATH = resolve(__dirname, "../lib/chat/tools/defs.json");

export function renderToolDefs(): string {
  return `${JSON.stringify({ version: 1, tools: TOOL_DEFS }, null, 2)}\n`;
}

if (require.main === module) {
  writeFileSync(DEFS_JSON_PATH, renderToolDefs(), "utf8");
  process.stdout.write(`wrote ${DEFS_JSON_PATH} (${TOOL_DEFS.length} tools)\n`);
}
