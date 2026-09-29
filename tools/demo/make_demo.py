"""Render the README demo (docs/demo.gif) from real CLI output.

    bun run build
    uv run --with pillow --with pygments python tools/demo/make_demo.py

Frames are drawn with Pillow, piped to ffmpeg as raw RGB (demo.mp4), then
converted to a palette GIF. Every "after" snippet comes from dist/cli.js.
"""

import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pygments.lexers import PythonLexer, SqlLexer
from pygments.token import Comment, Keyword, Name, Number, Operator, String, Token

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "docs"
W, H, FPS = 1600, 1000, 30

MONO = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 24)
MONO_B = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 24, index=1)
UI = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 22)
CAP = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 34)
TITLE = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 88)
SUB = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 36)
CW = MONO.getlength("M")
LH = 36

BG = (20, 22, 30)
EDITOR = (30, 33, 43)
CHROME = (24, 26, 35)
FG = (220, 223, 228)
DIM = (110, 118, 135)
ACCENT = (97, 175, 239)
COLORS = [
    (Comment, (106, 153, 85)),
    (String, (152, 195, 121)),
    (Keyword, (198, 120, 221)),
    (Name.Builtin, (97, 175, 239)),
    (Name.Function, (97, 175, 239)),
    (Number, (209, 154, 102)),
    (Operator, (86, 182, 194)),
]
FIELD = (229, 192, 123)  # f-string replacement fields

BEFORE = '''def active_users(conn, account_id):
    query = f"""--sql
select u.id, u.name, count(o.id) as orders
from users u left join orders o on o.user_id = u.id
where u.account_id = {account_id} and u.active = true
group by 1, 2 order by 3 desc
"""
    return conn.execute(query)
'''


def cli(*args: str) -> str:
    return subprocess.run(
        ["bun", str(ROOT / "dist/cli.js"), *args],
        input=BEFORE, capture_output=True, text=True, check=True,
    ).stdout


def color_of(tok):
    for t, c in COLORS:
        if tok in t:
            return c
    return FG


def highlight(src: str) -> list[list[tuple[str, tuple]]]:
    """Per-line (text, color) runs; SQL between the f-string quotes uses SqlLexer."""
    out, in_sql = [], False
    for line in src.rstrip("\n").split("\n"):
        if in_sql and line.strip() == '"""':
            in_sql = False
        if in_sql:
            runs = []
            for part in re.split(r"(\{[^}]*\})", line):
                if part.startswith("{"):
                    runs.append((part, FIELD))
                elif part:
                    runs += [(v.rstrip("\n"), color_of(t)) for t, v in SqlLexer().get_tokens(part) if v.strip("\n")]
        else:
            runs = [(v.rstrip("\n"), color_of(t)) for t, v in PythonLexer().get_tokens(line) if v.strip("\n")]
        if line.rstrip().endswith('"""--sql'):
            in_sql = True
        out.append(runs)
    return out


def ease(t: float) -> float:
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


# ---------------------------------------------------------------- drawing

EX, EY = 110, 70  # editor window origin
GUTTER = 70


def code_xy(col: float, row: float) -> tuple[float, float]:
    return EX + GUTTER + 20 + col * CW, EY + 100 + row * LH


def window(d: ImageDraw.ImageDraw, title: str, h: int = 790):
    d.rounded_rectangle((EX, EY, W - EX, EY + h), 16, fill=EDITOR)
    d.rounded_rectangle((EX, EY, W - EX, EY + 44), 16, fill=CHROME)
    d.rectangle((EX, EY + 28, W - EX, EY + 44), fill=CHROME)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse((EX + 20 + i * 26, EY + 15, EX + 34 + i * 26, EY + 29), fill=c)
    d.text((W / 2, EY + 22), title, font=UI, fill=DIM, anchor="mm")


def editor(src: str, cursor=None, hl_rows=None) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    window(d, "users.py — Inline SQL Toolkit")
    d.rectangle((EX, EY + 44, EX + 260, EY + 88), fill=EDITOR)
    d.text((EX + 24, EY + 66), "users.py", font=UI, fill=FG, anchor="lm")
    d.line((EX, EY + 88, W - EX, EY + 88), fill=CHROME, width=2)
    for r, runs in enumerate(highlight(src)):
        x, y = code_xy(0, r)
        if hl_rows and r in hl_rows:
            d.rectangle((EX + 2, y - 6, W - EX - 2, y + LH - 6), fill=(40, 46, 62))
        d.text((EX + GUTTER, y), str(r + 1), font=MONO, fill=DIM, anchor="ra")
        for text, c in runs:
            d.text((x, y), text, font=MONO_B if c == COLORS[2][1] else MONO, fill=c)
            x += MONO.getlength(text)
    if cursor:
        x, y = code_xy(*cursor)
        d.rectangle((x, y - 2, x + 3, y + LH - 8), fill=FG)
    return img


