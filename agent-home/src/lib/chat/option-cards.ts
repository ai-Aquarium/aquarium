/**
 * The 2-3 approaches an agent offers while co-creating a playbook, written
 * as a fenced block the projects skill asks for:
 *
 * ```options
 * [{"label": "A", "title": "Stop and tell Leo", "pros": ["…"], "cons": ["…"]}]
 * ```
 *
 * A block that is not a JSON array of options stays in the reply as text.
 */
export interface OptionCard {
  label: string;
  title: string;
  pros: string[];
  cons: string[];
}

const FENCE = /^[ \t]*```options[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*$/m;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

function parseOptions(raw: string): OptionCard[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const options: OptionCard[] = [];
  for (const [i, item] of data.entries()) {
    if (item == null || typeof item !== "object") return null;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) return null;
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : String.fromCharCode(65 + i);
    options.push({ label, title, pros: strings(o.pros), cons: strings(o.cons) });
  }
  return options.length > 0 ? options : null;
}

/** The reply without its options block, and the options it offered. */
export function splitOptionCards(text: string): { text: string; options: OptionCard[] } {
  if (!text.includes("```options")) return { text, options: [] };
  const m = FENCE.exec(text);
  const options = m ? parseOptions(m[1]) : null;
  if (!m || !options) return { text, options: [] };
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\n{3,}/g, "\n\n").trim();
  return { text: rest, options };
}

/** What a picked option puts in the composer, ready to send or amend. */
export function optionReply(option: OptionCard): string {
  return `Option ${option.label}: ${option.title}`;
}
