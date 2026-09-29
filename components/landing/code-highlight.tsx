import type { ReactNode } from "react";

/**
 * Syntax colouring for the landing page's code panels.
 *
 * The reference implementation ran several regex replacements in sequence over
 * the same string, each inserting <span class="…"> markup. Later passes then
 * matched inside the markup earlier passes had written — the quote pattern
 * caught `"text-foreground"` in a class attribute — which is why raw class
 * names leaked onto the page as visible text. It also rendered through
 * dangerouslySetInnerHTML.
 *
 * This version tokenizes once, left to right, and returns React elements, so
 * nothing is ever re-scanned and nothing is injected as HTML.
 */
const KEYWORDS = new Set([
  "curl", "docker", "compose", "up", "npm", "run", "git", "clone", "cd",
  "import", "from", "const", "await", "export",
]);

type Token = { kind: "comment" | "string" | "keyword" | "flag" | "punct" | "text"; text: string };

export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const push = (kind: Token["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind === "text") last.text += text;
    else out.push({ kind, text });
  };

  while (i < line.length) {
    const rest = line.slice(i);

    // A comment runs to the end of the line.
    if (rest.startsWith("//") || (rest.startsWith("#") && (i === 0 || /\s/.test(line[i - 1])))) {
      push("comment", rest);
      break;
    }
    // Quoted string, single or double, taken whole.
    const q = rest[0];
    if (q === "'" || q === '"') {
      const end = rest.indexOf(q, 1);
      const text = end === -1 ? rest : rest.slice(0, end + 1);
      push("string", text);
      i += text.length;
      continue;
    }
    // Command-line flag: -X, --build.
    const flag = /^--?[A-Za-z][\w-]*/.exec(rest);
    if (flag && (i === 0 || /\s/.test(line[i - 1]))) {
      push("flag", flag[0]);
      i += flag[0].length;
      continue;
    }
    // Word: keyword or plain.
    const word = /^[A-Za-z_][\w-]*/.exec(rest);
    if (word) {
      push(KEYWORDS.has(word[0]) ? "keyword" : "text", word[0]);
      i += word[0].length;
      continue;
    }
    if ("{}()[]:,\\".includes(rest[0])) {
      push("punct", rest[0]);
      i += 1;
      continue;
    }
    push("text", rest[0]);
    i += 1;
  }
  return out;
}

const CLASS: Record<Token["kind"], string> = {
  comment: "text-muted-soft",
  string: "text-green-400",
  keyword: "text-primary",
  flag: "text-foreground",
  punct: "text-muted-soft",
  text: "",
};

export function Highlighted({ line }: { line: string }): ReactNode {
  return tokenize(line).map((t, i) =>
    t.kind === "text" ? t.text : <span key={i} className={CLASS[t.kind]}>{t.text}</span>,
  );
}
