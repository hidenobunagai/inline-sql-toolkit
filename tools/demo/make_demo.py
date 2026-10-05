"""Render the README demo (docs/demo.mp4 + docs/demo.gif).

    bun run build
    uv run --no-project --with pillow --with pygments python tools/demo/make_demo.py

Every formatted snippet and every terminal message comes from the real CLI
(dist/cli.js), so rerunning this keeps the demo honest — never hand-type SQL.
Frames are drawn with Pillow via tools/demo/demo_kit.py, piped to ffmpeg as
demo.mp4, then converted to a palette GIF (demo.gif, 800px wide, <= 5 MB).

Readability: every editor / palette / terminal scene gets ONE fixed fit()
camera, so code stays >= ~29px tall at 1600 (>= ~14px in the 800px GIF), and
crossfades stay camera-consistent: fade(camera(a, *cam_a), camera(b, *cam_b)).

Contact sheet / single frames for visual QA:

    uv run --no-project --with pillow python tools/demo/demo_kit.py sheet docs/demo.gif /tmp/sheet.png 16 4
    ffmpeg -ss 12 -i docs/demo.gif -frames:v 1 /tmp/f12.png
"""

import os
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

import demo_kit as k

ROOT = Path(os.environ.get("DEMO_REPO", Path(__file__).resolve().parents[2]))
OUT = Path(os.environ.get("DEMO_OUT", ROOT / "docs"))

BEFORE = '''def active_users(conn, account_id):
    query = f"""--sql
select u.id, u.name, count(o.id) as orders
from users u left join orders o on o.user_id = u.id
where u.account_id = {account_id} and u.active = true
group by 1, 2 order by 3 desc
"""
    return conn.execute(query)
'''

# SQL between the f-string quotes: start at the `--sql` marker, stop at the closing quotes.
EMBEDDED = (r'"""--sql', r'^\s*"""$', "sql")

CAP_BEFORE = "SQL inside an f-string, highlighted in place"
CAP_CURSOR = "Put the cursor in the query…"
CAP_PALETTE = "…and run Format at Cursor"
CAP_AFTER = "One undo step. Python stays Python."
CAP_FIELD = "f-string fields are kept verbatim"
CAP_ORD = "replaceOrdinals: true  ·  GROUP BY 1, 2  →  column names"
CAP_STYLED = "commaPosition: before  ·  keywordCase: lower"
CAP_CLI = "Same engine as a CLI — great for pre-commit & CI"


def run_cli(*args: str, stdin: str = BEFORE) -> str:
    """stdout of the real built CLI (dist/cli.js), fed the Python source on stdin."""
    return subprocess.run(
        ["bun", str(ROOT / "dist" / "cli.js"), *args],
        input=stdin, capture_output=True, text=True, check=True, cwd=ROOT,
    ).stdout


def src_lines(src: str) -> list[str]:
    return src.rstrip("\n").split("\n")


def py(lines: list[str]) -> list[list]:
    return k.highlight("\n".join(lines), "python", embedded=EMBEDDED)


def code_cam(rows: list[str], r0: int = 0, r1: int = None, pad: int = 10) -> tuple:
    """One fixed fit() camera per scene, framing rows r0..r1 of the code block."""
    r1 = len(rows) - 1 if r1 is None else r1
    x1 = k.code_xy(0, 0)[0] + max(len(r) for r in rows) * k.MONO.getlength("M")
    return k.fit(k.MARGIN, k.code_xy(0, r0)[1] - 14, x1, k.code_xy(0, r1)[1] + k.LH - 6, pad)


def card(title: str, sub: str, sub2: str) -> Image.Image:
    """Title/outro card — sub-lines at 44/46px so they stay readable in the GIF."""
    img = Image.new("RGB", (k.W, k.H), k.BG)
    d = ImageDraw.Draw(img)
    d.text((k.W / 2, k.H / 2 - 70), title, font=k.TITLE, fill=k.FG, anchor="mm")
    d.text((k.W / 2, k.H / 2 + 30), sub, font=k.font("ui", 44), fill=k.ACCENT, anchor="mm")
    d.text((k.W / 2, k.H / 2 + 120), sub2, font=k.font("ui", 46), fill=(178, 186, 204), anchor="mm")
    return img


def prompt(text: str) -> list:
    """A command line: dimmed '$ ' prompt + the command."""
    return [("$ ", k.DIM, False), (text, k.FG, False)]