def palette(img: Image.Image, typed: str, show_item: bool):
    d = ImageDraw.Draw(img, "RGBA")
    d.rectangle((0, 0, W, H), fill=(0, 0, 0, 90))
    x0, x1, y0 = 400, 1200, EY + 60
    d.rounded_rectangle((x0, y0, x1, y0 + (170 if show_item else 70)), 12, fill=(37, 41, 54), outline=(60, 66, 84), width=2)
    d.rounded_rectangle((x0 + 12, y0 + 12, x1 - 12, y0 + 58), 8, fill=(26, 29, 38), outline=ACCENT, width=2)
    d.text((x0 + 28, y0 + 35), ">" + typed, font=UI, fill=FG, anchor="lm")
    if show_item:
        for i, (label, key) in enumerate([("Inline SQL: Format at Cursor", ""), ("Inline SQL: Format All", "")]):
            y = y0 + 72 + i * 46
            if i == 0:
                d.rounded_rectangle((x0 + 8, y, x1 - 8, y + 42), 6, fill=(4, 57, 94))
            d.text((x0 + 28, y + 21), label, font=UI, fill=FG, anchor="lm")


def terminal(lines: list[tuple[str, tuple]]) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    window(d, "zsh — inline-sql-toolkit")
    for r, (text, c) in enumerate(lines):
        d.text((EX + 36, EY + 80 + r * LH), text, font=MONO, fill=c)
    return img


def pointer(img: Image.Image, x: float, y: float):
    d = ImageDraw.Draw(img)
    pts = [(0, 0), (0, 34), (9, 26), (16, 41), (22, 38), (15, 24), (27, 24)]
    d.polygon([(x + a, y + b) for a, b in pts], fill=(255, 255, 255), outline=(0, 0, 0), width=2)


