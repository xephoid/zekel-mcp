// @zekel/game-kit: everything a game module may use from shared code.
//
// A game imports shared code ONLY through this file. The rule is checked by
// src/game-kit/__tests__/boundary.test.ts. Files in this folder import nothing
// outside it, so the folder can become its own published package when the
// repos split (extraction/d1-option-a-analysis.md, phase 2).

export * from './game.js'; // the Game interface, SessionState and the result types
export * from './errors.js'; // GameError and the stable error codes
export * from './mcts.js'; // the generic MCTS search behind difficulty 'mcts'
export * from './rng.js'; // seeded random numbers
export * from './seatNames.js';
export * from './rulesSections.js';
export * from './moveGates.js';
export * from './moveMenu.js';
export * from './setupChoices.js';
export * from './gameLog.js';
export * from './reportRng.js';
export * from './reportHand.js';
export * from './nextStepFacts.js';
export * from './extensions.js'; // extra MCP tools/resources a game adds
export * from './board.js'; // types for a game's browser board drawing
export * from './assets.js'; // folderOf(import.meta.url) for Game.webAssetsDir