def frames():
    # real CLI outputs (all "after" snippets below are these, never hand-typed)
    after_rows = src_lines(run_cli())
    styled_rows = src_lines(run_cli("--comma-position", "before", "--keyword-case", "lower"))
    ord_rows = src_lines(run_cli("--ordinals"))
    field_row = next(i for i, l in enumerate(after_rows) if "{account_id}" in l)
    group_row = next(i for i, l in enumerate(after_rows) if "GROUP BY" in l)
    order_row = next(i for i, l in enumerate(after_rows) if "ORDER BY" in l)

    # the ordinal scene shows --ordinals output: fail loudly if it ever lies again
    # (default output keeps the ordinals; the replacement must contain column names)
    ord_lines = [ord_rows[r] for r in (group_row + 1, group_row + 2, order_row + 1)]
    assert len(ord_rows) == len(after_rows), "--ordinals changed the output line count"
    assert not any(re.search(r"\b\d+\b", l) for l in ord_lines), \
        f"--ordinals output still has ordinals: {ord_lines!r}"
    assert "u.id" in ord_lines[0] and "u.name" in ord_lines[1] and "orders" in ord_lines[2], \
        f"--ordinals output lost the column names: {ord_lines!r}"

    before_rows = src_lines(BEFORE)
    before_cam = code_cam(before_rows)
    after_cam = code_cam(after_rows)
    styled_cam = code_cam(styled_rows)
    field_cam = code_cam(after_rows, field_row - 3, field_row + 3)
    group_cam = code_cam(after_rows, group_row - 2, order_row + 1)
    print(f"camera zooms: before {before_cam[2]:.2f} after {after_cam[2]:.2f}"
          f" field {field_cam[2]:.2f} group {group_cam[2]:.2f}"
          f" -> after code {24 * after_cam[2]:.1f}px @1600")

    # 1. title card
    intro = card("Inline SQL Toolkit",
                 "Format the SQL hiding in your Python strings",
                 "VS Code extension  ·  CLI  ·  offline, never executes SQL")
    yield from k.hold(intro, 2.0)

    # 2. the messy f-string, highlighted in place (fixed camera for the whole scene)
    before = k.editor(py(before_rows), title="users.py — Inline SQL Toolkit", tab="users.py")
    yield from k.fade(intro, k.camera(before, *before_cam), 0.5)
    yield from k.hold(before, 1.8, CAP_BEFORE, before_cam)

    # 3. pointer glides into the query, cursor lands there
    target = k.code_xy(20, 3)
    yield from k.glide(before, 0.9, (k.W - 300, k.H - 250), target, CAP_CURSOR, cam=before_cam)
    clicked = k.editor(py(before_rows), title="users.py — Inline SQL Toolkit",
                       tab="users.py", cursor=(20, 3))
    f = k.camera(k.pointer(clicked, *target), *before_cam)
    for _ in range(int(0.4 * k.FPS)):
        yield k.caption(f, CAP_CURSOR)

    # 4. command palette: dissolve into the palette's own camera, then type
    pal_cam = k.fit(k.W / 4, 130, k.W * 3 / 4, 292, pad=30)
    items = ["Inline SQL: Format at Cursor", "Inline SQL: Format All"]
    cmd = " Inline SQL: Format at Cursor"
    yield from k.fade(f, k.camera(k.palette(clicked, "", ()), *pal_cam), 0.4)
    yield from k.typing(lambda t: k.palette(clicked, t, items if len(t) > 8 else ()),
                        cmd, CAP_PALETTE, cps=40, cam=pal_cam)
    pal_final = k.palette(clicked, cmd, items)
    yield from k.hold(pal_final, 0.7, CAP_PALETTE, pal_cam)

    # 5. formatted in one step — one undo step for the whole block
    after = k.editor(py(after_rows), title="users.py — Inline SQL Toolkit", tab="users.py")
    yield from k.fade(k.camera(pal_final, *pal_cam), k.camera(after, *after_cam), 0.6)
    yield from k.hold(after, 1.8, CAP_AFTER, after_cam)

    # 6. the f-string replacement field survived verbatim
    hl_field = k.editor(py(after_rows), title="users.py — Inline SQL Toolkit",
                        tab="users.py", hl_rows={field_row})
    yield from k.pan(hl_field, 0.8, after_cam, field_cam, CAP_FIELD)
    yield from k.hold(hl_field, 1.6, CAP_FIELD, field_cam)

    # 7. settings scene: replaceOrdinals: true — real --ordinals output, crossfaded
    #    on one fixed camera so "1, 2" visibly becomes the column names
    hl_ordinals = {group_row, group_row + 1, group_row + 2, order_row, order_row + 1}
    hl_group = k.editor(py(after_rows), title="users.py — Inline SQL Toolkit",
                        tab="users.py", hl_rows=hl_ordinals)
    ord_group = k.editor(py(ord_rows), title="users.py — Inline SQL Toolkit",
                         tab="users.py", hl_rows=hl_ordinals)
    yield from k.pan(hl_group, 0.7, field_cam, group_cam, CAP_ORD)
    yield from k.fade(k.camera(hl_group, *group_cam), k.camera(ord_group, *group_cam), 0.4)
    yield from k.hold(ord_group, 1.6, CAP_ORD, group_cam)

    # 8. style options: commaPosition before, keywordCase lower
    yield from k.pan(ord_group, 0.6, group_cam, after_cam, CAP_ORD)
    styled = k.editor(py(styled_rows), title="users.py — Inline SQL Toolkit", tab="users.py")
    yield from k.fade(k.camera(ord_group, *after_cam), k.camera(styled, *styled_cam), 0.5)
    yield from k.hold(styled, 2.0, CAP_STYLED, styled_cam)

    # 9. CLI — real --check / --write / --check && echo ok runs in a temp dir
    #    (relative paths only, so nothing personal shows up on screen)
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "app").mkdir()
        (Path(td) / "app" / "users.py").write_text(BEFORE)

        def sh(cmdline: str) -> tuple[int, str]:
            p = subprocess.run(cmdline, shell=True, cwd=td, capture_output=True, text=True)
            return p.returncode, (p.stdout + p.stderr).strip()

        cli = f"bun {ROOT / 'dist' / 'cli.js'}"
        rc1, msg = sh(f"{cli} --check app/users.py")
        rc_w, _ = sh(f"{cli} --write app/users.py")
        rc2, ok_out = sh(f"{cli} --check app/users.py && echo ok")

    assert rc1 == 1 and "not formatted" in msg, f"unexpected --check output: {rc1} {msg!r}"
    assert rc_w == 0, f"--write failed: {rc_w}"
    assert rc2 == 0 and ok_out.strip() == "ok", f"unexpected final check: {rc2} {ok_out!r}"

    session: list = [
        ("cmd", "npx inline-sql-toolkit --check app/users.py", None),
        ("out", msg, k.RED),
        ("cmd", "npx inline-sql-toolkit --write app/users.py", None),
        ("cmd", "npx inline-sql-toolkit --check app/users.py && echo ok", None),
        ("out", "ok", k.GREEN),
    ]
    x0, y0 = k.MARGIN + 36, 150
    longest = max(len(s[1]) + (2 if s[0] == "cmd" else 0) for s in session)
    term_cam = k.fit(x0, y0, x0 + longest * k.MONO.getlength("M"),
                     y0 + len(session) * k.LH, pad=30)
    print(f"terminal camera zoom {term_cam[2]:.2f} -> {24 * term_cam[2]:.1f}px code @1600")

    shown: list = []
    yield from k.fade(k.camera(styled, *styled_cam), k.camera(k.terminal([]), *term_cam), 0.5)
    for kind, text, color in session:
        if kind == "cmd":
            yield from k.typing(lambda t: k.terminal(shown + [prompt(t + "▌")]), text,
                                CAP_CLI, cps=45, cam=term_cam)
            shown += [prompt(text)]
        else:
            shown += k.plain([text], color)
        yield from k.hold(k.terminal(shown), 0.5, CAP_CLI, term_cam)
    yield from k.hold(k.terminal(shown), 1.2, CAP_CLI, term_cam)

    # 10. outro
    outro = card("Inline SQL Toolkit",
                 "github.com/hidenobunagai/inline-sql-toolkit",
                 ".py  ·  marimo  ·  Jupyter cells")
    yield from k.fade(k.camera(k.terminal(shown), *term_cam), outro, 0.6)
    yield from k.hold(outro, 2.4)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    k.encode(frames(), OUT / "demo.mp4", OUT / "demo.gif")
