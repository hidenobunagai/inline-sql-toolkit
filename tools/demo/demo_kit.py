"""demo_kit — draw, compose and encode README demo videos with Pillow + ffmpeg.

Copy this file next to the project's scene script (e.g. tools/demo/demo_kit.py)
so the demo stays reproducible without the skill installed.

    uv run --no-project --with pillow --with pygments python tools/demo/make_demo.py
    uv run --no-project --with pillow python demo_kit.py sheet docs/demo.gif sheet.png

Canvas size / fps are module globals (W, H, FPS); override them before drawing.
Every scene helper is a generator of full-size RGB frames, so a scene script is
just `yield from` calls fed into encode().
"""

import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1600, 1000, 30
LH = 36  # code line height

# ---------------------------------------------------------------- fonts

_FONT_CANDIDATES = {
    "mono": ["/System/Library/Fonts/Menlo.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"],
    "mono_bold": [("/System/Library/Fonts/Menlo.ttc", 1), "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"],
    # CJK-capable first so Japanese captions render
    "ui": [
        "/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/SFNS.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ],
    "ui_bold": [
        "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ],
}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    for c in _FONT_CANDIDATES[kind]:
        path, index = c if isinstance(c, tuple) else (c, 0)
        if Path(path).exists():
            return ImageFont.truetype(path, size, index=index)
    return ImageFont.load_default(size)


MONO, MONO_B = font("mono", 24), font("mono_bold", 24)
UI, CAP = font("ui", 22), font("ui", 34)
TITLE, SUB = font("ui_bold", 84), font("ui", 36)

# ---------------------------------------------------------------- theme

BG = (20, 22, 30)
PANEL = (30, 33, 43)
CHROME = (24, 26, 35)
FG = (220, 223, 228)
DIM = (110, 118, 135)
ACCENT = (97, 175, 239)
GREEN, RED, YELLOW = (152, 195, 121), (224, 108, 117), (229, 192, 123)
HL_ROW = (40, 46, 62)

ANSI = {30: (40, 44, 52), 31: RED, 32: GREEN, 33: YELLOW, 34: ACCENT, 35: (198, 120, 221), 36: (86, 182, 194), 37: FG}
ANSI.update({k + 60: v for k, v in ANSI.items()})  # bright variants: same palette


def _token_colors():
    from pygments.token import Comment, Keyword, Name, Number, Operator, String

    return [
        (Comment, (106, 153, 85)), (String, GREEN), (Keyword, (198, 120, 221)),
        (Name.Builtin, ACCENT), (Name.Function, ACCENT), (Name.Class, YELLOW),
        (Number, (209, 154, 102)), (Operator, (86, 182, 194)),
    ]


def ease(t: float) -> float:
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b))


# ---------------------------------------------------------------- text runs

Run = tuple[str, tuple, bool]  # text, color, bold


def highlight(src: str, lexer: str = "python", embedded=None, placeholders=None) -> list[list[Run]]:
    r"""Per-line colored runs via pygments.

    embedded=(start_re, end_re, lexer_name) switches lexer for the lines strictly
    between a line matching start_re and the next line matching end_re — e.g.
    SQL inside a Python triple-quoted string.
    placeholders: regex painted YELLOW and kept out of the lexer (template vars).
    Defaults to `{...}` for embedded lines only; pass e.g.
    r"\$\{[^}]*\}|%\(\w+\)s|\{\{.*?\}\}" to paint them in a whole SQL file.
    """
    from pygments.lexers import get_lexer_by_name

    colors = _token_colors()
    kw = colors[2][1]

    def runs(text, lx):
        out = []
        for tok, v in get_lexer_by_name(lx).get_tokens(text):
            v = v.rstrip("\n")
            if v:
                c = next((c for t, c in colors if tok in t), FG)
                out.append((v, c, c == kw))
        return out

    def split(text, lx, pattern):
        if not pattern:
            return runs(text, lx)
        row = []
        for i, part in enumerate(re.split(f"({pattern})", text)):
            if i % 2:
                row.append((part, YELLOW, False))
            elif part:
                row += runs(part, lx)
        return row

    ph = f"(?:{placeholders})" if placeholders else None
    lines, inside = [], False
    for line in src.rstrip("\n").split("\n"):
        if inside and embedded and re.search(embedded[1], line):
            inside = False
        if inside:
            row = split(line, embedded[2], ph or r"\{[^}]*\}")
        else:
            row = split(line, lexer, ph)
        if embedded and not inside and re.search(embedded[0], line):
            inside = True
        lines.append(row)
    return lines


