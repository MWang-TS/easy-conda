"""Generate Tauri icon set (pure stdlib, no external deps).

Design: a rounded-square tile with a green gradient and a white "stacked
layers" glyph (stacked diamonds) that reads as "environments" — the core
concept of a Conda environment manager.

Crispness notes:
- 4x supersampling anti-aliases the glyph edges.
- Small sizes (16/20/24/32/40) use a chunkier 2-layer glyph so they stay
  legible on the title bar / taskbar instead of turning into mush.
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "..", "src-tauri", "icons")

SS = 4  # supersampling factor per axis


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def encode_png(width: int, height: int, rgba: bytes) -> bytes:
    raw = b"".join(
        b"\x00" + rgba[y * width * 4 : (y + 1) * width * 4] for y in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(raw, 9))
        + png_chunk(b"IEND", b"")
    )


def round_rect_sdf(x: float, y: float, cx: float, cy: float, hw: float, hh: float, r: float) -> float:
    """Signed distance to a rounded rectangle (negative = inside)."""
    dx = abs(x - cx) - (hw - r)
    dy = abs(y - cy) - (hh - r)
    ax = max(dx, 0.0)
    ay = max(dy, 0.0)
    return (ax * ax + ay * ay) ** 0.5 + min(max(dx, dy), 0.0) - r


def diamond_inside(x: float, y: float, cx: float, cy: float, hw: float, hh: float) -> bool:
    """True if (x, y) is inside the axis-aligned diamond (rhombus)."""
    return abs(x - cx) / hw + abs(y - cy) / hh <= 1.0


def draw_icon(size: int) -> bytes:
    s = float(size)

    # Gradient stops (top -> bottom).
    bg_top = (48, 182, 125)
    bg_bottom = (13, 120, 84)
    white = (255, 255, 255)

    # Glyph: stacked diamonds in unit coords (cx, cy, hw, hh).
    if size >= 48:
        diamonds = [
            (0.50, 0.30, 0.17, 0.085),
            (0.50, 0.48, 0.25, 0.105),
            (0.50, 0.66, 0.33, 0.125),
        ]
    else:
        diamonds = [
            (0.50, 0.36, 0.22, 0.12),
            (0.50, 0.62, 0.34, 0.16),
        ]
    diamonds = [(cx * s, cy * s, hw * s, hh * s) for cx, cy, hw, hh in diamonds]

    radius = s * 0.22
    rgba = bytearray(size * size * 4)

    for py in range(size):
        for px in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    fx = px + (sx + 0.5) / SS
                    fy = py + (sy + 0.5) / SS
                    d = round_rect_sdf(fx, fy, s / 2, s / 2, s / 2, s / 2, radius)
                    a = max(0.0, min(1.0, 0.5 - d))
                    if a <= 0.0:
                        continue
                    if any(diamond_inside(fx, fy, cx, cy, hw, hh) for cx, cy, hw, hh in diamonds):
                        r, g, b = white
                    else:
                        t = fy / s
                        r = bg_top[0] + (bg_bottom[0] - bg_top[0]) * t
                        g = bg_top[1] + (bg_bottom[1] - bg_top[1]) * t
                        b = bg_top[2] + (bg_bottom[2] - bg_top[2]) * t
                    acc_r += r * a
                    acc_g += g * a
                    acc_b += b * a
                    acc_a += a
            n = SS * SS
            if acc_a > 0:
                i = (py * size + px) * 4
                rgba[i] = int(acc_r / acc_a + 0.5)
                rgba[i + 1] = int(acc_g / acc_a + 0.5)
                rgba[i + 2] = int(acc_b / acc_a + 0.5)
                rgba[i + 3] = int(acc_a / n * 255 + 0.5)
    return bytes(rgba)


def write_ico(path: str, pngs: dict) -> None:
    images = []
    for size, data in pngs.items():
        images.append((size, data))
    images.sort()
    header = struct.pack("<HHH", 0, 1, len(images))
    entries = b""
    offset = 6 + 16 * len(images)
    blobs = b""
    for size, data in images:
        # 256 (and 512) must use 0 in the width/height byte per ICO spec.
        dim = 0 if size >= 256 else size
        entries += struct.pack(
            "<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset
        )
        blobs += data
        offset += len(data)
    with open(path, "wb") as fh:
        fh.write(header + entries + blobs)


def write_icns(path: str, pngs: dict) -> None:
    """Write an Apple ICNS file embedding PNG data per size.

    ICNS uses `<type(4)> <length(4)> <data>` records. PNG-based types:
      ic07 128, ic08 256, ic09 512, ic10 1024 (512@2x),
      ic11 32 (16@2x), ic12 64 (32@2x), ic13 256 (128@2x), ic14 512 (256@2x),
      icp4 16, icp5 32, icp6 64.
    """
    type_map = {
        16: b"icp4",
        32: b"icp5",
        64: b"icp6",
        128: b"ic07",
        256: b"ic08",
        512: b"ic09",
        1024: b"ic10",
    }
    extra = {b"ic11": 32, b"ic12": 64, b"ic13": 256, b"ic14": 512}

    body = b""
    for size, png in sorted(pngs.items()):
        if size in type_map:
            body += type_map[size] + struct.pack(">I", len(png) + 8) + png
    for typ, size in extra.items():
        if size in pngs:
            png = pngs[size]
            body += typ + struct.pack(">I", len(png) + 8) + png

    total = len(body) + 8
    with open(path, "wb") as fh:
        fh.write(b"icns" + struct.pack(">I", total) + body)


def main() -> None:
    os.makedirs(ICONS, exist_ok=True)
    # Full set of standard Windows sizes avoids DPI scaling blur on the
    # title bar (16/20/24) and taskbar (32/40/48/64/96/128/256).
    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    pngs = {size: encode_png(size, size, draw_icon(size)) for size in ico_sizes}

    icon_512 = encode_png(512, 512, draw_icon(512))

    # individual PNG files
    write("icon.png", icon_512)
    write("32x32.png", pngs[32])
    write("128x128.png", pngs[128])
    write("128x128@2x.png", pngs[256])
    # ICO with all sizes (Windows)
    write_ico(os.path.join(ICONS, "icon.ico"), pngs)

    # ICNS with macOS sizes (16..1024)
    icns_pngs = dict(pngs)
    icns_pngs[512] = icon_512
    icns_pngs[1024] = encode_png(1024, 1024, draw_icon(1024))
    write_icns(os.path.join(ICONS, "icon.icns"), icns_pngs)

    print("generated icons in", ICONS)


def write(name: str, data: bytes) -> None:
    with open(os.path.join(ICONS, name), "wb") as fh:
        fh.write(data)


if __name__ == "__main__":
    main()
