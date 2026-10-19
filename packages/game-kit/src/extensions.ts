// Extra MCP tools and resources a game adds beside the shared ones (e.g. Warble
// Way Galaxy's get_lore). Described as plain data plus a function, so a game
// never imports the MCP SDK or zod: the server turns each description into a
// real tool or resource (src/mcp/extensions.ts) and formats every reply.
//
// A game returns these from the optional Game hooks getExtraTools() and
// getExtraResources(). Names and URIs must not clash with the server's own
// tools/resources or with another game's; the server refuses to start if they do.

/** One argument of an extra tool. Every argument is a string. */
export interface ExtraToolArgument {
  description: string;
  /** Default false: the argument must be given. */
  optional?: boolean;
}

/** What an extra tool's run() returns. `result` is sent back as JSON (indented);
 *  `error` is sent back as a tool error carrying that JSON. */
export type ExtraToolOutcome =
  | { result: unknown }
  | { error: { error_code: string; message: string } };

export interface ExtraTool {
  name: string;
  description: string;
  args: Record<string, ExtraToolArgument>;
  run(args: Record<string, string | undefined>): ExtraToolOutcome;
}

/** A resource at one fixed URI. */
export interface ExtraResource {
  /** Short internal name, unique across the server. */
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  /** The resource's text. */
  read(): string;
}

/** A family of resources at a URI template such as `game://x/lore/{topic}`. */
export interface ExtraResourceTemplate {
  name: string;
  uriTemplate: string;
  title: string;
  description: string;
  mimeType: string;
  /** The text for the filled-in template. Throw an Error to say "no such resource". */
  read(vars: Record<string, string>): string;
}

export interface ExtraResources {
  fixed?: ExtraResource[];
  templates?: ExtraResourceTemplate[];
}
