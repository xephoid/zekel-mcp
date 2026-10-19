import { describe, expect, it } from 'vitest';
import { seatDisplayName } from '../seatNames.js';

describe('seatDisplayName', () => {
  it('uses the given name, then "the AI", then "Player N"', () => {
    const players = [
      { player_id: 'p1', kind: 'human' as const, name: ' Zeke ' },
      { player_id: 'p2', kind: 'ai' as const },
      { player_id: 'p3', kind: 'human' as const },
    ];
    expect(seatDisplayName(players, 'p1')).toBe('Zeke');
    expect(seatDisplayName(players, 'p2')).toBe('the AI');
    expect(seatDisplayName(players, 'p3')).toBe('Player 3');
    expect(seatDisplayName(players, 'nobody')).toBe('nobody');
  });

  it('numbers several unnamed AI seats', () => {
    const players = [
      { player_id: 'a', kind: 'ai' as const },
      { player_id: 'b', kind: 'ai' as const, name: 'Blue' },
      { player_id: 'c', kind: 'ai' as const },
    ];
    expect(seatDisplayName(players, 'a')).toBe('AI 1');
    expect(seatDisplayName(players, 'b')).toBe('Blue');
    expect(seatDisplayName(players, 'c')).toBe('AI 2');
  });
});
