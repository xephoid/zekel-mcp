import type { AnyGame } from '@zekel/mcp';

/** What a project hands the commands: the things only it knows. */
export interface DevSetup {
  /** The project's games, for the commands that load games directly instead of
   *  through a running server (check-summaries, choice-catalog). */
  games?: AnyGame[];
}
