// Pure helpers for the code editor (highlighting / autocomplete / lint). Kept
// out of the Svelte component so they are unit-testable without a DOM.

import { tokenize } from './engine/parse';

// Names the user has bound in the sheet — either `name = expr` or
// `unit name = expr`. Comments (after `#`) are ignored. Order of first
// definition is preserved; redefinitions are deduped.
export function collectVariables(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.split('#', 1)[0];
    const m = /^\s*(?:unit\s+)?([A-Za-z_]\w*)\s*=(?!=)/.exec(line);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

// Insertion text + cursor offset for a function-name autocomplete pick.
// Inserting just the bare name would leave the user to type the parens
// themselves; inserting `name(` and landing the cursor right after the
// paren puts them straight into the argument list.
export function functionInsertion(name: string): { insert: string; cursorOffset: number } {
  const insert = `${name}(`;
  return { insert, cursorOffset: insert.length };
}

// Pin the outer result before any `where` bindings. Only a top-level `in`
// is a display conversion; `to` builds an interval and must remain intact.
export function setLineConversion(line: string, unit: string): string {
  const hash = line.indexOf('#');
  const code = (hash >= 0 ? line.slice(0, hash) : line).trimEnd();
  const comment = hash >= 0 ? line.slice(hash).trim() : '';
  let depth = 0;
  let conversion: number | undefined;
  let where = code.length;
  for (const token of tokenize(code)) {
    if (token.kind === 'lparen' || token.kind === 'lbrack') depth++;
    else if (token.kind === 'rparen' || token.kind === 'rbrack') depth--;
    else if (depth === 0 && token.kind === 'ident') {
      if (token.value === 'where') {
        where = token.start;
        break;
      }
      if (token.value === 'in') conversion = token.start;
    }
  }
  const core = code.slice(0, conversion ?? where).trimEnd();
  const bindings = code.slice(where);
  const u = unit.trim();
  const rebuilt = `${core}${u ? ` in ${u}` : ''}${bindings ? ` ${bindings}` : ''}`;
  return comment ? `${rebuilt} ${comment}` : rebuilt;
}
