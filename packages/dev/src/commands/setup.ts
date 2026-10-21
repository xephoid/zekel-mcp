import type { AnyGame } from '@zekel/mcp';

/** What a project hands the commands: the things only it knows. */
export interface DevSetup {
  /** The project's games, for the commands that load games directly instead of
   *  through a running server (check-summaries, choice-catalog). */
  games?: AnyGame[];
  /** The project's MCP server program, for the commands that play through one
   *  (ai-harness, the bots, human-seat-sweep). Default: dist/index.js in the
   *  current folder. ai-harness's --server still wins for one run. */
  serverPath?: string;
}
