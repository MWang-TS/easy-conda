"""Generate Tauri icon set without external dependencies (pure stdlib).

Produces the icons expected by tauri-build / tauri build under icons/.
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "..", "src-tauri", "icons")


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


def rounded_rect(x: float, y: float, cx: float, cy: float, half: float, radius: float) -> float:
    dx = abs(x - cx) - (half - radius)
    dy = abs(y - cy) - (half - radius)
    ax = max(dx, 0.0)
    ay = max(dy, 0.0)
    return (ax * ax + ay * ay) ** 0.5 + min(max(dx, dy), 0.0) - radius


def draw_icon(size: int) -> bytes:
    rgba = bytearray(size * size * 4)
    s = float(size)
    # supersample factor for smoother edges
    ss = 2
    bg_top = (33, 138, 107)
    bg_bottom = (18, 103, 79)
    layer = (255, 255, 255)
    for py in range(size):
        for px in range(size):
            # supersample 2x2
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    fx = (px + (sx + 0.5) / ss)
                    fy = (py + (sy + 0.5) / ss)
                    # background rounded square
                    d = rounded_rect(fx, fy, s / 2, s / 2, s / 2, s * 0.22)
                    a = max(0.0, min(1.0, 0.5 - d))
                    if a <= 0:
                        continue
                    t = fy / s
                    r = bg_top[0] + (bg_bottom[0] - bg_top[0]) * t
                    g = bg_top[1] + (bg_bottom[1] - bg_top[1]) * t
                    b = bg_top[2] + (bg_bottom[2] - bg_top[2]) * t
                    # foreground stacked layers
                    for (lcx, lcy, lhalf, lr) in (
                        (s * 0.36, s * 0.60, s * 0.19, s * 0.07),
                        (s * 0.62, s * 0.40, s * 0.19, s * 0.07),
                    ):
                        ld = rounded_rect(fx, fy, lcx, lcy, lhalf, lr)
                        la = max(0.0, min(1.0, 0.5 - ld))
                        if la > 0:
                            r = r * (1 - la) + layer[0] * la
                            g = g * (1 - la) + layer[1] * la
                            b = b * (1 - la) + layer[2] * la
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = ss * ss
            if acc[3] > 0:
                i = (py * size + px) * 4
                rgba[i] = int(acc[0] / acc[3] + 0.5)
                rgba[i + 1] = int(acc[1] / acc[3] + 0.5)
                rgba[i + 2] = int(acc[2] / acc[3] + 0.5)
                rgba[i + 3] = int(acc[3] / n * 255 + 0.5)
    return bytes(rgba)


def write_ico(path: str, pngs: dict) -> None:
    images = []
    for size, data in pngs.items():
        dim = 0 if size >= 256 else size
        images.append((size, data))
    images.sort()
    header = struct.pack("<HHH", 0, 1, len(images))
    entries = b""
    offset = 6 + 16 * len(images)
    blobs = b""
    for size, data in images:
        entries += struct.pack(
            "<BBBBHHII", size & 0xFF, size & 0xFF, 0, 0, 1, 32, len(data), offset
        )
        blobs += data
        offset += len(data)
    with open(path, "wb") as fh:
        fh.write(header + entries + blobs)


def main() -> None:
    os.makedirs(ICONS, exist_ok=True)
    sizes = [16, 32, 48, 64, 128, 256, 512]
    pngs = {}
    for size in sizes:
        data = encode_png(size, size, draw_icon(size))
        pngs[size] = data
    # individual PNG files
    write("icon.png", pngs[512])
    write("32x32.png", pngs[32])
    write("128x128.png", pngs[128])
    write("128x128@2x.png", pngs[256])
    # ICO with all sizes
    write_ico(os.path.join(ICONS, "icon.ico"), pngs)
    print("generated icons in", ICONS)


def write(name: str, data: bytes) -> None:
    with open(os.path.join(ICONS, name), "wb") as fh:
        fh.write(data)


if __name__ == "__main__":
    main()
