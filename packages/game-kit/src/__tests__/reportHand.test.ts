// The shared "human reports the cards they drew" directive (src/core/reportHand.ts),
// used by Arcs / Brass / SW:R for their shared-deck draws.

import { describe, it, expect } from 'vitest';
import { reportHandNextStep } from '../reportHand.js';

describe('reportHandNextStep', () => {
  it('routes to the drawing human and names the move', () => {
    const step = reportHandNextStep({
      moveType: 'report_initial_hand',
      playerId: 'h1',
      ask: 'the 8 card types in their hand',
    });
    expect(step.status).toBe('human_to_move');
    expect(step.active_player_id).toBe('h1');
    expect(step.instruction).toContain('report_initial_hand');
  });

  it('carries a human_response that records by printed NAME, not an internal id', () => {
    const hr = reportHandNextStep({ moveType: 'report_refill', playerId: 'h1', ask: 'the cards drawn' }).human_response;
    expect(hr).toBeDefined();
    expect(hr!.records_as).toContain('report_refill');
    expect(hr!.records_as.toLowerCase()).toContain('name');
    expect(hr!.ask).toContain('h1');
    // The example demonstrates printed names and warns off internal ids.
    expect(hr!.example.toLowerCase()).toContain('name');
    expect(hr!.example.toLowerCase()).toContain('id');
  });
});
