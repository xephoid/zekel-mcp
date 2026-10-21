// @zekel/dev: the tools for building and checking a game for the Zekel server.
//
// A project uses them in two parts:
//   1. It registers each game's extra parts for the tools (its "dev hooks":
//      balance settings, metrics, rules-checker adapters, desync wording) with
//      registerDevHooks. Games without any need nothing.
//   2. It runs a command with runDevCommand, passing its list of games.
//
// Commands that play through the server (ai-harness, the bots) start the
// project's built server, dist/index.js in the current folder by default.

import type { DevSetup } from './commands/setup.js';

export type { DevSetup } from './commands/setup.js';
export {
  registerDevHooks,
  markDevHooksLoaded,
  devHooksFor,
  type GameDevHooks,
  type SweepSpec,
  type SweepBuilder,
  type StrategyDraft,
  type StrategyDraftPlan,
  type DesyncHooks,
} from './harness/devHooks.js';

type Command = (argv: string[], setup: DevSetup) => Promise<void>;

/** Every command, by the name it is run with. */
export const COMMANDS: Record<string, () => Promise<Command>> = {
  'ai-harness': async () => (await import('./commands/ai-harness.js')).main,
  'assistant-bot': async () => (await import('./commands/assistant-bot.js')).main,
  'balance-dashboard': async () => (await import('./commands/balance-dashboard.js')).main,
  'check-summaries': async () => (await import('./commands/check-summaries.js')).main,
  'choice-catalog': async () => (await import('./commands/choice-catalog.js')).main,
  'desync-bot': async () => (await import('./commands/desync-bot.js')).main,
  'engine-bot': async () => (await import('./commands/engine-bot.js')).main,
  'human-seat-sweep': async () => (await import('./commands/human-seat-sweep.js')).main,
  'integration-bot': async () => (await import('./commands/integration-bot.js')).main,
  'llm-bot': async () => (await import('./commands/llm-bot.js')).main,
  'relay-bot': async () => (await import('./commands/relay-bot.js')).main,
  'verify-hunt': async () => (await import('./commands/verify-hunt.js')).main,
  'verify-lint': async () => (await import('./commands/verify-lint.js')).main,
};

/**
 * Run one command. `argv` is the command's own arguments (a leading `--`, which
 * pnpm passes through, is dropped). A failure is printed and sets exit code 1.
 */
export async function runDevCommand(name: string, argv: string[], setup: DevSetup = {}): Promise<void> {
  const load = COMMANDS[name];
  if (!load) {
    process.stderr.write(`Unknown command "${name}". Commands: ${Object.keys(COMMANDS).join(', ')}\n`);
    process.exitCode = 2;
    return;
  }
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  try {
    await (await load())(args, setup);
  } catch (e) {
    process.stderr.write(`${name} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  }
}
