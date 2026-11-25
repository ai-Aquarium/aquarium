/**
 * Static audit behind the `data-appmcp-hint` ratchet (hint-ratchet.test.ts).
 *
 * Finds the JSX openings of interactive elements in a .tsx source and reports
 * the ones an agent cannot understand from the DOM alone: no authored hint
 * (`data-appmcp-hint`, `title`, `aria-description` — what `hintOf` reads at
 * runtime) and no self-describing name (a literal `aria-label`, `placeholder`
 * or text child of two words or more). A lexical scan, not a parser: it only
 * has to be stable enough to count gaps per file.
 */

const INTERACTIVE_TAGS = ["button", "a", "input", "select", "textarea", "Link", "ActionButton"];
const INTERACTIVE_ROLES = /\brole=["'](button|link|tab|menuitem|checkbox|switch|option)["']/;
const HINT_ATTR = /(^|\s)(data-appmcp-hint|title|aria-description)=/;
const OPENING = new RegExp(`<(${INTERACTIVE_TAGS.join("|")}|[a-z][a-z0-9]*)(?=[\\s/>])`, "g");

export interface HintGap {
  line: number;
  tag: string;
  /** The opening tag, flattened and clipped, for the failure message. */
  snippet: string;
}

/** Index just past the `>` that closes the opening tag starting at `start`. */
function openingEnd(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const close = src.indexOf(ch, i + 1);
      if (close < 0) return src.length;
      i = close;
    } else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return i + 1;
  }
  return src.length;
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function literalAttr(opening: string, attr: string): string | null {
  const m = opening.match(new RegExp(`(?:^|\\s)${attr}=(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/** Static text between the opening and the matching close, JSX expressions and tags removed. */
function staticChildren(src: string, from: number, tag: string): string {
  const close = src.indexOf(`</${tag}>`, from);
  if (close < 0) return "";
  return src
    .slice(from, close)
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/<[^>]*>/g, " ");
}

export function auditSource(src: string): HintGap[] {
  const gaps: HintGap[] = [];
  for (const match of src.matchAll(OPENING)) {
    const tag = match[1];
    const start = match.index ?? 0;
    const prev = start > 0 ? src[start - 1] : " ";
    if (/[\w$.]/.test(prev)) continue;
    const end = openingEnd(src, start);
    const opening = src.slice(start, end);
    const intrinsicInteractive = INTERACTIVE_TAGS.includes(tag);
    if (!intrinsicInteractive && !INTERACTIVE_ROLES.test(opening)) continue;
    if (tag === "a" && !/\shref=/.test(opening)) continue;
    if (tag === "input" && /\stype=["']hidden["']/.test(opening)) continue;
    if (HINT_ATTR.test(opening)) continue;
    const named = ["aria-label", "placeholder"].some((attr) => {
      const value = literalAttr(opening, attr);
      return value !== null && words(value) >= 2;
    });
    if (named) continue;
    if (!opening.endsWith("/>") && words(staticChildren(src, end, tag)) >= 2) continue;
    gaps.push({
      line: src.slice(0, start).split("\n").length,
      tag,
      snippet: opening.replace(/\s+/g, " ").slice(0, 120),
    });
  }
  return gaps;
}
