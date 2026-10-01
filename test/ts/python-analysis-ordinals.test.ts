import { describe, expect, it } from "vitest";

import { replaceOrdinals } from "../../src/python-analysis/ordinals.js";

describe("replaceOrdinals", () => {
  it("prefers the alias in ORDER BY and copies the expression in GROUP BY", () => {
    const select = "SELECT user_id, date_trunc('month', paid_at) AS ym FROM payments";
    expect(replaceOrdinals(`${select} ORDER BY 1, 2`)).toBe(`${select} ORDER BY user_id, ym`);
    expect(replaceOrdinals(`${select} GROUP BY 1, 2`)).toBe(
      `${select} GROUP BY user_id, date_trunc('month', paid_at)`,
    );
  });

  it("uses implicit aliases after function calls", () => {
    expect(replaceOrdinals("SELECT SUM(amount) paid FROM t ORDER BY 1")).toBe(
      "SELECT SUM(amount) paid FROM t ORDER BY paid",
    );
  });

  it("copies the expression when no alias exists", () => {
    expect(replaceOrdinals("SELECT a + b, c FROM t GROUP BY 1, 2")).toBe(
      "SELECT a + b, c FROM t GROUP BY a + b, c",
    );
  });

  it("keeps aggregate columns without an alias untouched", () => {
    expect(replaceOrdinals("SELECT count(*) FROM t GROUP BY 1")).toBe(
      "SELECT count(*) FROM t GROUP BY 1",
    );
  });

  it("replaces ORDER BY ordinals too", () => {
    expect(replaceOrdinals("SELECT a, b FROM t ORDER BY 1, 2")).toBe(
      "SELECT a, b FROM t ORDER BY a, b",
    );
  });

  it("does not treat arithmetic expressions as ordinals", () => {
    expect(replaceOrdinals("SELECT a FROM t GROUP BY 1 + 2")).toBe(
      "SELECT a FROM t GROUP BY 1 + 2",
    );
  });

  it("leaves out-of-range ordinals untouched", () => {
    expect(replaceOrdinals("SELECT a FROM t GROUP BY 99")).toBe("SELECT a FROM t GROUP BY 99");
  });

  it("resolves ordinals inside subqueries against their own select list", () => {
    const sql =
      "SELECT user_id, total FROM (SELECT user_id, SUM(x) total FROM t GROUP BY 1) s GROUP BY 1, 2";
    expect(replaceOrdinals(sql)).toBe(
      "SELECT user_id, total FROM (SELECT user_id, SUM(x) total FROM t GROUP BY user_id) s GROUP BY user_id, total",
    );
  });

  it("handles a case expression alias", () => {
    const sql = "SELECT CASE WHEN x THEN y ELSE z END tier FROM t ORDER BY 1";
    expect(replaceOrdinals(sql)).toBe(
      "SELECT CASE WHEN x THEN y ELSE z END tier FROM t ORDER BY tier",
    );
  });

  it("flattens multi-line expressions", () => {
    const sql = "SELECT\n  date_trunc(\n    'month',\n    paid_at\n  ) AS ym\nFROM t\nGROUP BY 1";
    expect(replaceOrdinals(sql)).toBe(
      "SELECT\n  date_trunc(\n    'month',\n    paid_at\n  ) AS ym\nFROM t\nGROUP BY date_trunc('month', paid_at)",
    );
  });

  it("keeps qualified single columns without aliases", () => {
    expect(replaceOrdinals("SELECT s.amount FROM sales s GROUP BY 1")).toBe(
      "SELECT s.amount FROM sales s GROUP BY s.amount",
    );
  });

  it("never replaces an ordinal with a star column", () => {
    expect(replaceOrdinals("SELECT * FROM table ORDER BY 1, 3")).toBe(
      "SELECT * FROM table ORDER BY 1, 3",
    );
  });

  it("treats DISTRIBUTE as a clause end so trailing ordinals still resolve", () => {
    expect(replaceOrdinals("SELECT a, b, c FROM t GROUP BY 1, 2, 3 DISTRIBUTE RANDOM")).toBe(
      "SELECT a, b, c FROM t GROUP BY a, b, c DISTRIBUTE RANDOM",
    );
  });

  it("keeps every ordinal at or after a star column, whose width is unknown", () => {
    expect(replaceOrdinals("SELECT *, a FROM t GROUP BY 1, 2")).toBe(
      "SELECT *, a FROM t GROUP BY 1, 2",
    );
    expect(replaceOrdinals("SELECT *, upper(name) AS n FROM users ORDER BY 2")).toBe(
      "SELECT *, upper(name) AS n FROM users ORDER BY 2",
    );
    expect(replaceOrdinals("SELECT t.*, a FROM t ORDER BY 2")).toBe(
      "SELECT t.*, a FROM t ORDER BY 2",
    );
    expect(replaceOrdinals("SELECT a, * FROM t ORDER BY 1, 2")).toBe(
      "SELECT a, * FROM t ORDER BY a, 2",
    );
  });

  it("keeps ORDER BY direction suffixes on the replaced column", () => {
    expect(replaceOrdinals("SELECT a, b FROM t ORDER BY 1 DESC, 2 ASC")).toBe(
      "SELECT a, b FROM t ORDER BY a DESC, b ASC",
    );
    expect(replaceOrdinals("SELECT a, b FROM t ORDER BY 1 DESC NULLS LAST")).toBe(
      "SELECT a, b FROM t ORDER BY a DESC NULLS LAST",
    );
  });

  it("resolves ordinals in UNION ALL branches against their own select list", () => {
    expect(replaceOrdinals("SELECT a FROM t GROUP BY 1 UNION ALL SELECT b FROM u GROUP BY 1")).toBe(
      "SELECT a FROM t GROUP BY a UNION ALL SELECT b FROM u GROUP BY b",
    );
  });

  it("keeps fully qualified column names intact", () => {
    expect(replaceOrdinals("SELECT project.dataset.table.col FROM t GROUP BY 1")).toBe(
      "SELECT project.dataset.table.col FROM t GROUP BY project.dataset.table.col",
    );
  });

  it("uses quoted aliases verbatim", () => {
    expect(replaceOrdinals('SELECT a AS "quoted alias", b FROM t ORDER BY 1, 2')).toBe(
      'SELECT a AS "quoted alias", b FROM t ORDER BY "quoted alias", b',
    );
  });

  it("treats QUALIFY and WITH as clause ends", () => {
    expect(replaceOrdinals("SELECT a, b, COUNT(*) AS n FROM t GROUP BY 1, 2 QUALIFY n > 1")).toBe(
      "SELECT a, b, COUNT(*) AS n FROM t GROUP BY a, b QUALIFY n > 1",
    );
    expect(replaceOrdinals("SELECT a, b FROM t GROUP BY 1, 2 WITH ROLLUP")).toBe(
      "SELECT a, b FROM t GROUP BY a, b WITH ROLLUP",
    );
  });

  it("does not copy comments from the select expression", () => {
    expect(replaceOrdinals("SELECT userid /* テキスト */, amount FROM t GROUP BY 1, 2")).toBe(
      "SELECT userid /* テキスト */, amount FROM t GROUP BY userid, amount",
    );
    expect(replaceOrdinals("SELECT userid -- テキスト\nFROM t GROUP BY 1")).toBe(
      "SELECT userid -- テキスト\nFROM t GROUP BY userid",
    );
    expect(replaceOrdinals("SELECT date_trunc('month', /* c */ paid_at) FROM t GROUP BY 1")).toBe(
      "SELECT date_trunc('month', /* c */ paid_at) FROM t GROUP BY date_trunc('month', paid_at)",
    );
  });

  it("treats comments as whitespace between expression and implicit alias", () => {
    expect(replaceOrdinals("SELECT a /* c */ b FROM t ORDER BY 1")).toBe(
      "SELECT a /* c */ b FROM t ORDER BY b",
    );
  });

  it("still resolves ordinals followed by a comment", () => {
    expect(replaceOrdinals("SELECT a, b FROM t GROUP BY 1 /* c */, 2")).toBe(
      "SELECT a, b FROM t GROUP BY a /* c */, b",
    );
  });

  it("keeps ordinals whose column expression contains an f-string field", () => {
    expect(
      replaceOrdinals("SELECT ci.{parameter} /* テキスト */, amount FROM t GROUP BY 1, 2"),
    ).toBe("SELECT ci.{parameter} /* テキスト */, amount FROM t GROUP BY 1, amount");
    expect(replaceOrdinals("SELECT ci.{parameter} AS p, amount FROM t GROUP BY 1, 2")).toBe(
      "SELECT ci.{parameter} AS p, amount FROM t GROUP BY 1, amount",
    );
    expect(replaceOrdinals("SELECT ci.{parameter} AS p, amount FROM t ORDER BY 1, 2")).toBe(
      "SELECT ci.{parameter} AS p, amount FROM t ORDER BY p, amount",
    );
  });

  it("detects aliases that trail a comment", () => {
    expect(
      replaceOrdinals(
        "SELECT CASE WHEN site = 1 /* テキスト */ THEN chn ELSE nm END AS label /* テキスト */, amount FROM t ORDER BY 1, 2",
      ),
    ).toBe(
      "SELECT CASE WHEN site = 1 /* テキスト */ THEN chn ELSE nm END AS label /* テキスト */, amount FROM t ORDER BY label, amount",
    );
    expect(replaceOrdinals("SELECT SUM(amount) AS total /* c */ FROM t ORDER BY 1")).toBe(
      "SELECT SUM(amount) AS total /* c */ FROM t ORDER BY total",
    );
  });
  it("never groups by an alias, which may name an input column instead", () => {
    expect(replaceOrdinals("SELECT upper(name) AS name, count(*) AS n FROM users GROUP BY 1")).toBe(
      "SELECT upper(name) AS name, count(*) AS n FROM users GROUP BY upper(name)",
    );
  });

  it("drops SELECT modifiers from the copied expression", () => {
    expect(replaceOrdinals("SELECT DISTINCT upper(name) FROM users ORDER BY 1")).toBe(
      "SELECT DISTINCT upper(name) FROM users ORDER BY upper(name)",
    );
    expect(replaceOrdinals("SELECT DISTINCT ON (a) a, b FROM t ORDER BY 1, 2")).toBe(
      "SELECT DISTINCT ON (a) a, b FROM t ORDER BY a, b",
    );
  });

  it("keeps ORDER BY ordinals after a set operator", () => {
    expect(replaceOrdinals("SELECT a FROM t UNION SELECT b FROM u ORDER BY 1")).toBe(
      "SELECT a FROM t UNION SELECT b FROM u ORDER BY 1",
    );
    expect(
      replaceOrdinals("SELECT a FROM t GROUP BY 1 UNION DISTINCT SELECT b FROM u GROUP BY 1"),
    ).toBe("SELECT a FROM t GROUP BY a UNION DISTINCT SELECT b FROM u GROUP BY b");
  });

  it("keeps ORDER BY ordinals whose replacement names another output column", () => {
    expect(replaceOrdinals("SELECT a AS x, b AS x FROM t ORDER BY 1")).toBe(
      "SELECT a AS x, b AS x FROM t ORDER BY 1",
    );
    expect(replaceOrdinals("SELECT a AS b, b FROM t ORDER BY 1, 2")).toBe(
      "SELECT a AS b, b FROM t ORDER BY 1, 2",
    );
    expect(replaceOrdinals("SELECT x AS a, a + b FROM t ORDER BY 2")).toBe(
      "SELECT x AS a, a + b FROM t ORDER BY 2",
    );
  });

  it("never copies a volatile expression", () => {
    expect(replaceOrdinals("SELECT random() FROM t ORDER BY 1")).toBe(
      "SELECT random() FROM t ORDER BY 1",
    );
    expect(replaceOrdinals("SELECT nextval('s') FROM t GROUP BY 1")).toBe(
      "SELECT nextval('s') FROM t GROUP BY 1",
    );
  });
  it("copies string literals in an expression verbatim", () => {
    expect(replaceOrdinals("SELECT concat(a, '  x') FROM t GROUP BY 1")).toBe(
      "SELECT concat(a, '  x') FROM t GROUP BY concat(a, '  x')",
    );
    expect(replaceOrdinals("SELECT concat(a, 'x\n  y') FROM t GROUP BY 1")).toBe(
      "SELECT concat(a, 'x\n  y') FROM t GROUP BY 1",
    );
  });
  it("treats an aggregate call anywhere in the expression as an aggregate", () => {
    expect(replaceOrdinals("SELECT coalesce(sum(amount), 0) FROM t GROUP BY 1")).toBe(
      "SELECT coalesce(sum(amount), 0) FROM t GROUP BY 1",
    );
    expect(replaceOrdinals("SELECT pg_catalog.count(*) FROM t GROUP BY 1")).toBe(
      "SELECT pg_catalog.count(*) FROM t GROUP BY 1",
    );
  });

  it("keeps bracket groups opaque and verbatim", () => {
    expect(replaceOrdinals("SELECT [a  b] FROM t ORDER BY 1")).toBe(
      "SELECT [a  b] FROM t ORDER BY [a  b]",
    );
    expect(replaceOrdinals("SELECT ARRAY[1, 2], b FROM t ORDER BY 2")).toBe(
      "SELECT ARRAY[1, 2], b FROM t ORDER BY b",
    );
  });

  it("keeps ORDER BY ordinals after a parenthesized set operand", () => {
    expect(replaceOrdinals("SELECT a + 1 FROM t UNION (SELECT b FROM u) ORDER BY 1")).toBe(
      "SELECT a + 1 FROM t UNION (SELECT b FROM u) ORDER BY 1",
    );
  });
});
