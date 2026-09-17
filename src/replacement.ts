/** Collapse single-line literal output so Python syntax stays intact. */
export function collapseReplacement(literalText: string, replacement: string): string {
  if (literalText.includes("\n")) return replacement;
  return replacement.replace(/\s*\n\s*/g, " ").trim();
}
