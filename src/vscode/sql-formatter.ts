import { format as formatSql } from "sql-formatter";

import type { FormatOptions } from "../protocol.js";

/** Format protected SQL with the bundled sql-formatter engine. */
export function formatProtectedSql(sql: string, options: FormatOptions): string {
  return formatSql(sql, {
    language: options.dialect,
    tabWidth: options.indentWidth,
    keywordCase: options.keywordCase === "preserve" ? "preserve" : options.keywordCase,
    linesBetweenQueries: 1,
  });
}
