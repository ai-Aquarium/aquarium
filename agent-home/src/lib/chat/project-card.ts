/**
 * The project card an agent's reply ends with after creating a project from
 * the chat (`hermes projects create --from-chat` prints the line):
 * `[project card: <slug> <ref>? quoted?]`, on its own line.
 */
export interface ProjectCardRef {
  slug: string;
  ref: string | null;
  /** The creator's request was quoted in the project's shared chat. */
  quoted: boolean;
}

const CARD_LINE = /^[ \t]*\[project card: ([a-z0-9][a-z0-9-]*)(?: ([A-Za-z]+\d+))?( quoted)?\][ \t]*$/;

/** The reply without its card lines, and the cards they named. */
export function splitProjectCards(text: string): { text: string; cards: ProjectCardRef[] } {
  if (!text.includes("[project card: ")) return { text, cards: [] };
  const cards: ProjectCardRef[] = [];
  const kept: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : CARD_LINE.exec(line);
    if (!m) {
      kept.push(line);
      continue;
    }
    if (!cards.some((c) => c.slug === m[1])) {
      cards.push({ slug: m[1], ref: m[2] ?? null, quoted: Boolean(m[3]) });
    }
  }
  return { text: kept.join("\n").replace(/\n+$/, ""), cards };
}
