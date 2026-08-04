import { describe, expect, it } from "vitest";

import { replaceOrdinals } from "../../src/python-analysis/ordinals.js";

describe("replaceOrdinals", () => {
  it("prefers the alias over the expression", () => {
    const sql = "SELECT user_id, date_trunc('month', paid_at) AS ym FROM payments GROUP BY 1, 2";
    expect(replaceOrdinals(sql)).toBe(
      "SELECT user_id, date_trunc('month', paid_at) AS ym FROM payments GROUP BY user_id, ym",
    );
  });

  it("uses implicit aliases after function calls", () => {
    expect(replaceOrdinals("SELECT SUM(amount) paid FROM t GROUP BY 1")).toBe(
      "SELECT SUM(amount) paid FROM t GROUP BY paid",
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
    const sql = "SELECT CASE WHEN x THEN y ELSE z END tier FROM t GROUP BY 1";
    expect(replaceOrdinals(sql)).toBe(
      "SELECT CASE WHEN x THEN y ELSE z END tier FROM t GROUP BY tier",
    );
  });

  it("flattens multi-line expressions", () => {
    const sql = "SELECT\n  date_trunc('month', paid_at) AS ym\nFROM t\nGROUP BY 1";
    expect(replaceOrdinals(sql)).toBe(
      "SELECT\n  date_trunc('month', paid_at) AS ym\nFROM t\nGROUP BY ym",
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

  it("skips the star column and replaces the following column", () => {
    expect(replaceOrdinals("SELECT *, a FROM t GROUP BY 1, 2")).toBe(
      "SELECT *, a FROM t GROUP BY 1, a",
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
    expect(replaceOrdinals('SELECT a AS "quoted alias", b FROM t GROUP BY 1, 2')).toBe(
      'SELECT a AS "quoted alias", b FROM t GROUP BY "quoted alias", b',
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
});
