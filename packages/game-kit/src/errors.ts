export type ErrorCode =
  | 'ILLEGAL_MOVE'
  | 'NOT_YOUR_TURN'
  | 'AMBIGUOUS_MOVE'
  | 'INVALID_MOVE_SHAPE'
  | 'SESSION_NOT_FOUND'
  | 'GAME_NOT_FOUND'
  | 'INVALID_OPTIONS'
  | 'INVALID_PLAYERS'
  | 'GAME_OVER'
  | 'PLAYER_NOT_FOUND'
  | 'NOT_AN_AI_PLAYER'
  | 'AI_SEAT_NO_APPLY'
  | 'AI_BACKEND_UNAVAILABLE'
  | 'NO_SUGGESTION'
  | 'STORAGE_ERROR'
  // join_session / multi-device seat auth
  | 'JOIN_CODE_NOT_FOUND'
  | 'SESSION_NOT_JOINABLE'
  | 'NO_OPEN_SEAT'
  | 'SEAT_NOT_CLAIMED'
  | 'SEAT_AUTH_REQUIRED'
  | 'INVALID_SEAT_AUTH';

export class GameError extends Error {
  readonly error_code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'GameError';
    this.error_code = code;
    this.details = details;
  }

  toJSON(): { error_code: ErrorCode; message: string; details?: unknown } {
    return {
      error_code: this.error_code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}
