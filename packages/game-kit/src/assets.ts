// Where a game's own files are at run time, for Game.webAssetsDir.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder holding the module at `moduleUrl`. Call it from the game's
 *  index.ts as `folderOf(import.meta.url)`: compiled, that is the game's
 *  folder under dist/ (or inside an installed package). */
export function folderOf(moduleUrl: string): string {
  return path.dirname(fileURLToPath(moduleUrl));
}