def ansi_runs(line: str) -> list[Run]:
    """Parse one line of SGR-colored text (e.g. `tmux capture-pane -e -p`)."""
    out, color, bold = [], FG, False
    for part in re.split(r"(\x1b\[[0-9;]*m)", line):
        if part.startswith("\x1b["):
            codes = [int(c) for c in part[2:-1].split(";") if c] or [0]
            i = 0
            while i < len(codes):
                c = codes[i]
                if c == 0:
                    color, bold = FG, False
                elif c == 1:
                    bold = True
                elif c == 22:
                    bold = False
                elif c == 39:
                    color = FG
                elif c in ANSI:
                    color = ANSI[c]
                elif c in (38, 48) and i + 2 < len(codes) and codes[i + 1] == 5:
                    if c == 38:
                        color = _xterm256(codes[i + 2])
                    i += 2
                elif c in (38, 48) and i + 4 < len(codes) and codes[i + 1] == 2:
                    if c == 38:
                        color = tuple(codes[i + 2 : i + 5])
                    i += 4
                i += 1
        elif part:
            out.append((re.sub(r"\x1b\[[^m]*[A-Za-z]", "", part), color, bold))
    return out


def _xterm256(n: int) -> tuple:
    if n < 16:
        return ANSI[30 + n % 8]
    if n >= 232:
        g = 8 + (n - 232) * 10
        return (g, g, g)
    n -= 16
    return tuple(0 if v == 0 else 55 + v * 40 for v in (n // 36, n // 6 % 6, n % 6))


def plain(lines: list[str], color=FG) -> list[list[Run]]:
    return [[(l, color, False)] for l in lines]


# ---------------------------------------------------------------- drawing

MARGIN = 110  # window inset from canvas edge
WIN_H = 790   # leaves room for the caption band at the bottom


def window(title: str, h: int = None) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    """Blank canvas with a macOS-style window; returns (img, draw)."""
    h = h or WIN_H
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    x0, y0, x1 = MARGIN, 70, W - MARGIN
    d.rounded_rectangle((x0, y0, x1, y0 + h), 16, fill=PANEL)
    d.rounded_rectangle((x0, y0, x1, y0 + 44), 16, fill=CHROME)
    d.rectangle((x0, y0 + 28, x1, y0 + 44), fill=CHROME)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse((x0 + 20 + i * 26, y0 + 15, x0 + 34 + i * 26, y0 + 29), fill=c)
    d.text((W / 2, y0 + 22), title, font=UI, fill=DIM, anchor="mm")
    return img, d


GUTTER = 70


def code_xy(col: float, row: float) -> tuple[float, float]:
    """Canvas position of a code cell in editor() — use for pointer/camera targets."""
    return MARGIN + GUTTER + 20 + col * MONO.getlength("M"), 70 + 100 + row * LH


def _draw_runs(d, x, y, row):
    for text, c, bold in row:
        d.text((x, y), text, font=MONO_B if bold else MONO, fill=c)
        x += MONO.getlength(text)


def editor(lines: list[list[Run]], title: str = "", tab: str = "", cursor=None, hl_rows=()) -> Image.Image:
    img, d = window(title)
    if tab:
        d.rectangle((MARGIN, 114, MARGIN + max(200, UI.getlength(tab) + 48), 158), fill=PANEL)
        d.text((MARGIN + 24, 136), tab, font=UI, fill=FG, anchor="lm")
    d.line((MARGIN, 158, W - MARGIN, 158), fill=CHROME, width=2)
    for r, row in enumerate(lines):
        x, y = code_xy(0, r)
        if r in hl_rows:
            d.rectangle((MARGIN + 2, y - 6, W - MARGIN - 2, y + LH - 6), fill=HL_ROW)
        d.text((MARGIN + GUTTER, y), str(r + 1), font=MONO, fill=DIM, anchor="ra")
        _draw_runs(d, x, y, row)
    if cursor:
        x, y = code_xy(*cursor)
        d.rectangle((x, y - 2, x + 3, y + LH - 8), fill=FG)
    return img


def terminal(lines: list[list[Run]], title: str = "zsh") -> Image.Image:
    img, d = window(title)
    for r, row in enumerate(lines):
        _draw_runs(d, MARGIN + 36, 150 + r * LH, row)
    return img


def screenshot(path, url: str = "") -> Image.Image:
    """Fit a real screenshot (web capture) inside a browser-style window."""
    img, d = window("")
    if url:
        d.rounded_rectangle((W / 2 - 360, 78, W / 2 + 360, 106), 8, fill=PANEL)
        d.text((W / 2, 92), url, font=UI, fill=DIM, anchor="mm")
    shot = Image.open(path).convert("RGB")
    box_w, box_h = W - 2 * MARGIN, WIN_H - 44
    shot.thumbnail((box_w, box_h), Image.LANCZOS)
    img.paste(shot, (int((W - shot.width) / 2), 70 + 44))
    return img


def shot_xy(path, x: float, y: float) -> tuple[float, float]:
    """Map a page coordinate in a screenshot to canvas coordinates in screenshot()."""
    sw, sh = Image.open(path).size
    s = min((W - 2 * MARGIN) / sw, (WIN_H - 44) / sh, 1.0)
    return (W - sw * s) / 2 + x * s, 70 + 44 + y * s


def title_card(title: str, sub: str = "", sub2: str = "") -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((W / 2, H / 2 - 60), title, font=TITLE, fill=FG, anchor="mm")
    if sub:
        d.text((W / 2, H / 2 + 40), sub, font=SUB, fill=ACCENT, anchor="mm")
    if sub2:
        d.text((W / 2, H / 2 + 100), sub2, font=UI, fill=DIM, anchor="mm")
    return img


def palette(img: Image.Image, typed: str, items: list[str] = ()) -> Image.Image:
    """VS Code-like command palette overlay (first item selected)."""
    img = img.copy()
    d = ImageDraw.Draw(img, "RGBA")
    d.rectangle((0, 0, W, H), fill=(0, 0, 0, 90))
    x0, x1, y0 = W / 4, W * 3 / 4, 130
    d.rounded_rectangle((x0, y0, x1, y0 + 70 + 46 * len(items)), 12, fill=(37, 41, 54), outline=(60, 66, 84), width=2)
    d.rounded_rectangle((x0 + 12, y0 + 12, x1 - 12, y0 + 58), 8, fill=(26, 29, 38), outline=ACCENT, width=2)
    d.text((x0 + 28, y0 + 35), ">" + typed, font=UI, fill=FG, anchor="lm")
    for i, label in enumerate(items):
        y = y0 + 66 + i * 46
        if i == 0:
            d.rounded_rectangle((x0 + 8, y, x1 - 8, y + 42), 6, fill=(4, 57, 94))
        d.text((x0 + 28, y + 21), label, font=UI, fill=FG, anchor="lm")
    return img


def pointer(img: Image.Image, x: float, y: float) -> Image.Image:
    img = img.copy()
    pts = [(0, 0), (0, 34), (9, 26), (16, 41), (22, 38), (15, 24), (27, 24)]
    ImageDraw.Draw(img).polygon([(x + a, y + b) for a, b in pts], fill=(255, 255, 255), outline=(0, 0, 0), width=2)
    return img


def tap(img: Image.Image, x: float, y: float, t: float) -> Image.Image:
    """Pointer plus an expanding click ring; t in [0, 1] is the ring's progress."""
    img = img.copy()
    d = ImageDraw.Draw(img, "RGBA")
    r = 10 + 34 * ease(t)
    d.ellipse((x - r, y - r, x + r, y + r), outline=(97, 175, 239, int(255 * (1 - t))), width=5)
    return pointer(img, x, y)


def caption(img: Image.Image, text: str, alpha: float = 1.0) -> Image.Image:
    """Pill caption in the bottom band (below WIN_H, so it never covers content at zoom 1)."""
    if not text or alpha <= 0:
        return img
    layer = Image.new("RGBA", img.size)
    d = ImageDraw.Draw(layer)
    w = CAP.getlength(text) + 64
    d.rounded_rectangle(((W - w) / 2, H - 110, (W + w) / 2, H - 42), 34, fill=(0, 0, 0, int(200 * alpha)))
    d.text((W / 2, H - 76), text, font=CAP, fill=(255, 255, 255, int(255 * alpha)), anchor="mm")
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def camera(img: Image.Image, cx: float, cy: float, zoom: float) -> Image.Image:
    """Crop around (cx, cy) and scale back up. Keep zoom <= ~1.8 so the GIF stays sharp.

    Scenes whose content fills only part of the window (short terminal output,
    centered web apps) read poorly at 800px GIF width — give the whole scene a
    constant cam, e.g. fit(box) below, instead of leaving it at WIDE.
    """
    if zoom <= 1.001:
        return img
    w, h = W / zoom, H / zoom
    x0 = min(max(cx - w / 2, 0), W - w)
    y0 = min(max(cy - h / 2, 0), H - h)
    return img.resize((W, H), Image.LANCZOS, box=(x0, y0, x0 + w, y0 + h))


WIDE = (W / 2, H / 2, 1.0)


def fit(x0, y0, x1, y1, pad=40, max_zoom=1.8):
    """Camera that frames the canvas box (x0, y0)-(x1, y1), keeping the caption band clear."""
    zoom = min(W / (x1 - x0 + 2 * pad), (H - 130) / (y1 - y0 + 2 * pad), max_zoom)
    zoom = max(zoom, 1.0)
    # shift down so the box sits above the bottom caption band after cropping
    return ((x0 + x1) / 2, (y0 + y1) / 2 + 65 / zoom, zoom)

# ---------------------------------------------------------------- scene helpers (generators)


def hold(img, secs, cap="", cam=None):
    """Still frame, optional caption (fades in) and fixed camera."""
    n = int(secs * FPS)
    for i in range(n):
        yield caption(camera(img, *(cam or WIDE)), cap, min(1.0, (i + 1) / 8))


def fade(a, b, secs=0.5):
    n = int(secs * FPS)
    for i in range(n):
        yield Image.blend(a, b, ease((i + 1) / n))


def pan(img, secs, a, b, cap=""):
    """Camera move from a to b, each (cx, cy, zoom)."""
    n = int(secs * FPS)
    for i in range(n):
        yield caption(camera(img, *lerp(a, b, ease((i + 1) / n))), cap)


def glide(img, secs, start, end, cap="", cam=None):
    """Pointer moves start -> end (canvas coords) over a still image."""
    n = int(secs * FPS)
    for i in range(n):
        yield caption(camera(pointer(img, *lerp(start, end, ease((i + 1) / n))), *(cam or WIDE)), cap)


def click(img, secs, pos, cap="", cam=None):
    """Click ring at pos, then hold the pointer there."""
    n = int(secs * FPS)
    for i in range(n):
        yield caption(camera(tap(img, *pos, min(1.0, (i + 1) / 9)), *(cam or WIDE)), cap)


def typing(render, text, cap="", cps=15, prefix_len=0, cam=None):
    """render(partial_text) -> frame; types text at cps characters/second."""
    per = max(1, round(FPS / cps))
    for i in range(prefix_len, len(text) + 1):
        f = caption(camera(render(text[:i]), *(cam or WIDE)), cap)
        for _ in range(per):
            yield f


# ---------------------------------------------------------------- encode / verify


def encode(frames, mp4, gif=None, gif_width=800, gif_fps=12, colors=128):
    """Pipe frames to ffmpeg (H.264 mp4), then derive a palette GIF from the mp4."""
    mp4 = Path(mp4)
    mp4.parent.mkdir(parents=True, exist_ok=True)
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)],
        stdin=subprocess.PIPE,
    )
    n = 0
    for f in frames:
        ff.stdin.write(f.tobytes())
        n += 1
    ff.stdin.close()
    if ff.wait() != 0:
        raise RuntimeError("ffmpeg mp4 encode failed")
    print(f"{mp4}: {n} frames, {n / FPS:.1f}s, {mp4.stat().st_size / 1e6:.1f}MB")
    if gif:
        gif = Path(gif)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-vf",
             f"fps={gif_fps},scale={gif_width}:-1:flags=lanczos,split[a][b];"
             f"[a]palettegen=max_colors={colors}[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
             str(gif)],
            check=True,
        )
        print(f"{gif}: {gif.stat().st_size / 1e6:.1f}MB")


def sheet(video, out, n=12, cols=3):
    """Contact sheet of n evenly spaced frames — look at it before shipping."""
    dur = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True,
    ).stdout.strip())
    rows = -(-n // cols)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-vf",
         f"fps={n / dur:.4f},scale=800:-1,tile={cols}x{rows}", "-frames:v", "1", str(out)],
        check=True,
    )
    print(out)


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "sheet":
        sheet(sys.argv[2], sys.argv[3], *(int(a) for a in sys.argv[4:6]))  # [n] [cols]
    else:
        print(__doc__)