def caption(img: Image.Image, text: str, alpha: float = 1.0):
    if not text or alpha <= 0:
        return
    layer = Image.new("RGBA", img.size)
    d = ImageDraw.Draw(layer)
    w = CAP.getlength(text) + 64
    d.rounded_rectangle(((W - w) / 2, H - 110, (W + w) / 2, H - 42), 34, fill=(0, 0, 0, int(200 * alpha)))
    d.text((W / 2, H - 76), text, font=CAP, fill=(255, 255, 255, int(255 * alpha)), anchor="mm")
    img.paste(Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB"))


def camera(img: Image.Image, cx: float, cy: float, zoom: float) -> Image.Image:
    if zoom <= 1.001:
        return img
    w, h = W / zoom, H / zoom
    x0 = min(max(cx - w / 2, 0), W - w)
    y0 = min(max(cy - h / 2, 0), H - h)
    return img.resize((W, H), Image.LANCZOS, box=(x0, y0, x0 + w, y0 + h))


# ---------------------------------------------------------------- scenes

def title_card(title: str, sub: str, sub2: str = "") -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((W / 2, H / 2 - 60), title, font=TITLE, fill=FG, anchor="mm")
    d.text((W / 2, H / 2 + 40), sub, font=SUB, fill=ACCENT, anchor="mm")
    if sub2:
        d.text((W / 2, H / 2 + 100), sub2, font=UI, fill=DIM, anchor="mm")
    return img


def fade(a: Image.Image, b: Image.Image, secs: float):
    n = int(secs * FPS)
    for i in range(n):
        yield Image.blend(a, b, ease((i + 1) / n))


def hold(img: Image.Image, secs: float, cap: str = "", cam=(W / 2, H / 2, 1.0)):
    n = int(secs * FPS)
    for i in range(n):
        f = camera(img, *cam)
        caption(f, cap, min(1.0, (i + 1) / 8))
        yield f


def pan(img: Image.Image, secs: float, a, b, cap: str = ""):
    n = int(secs * FPS)
    for i in range(n):
        f = camera(img, *lerp(a, b, ease((i + 1) / n)))
        caption(f, cap)
        yield f


def frames():
    after = cli()
    styled = cli("--comma-position", "before", "--keyword-case", "lower")
    after_rows = after.split("\n")
    field_row = next(i for i, l in enumerate(after_rows) if "{account_id}" in l)
    group_row = next(i for i, l in enumerate(after_rows) if "GROUP BY" in l)

    intro = title_card("Inline SQL Toolkit", "Format the SQL hiding in your Python strings", "VS Code extension  ·  CLI  ·  offline, never executes SQL")
    yield from hold(intro, 2.2)

    before_img = editor(BEFORE)
    yield from fade(intro, before_img, 0.5)
    yield from hold(before_img, 2.0, "SQL inside an f-string, highlighted in place")

    # pointer glides into the SQL, then the command palette opens
    start, end = (W - 300, H - 250), code_xy(20, 3)
    for i in range(int(0.9 * FPS)):
        f = editor(BEFORE)
        pointer(f, *lerp(start, end, ease((i + 1) / (0.9 * FPS))))
        caption(f, "Put the cursor in the query…")
        yield f
    clicked = editor(BEFORE, cursor=(20, 3))
    for _ in range(int(0.4 * FPS)):
        f = clicked.copy()
        pointer(f, *end)
        caption(f, "Put the cursor in the query…")
        yield f
    cmd = " Inline SQL: Format at Cursor"
    for i in range(len(cmd) + 1):
        f = clicked.copy()
        palette(f, cmd[: i], i > 8)
        caption(f, "…and run Format at Cursor")
        for _ in range(2):
            yield f
    f = clicked.copy()
    palette(f, cmd, True)
    caption(f, "…and run Format at Cursor")
    yield from [f] * int(0.6 * FPS)

    after_img = editor(after)
    yield from fade(f, after_img, 0.6)
    yield from hold(after_img, 1.8, "One undo step. Python stays Python.")

    fx, fy = code_xy(10, field_row)
    focus_field = (fx + 150, fy + 90, 1.6)
    yield from pan(editor(after, hl_rows={field_row}), 0.8, (W / 2, H / 2, 1.0), focus_field)
    yield from hold(editor(after, hl_rows={field_row}), 1.8, "f-string fields are kept verbatim", focus_field)
    gx, gy = code_xy(10, group_row + 1)
    focus_group = (gx + 150, gy + 90, 1.6)
    yield from pan(editor(after, hl_rows={group_row + 1, group_row + 2}), 0.7, focus_field, focus_group)
    yield from hold(editor(after, hl_rows={group_row + 1, group_row + 2}), 1.8, "GROUP BY 1, 2  →  real column names", focus_group)
    yield from pan(after_img, 0.7, focus_group, (W / 2, H / 2, 1.0))

    styled_img = editor(styled)
    yield from fade(after_img, styled_img, 0.6)
    yield from hold(styled_img, 2.4, "commaPosition: before  ·  keywordCase: lower")

    green, red = (152, 195, 121), (224, 108, 117)
    session = [
        ("$ npx inline-sql-toolkit --check app/users.py", FG),
        ("inline-sql-toolkit: app/users.py is not formatted", red),
        ("$ npx inline-sql-toolkit --write app/users.py", FG),
        ("$ npx inline-sql-toolkit --check app/users.py && echo ok", FG),
        ("ok", green),
    ]
    shown: list = []
    yield from fade(styled_img, terminal([]), 0.5)
    for text, c in session:
        if text.startswith("$"):
            for i in range(2, len(text) + 1, 2):
                f = terminal(shown + [(text[:i] + "▌", c)])
                caption(f, "Same engine as a CLI — great for pre-commit & CI")
                yield f
        shown.append((text, c))
        yield from hold(terminal(shown), 0.6, "Same engine as a CLI — great for pre-commit & CI")
    yield from hold(terminal(shown), 1.2, "Same engine as a CLI — great for pre-commit & CI")

    outro = title_card("Inline SQL Toolkit", "github.com/hidenobunagai/inline-sql-toolkit", ".py  ·  marimo  ·  Jupyter cells")
    yield from fade(terminal(shown), outro, 0.6)
    yield from hold(outro, 2.4)


def main():
    OUT_DIR.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        mp4 = Path(tmp) / "demo.mp4"
        ff = subprocess.Popen(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
             "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
             "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(mp4)],
            stdin=subprocess.PIPE,
        )
        for f in frames():
            ff.stdin.write(f.tobytes())
        ff.stdin.close()
        assert ff.wait() == 0
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-vf",
             "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
             str(OUT_DIR / "demo.gif")],
            check=True,
        )
    print("wrote", OUT_DIR / "demo.gif")


if __name__ == "__main__":
    main()
