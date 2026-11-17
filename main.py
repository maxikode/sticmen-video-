import math
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from PIL import Image, ImageDraw
import imageio_ffmpeg

app = FastAPI(title="Stickman Video Renderer", version="0.2.0")

# A balanced setting for Render's free instance. Can be raised later after
# measuring render time and memory on the deployed service.
W, H, FPS = 720, 1280, 24
DURATION_LIMIT = 30


class RenderRequest(BaseModel):
    prompt: str = Field(default="Стикмен гуляет по городу", max_length=400)
    duration: int = Field(default=10, ge=5, le=DURATION_LIMIT)


def lerp(a, b, t):
    return a + (b - a) * t


def draw_cloud(draw, x, y, scale=1.0):
    col = "#f7fbff"
    draw.ellipse((x, y + 15*scale, x + 95*scale, y + 65*scale), fill=col)
    draw.ellipse((x + 25*scale, y, x + 78*scale, y + 58*scale), fill=col)
    draw.ellipse((x + 58*scale, y + 12*scale, x + 125*scale, y + 65*scale), fill=col)


def draw_building(draw, x, ground, width, height, index):
    palette = ["#a8bacb", "#c4b6a5", "#899eae", "#b9c8c9", "#9eacc0"]
    wall = palette[index % len(palette)]
    top = ground - height
    draw.rectangle((x, top, x + width, ground), fill=wall)
    draw.rectangle((x, top, x + width, top + 13), fill="#718494")
    # Rows of windows, with small variations so the skyline feels less tiled.
    cols = max(2, width // 43)
    rows = max(2, height // 58)
    for row in range(rows):
        for col in range(cols):
            wx = x + 12 + col * ((width - 28) / cols)
            wy = top + 27 + row * ((height - 40) / rows)
            ww = min(22, max(12, width / cols - 12))
            wh = 27
            color = "#f8e6a8" if (row * 3 + col + index) % 4 else "#d7e8f4"
            draw.rectangle((wx, wy, wx + ww, wy + wh), fill=color)
            draw.line((wx, wy + wh, wx + ww, wy + wh), fill="#718494", width=2)


def draw_tree(draw, x, ground, scale=1.0):
    draw.rectangle((x - 7*scale, ground - 82*scale, x + 7*scale, ground), fill="#76513b")
    draw.ellipse((x - 38*scale, ground - 145*scale, x + 38*scale, ground - 65*scale), fill="#4f9565")
    draw.ellipse((x - 22*scale, ground - 165*scale, x + 42*scale, ground - 92*scale), fill="#63a976")


def draw_car(draw, x, y, scale=1.0, color="#e36c54"):
    draw.rounded_rectangle((x, y, x + 170*scale, y + 58*scale), radius=16*scale, fill=color)
    draw.polygon([(x + 32*scale, y), (x + 58*scale, y - 35*scale),
                  (x + 120*scale, y - 35*scale), (x + 145*scale, y)], fill=color)
    draw.polygon([(x + 65*scale, y - 28*scale), (x + 78*scale, y - 28*scale),
                  (x + 78*scale, y - 5*scale), (x + 48*scale, y - 5*scale)], fill="#cde5f2")
    draw.polygon([(x + 85*scale, y - 28*scale), (x + 116*scale, y - 28*scale),
                  (x + 135*scale, y - 5*scale), (x + 85*scale, y - 5*scale)], fill="#cde5f2")
    for wx in (x + 38*scale, x + 132*scale):
        draw.ellipse((wx - 17*scale, y + 42*scale, wx + 17*scale, y + 76*scale), fill="#263440")
        draw.ellipse((wx - 7*scale, y + 52*scale, wx + 7*scale, y + 66*scale), fill="#c7d0d6")


def draw_stickman(draw, cx, ground_y, phase, scale=1.0):
    # Smooth, readable walk cycle: head, torso, arms and legs share one phase.
    ink = "#202832"
    line = max(5, int(9 * scale))
    bob = math.sin(phase * 2) * 5 * scale
    hip_y = ground_y - 112*scale + bob
    shoulder_y = ground_y - 218*scale + bob
    head_r = 31*scale
    head_y = ground_y - 270*scale + bob

    # Soft contact shadow.
    draw.ellipse((cx - 49*scale, ground_y - 8*scale, cx + 49*scale, ground_y + 8*scale),
                 fill="#aab5bd")

    # Head and simple face.
    draw.ellipse((cx - head_r, head_y - head_r, cx + head_r, head_y + head_r),
                 fill="#fffdf7", outline=ink, width=line)
    draw.ellipse((cx - 10*scale, head_y - 5*scale, cx - 4*scale, head_y + 1*scale), fill=ink)
    draw.ellipse((cx + 5*scale, head_y - 5*scale, cx + 11*scale, head_y + 1*scale), fill=ink)
    draw.arc((cx - 10*scale, head_y + 2*scale, cx + 12*scale, head_y + 18*scale),
             start=5, end=170, fill=ink, width=max(2, line//2))

    draw.line((cx, shoulder_y, cx, hip_y), fill=ink, width=line)
    swing = math.sin(phase) * 37*scale
    lift = abs(math.cos(phase)) * 12*scale
    # Arms swing opposite to the legs.
    draw.line((cx, shoulder_y + 12*scale,
               cx - 43*scale - swing, shoulder_y + 65*scale + swing*0.22),
              fill=ink, width=line)
    draw.line((cx, shoulder_y + 12*scale,
               cx + 43*scale + swing, shoulder_y + 65*scale - swing*0.22),
              fill=ink, width=line)
    leg_swing = math.sin(phase)
    draw.line((cx, hip_y, cx - leg_swing*43*scale, ground_y - lift),
              fill=ink, width=line)
    draw.line((cx, hip_y, cx + leg_swing*43*scale, ground_y - (12*scale-lift)),
              fill=ink, width=line)
    # Shoes.
    draw.line((cx - leg_swing*43*scale, ground_y - lift,
               cx - leg_swing*43*scale + 25*scale, ground_y - lift),
              fill="#35495b", width=max(7, line+2))
    draw.line((cx + leg_swing*43*scale, ground_y - (12*scale-lift),
               cx + leg_swing*43*scale + 25*scale, ground_y - (12*scale-lift)),
              fill="#35495b", width=max(7, line+2))


def make_frame(t, duration, prompt):
    im = Image.new("RGB", (W, H), "#a9d9f5")
    d = ImageDraw.Draw(im)

    # Sky, sun and distant skyline.
    d.rectangle((0, 0, W, H), fill="#a9d9f5")
    d.ellipse((555, 85, 650, 180), fill="#ffe59a")
    draw_cloud(d, int(65 - (t*9) % 180), 145, 0.85)
    draw_cloud(d, int(420 - (t*5) % 140), 250, 0.62)

    horizon = 765
    # Distant buildings move more slowly to create parallax.
    for i in range(12):
        bw = 90 + (i * 19) % 55
        bh = 240 + (i * 47) % 260
        x = int((i * 105 - (t * 17) % 105) - 20)
        draw_building(d, x, horizon, bw, bh, i)

    # Road and sidewalk.
    d.rectangle((0, horizon, W, 1005), fill="#697782")
    d.line((0, 895, W, 895), fill="#f4e8a8", width=6)
    for i in range(7):
        x = int((i * 145 - (t * 125) % 145))
        d.rectangle((x, 940, x + 76, 948), fill="#e8edf0")
    d.rectangle((0, 1005, W, H), fill="#d8c9b5")
    d.rectangle((0, 1005, W, 1020), fill="#b7a58e")
    # Pavement seams scroll past the camera.
    for i in range(8):
        x = int((i * 125 - (t * 78) % 125))
        d.line((x, 1020, x - 28, H), fill="#c0b09b", width=3)

    # Street furniture and trees in a repeating moving layer.
    for i in range(5):
        x = int((i * 210 - (t * 78) % 210) + 30)
        draw_tree(d, x, 1005, 0.78)
        d.line((x + 75, 1005, x + 75, 720), fill="#566875", width=7)
        d.ellipse((x + 48, 710, x + 102, 742), fill="#fff1b2")

    # Cars travel along the road.
    car_x = int((W + 180 - (t * 145) % (W + 360)))
    draw_car(d, car_x, 835, 0.78, "#d96b59")
    car2_x = int(((t * 105) % (W + 360)) - 180)
    draw_car(d, car2_x, 925, 0.58, "#4d91bd")

    # Main character stays near centre while the city scrolls around them.
    draw_stickman(d, 345, 1160, t * 5.4, 1.08)

    # Small restrained caption; the prompt is retained for compatibility.
    d.rounded_rectangle((24, 28, W - 24, 92), radius=18, fill="#ffffff")
    caption = "CITY WALK • 2D STICKMAN"
    d.text((43, 49), caption, fill="#263746")
    return im


@app.get("/")
def root():
    return {"service": "stickman-video-renderer", "docs": "/docs", "health": "/health"}


@app.get("/health")
def health():
    return {"status": "ok", "renderer": "stickman-2d-v2", "resolution": f"{W}x{H}",
            "fps": FPS, "max_duration_seconds": DURATION_LIMIT}


@app.post("/render")
def render(req: RenderRequest):
    out = Path(tempfile.mkdtemp()) / "stickman_video.mp4"
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ffmpeg, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-an", "-c:v", "libx264", "-preset", "ultrafast",
        "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(out)
    ]
    process = None
    try:
        process = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for n in range(req.duration * FPS):
            process.stdin.write(make_frame(n / FPS, req.duration, req.prompt).tobytes())
        process.stdin.close()
        error = process.stderr.read().decode("utf-8", "replace")
        code = process.wait(timeout=180)
        if code != 0 or not out.exists() or out.stat().st_size < 1000:
            raise HTTPException(status_code=500, detail="FFmpeg render failed: " + error[-900:])
    except HTTPException:
        raise
    except Exception as exc:
        if process:
            try:
                process.kill()
            except Exception:
                pass
        raise HTTPException(status_code=500, detail="Render failed: " + str(exc))
    return FileResponse(out, media_type="video/mp4", filename="stickman_city_walk.mp4")
