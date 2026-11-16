/**
 * The chat page's "Ask about" choice: which data source the next turns are
 * about. Module state (like the app-mcp UI context) read by the chat seam, so
 * the choice travels inside the one hidden `[app context: …]` line and never
 * shows in the transcript.
 */
export interface ChatDataSource {
  id: string;
  name: string;
}

let current: ChatDataSource | null = null;

export function setChatDataSource(next: ChatDataSource | null): void {
  current = next;
}

export function getChatDataSource(): ChatDataSource | null {
  return current;
}

const NAME_LIMIT = 40;

/**
 * The context line for a turn: the UI context as is, or — when a data source
 * is chosen — a short line naming it (kept well under the server's 200-char
 * cap so the closing bracket, which the transcript strips on, survives).
 */
export function chatContextLine(uiLine: string | null, path: string | null, source: ChatDataSource | null): string | null {
  if (!source) return uiLine;
  const flat = source.name.replace(/[\s\]"]+/g, " ").trim();
  const name = flat.length > NAME_LIMIT ? `${flat.slice(0, NAME_LIMIT - 1)}…` : flat;
  const page = path ? `page ${path.slice(0, 60)} · ` : "";
  return `[app context: ${page}ask about data source "${name}" (source id ${source.id.slice(0, 64)})]`;
}
