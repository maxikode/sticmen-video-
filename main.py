import math, tempfile, subprocess
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from PIL import Image, ImageDraw
import imageio_ffmpeg

app=FastAPI(title="Stickman Video Renderer",version="0.1.0")
W,H,FPS=540,960,12

class RenderRequest(BaseModel):
    prompt:str=Field(default="Stickman superhero saves the city",max_length=400)
    duration:int=Field(default=10,ge=5,le=30)

def stickman(d,x,y,hero=False,pose=0):
    ink="#1558d6" if hero else "#111111"; w=7
    d.ellipse((x-19,y-19,x+19,y+19),outline=ink,width=w)
    d.line((x,y+19,x,y+90),fill=ink,width=w)
    # arms move with animation phase
    d.line((x,y+40,x-42,y+65+int(12*math.sin(pose))),fill=ink,width=w)
    d.line((x,y+40,x+45,y+25-int(14*math.sin(pose))),fill=ink,width=w)
    d.line((x,y+90,x-28,y+145),fill=ink,width=w)
    d.line((x,y+90,x+30,y+145),fill=ink,width=w)
    if hero:
        d.polygon([(x-7,y+25),(x-42,y+112),(x+38,y+105)],fill="#e53935")
        d.ellipse((x-10,y+42,x+10,y+62),fill="#ffd700")

def frame(t,duration,prompt):
    im=Image.new("RGB",(W,H),"#aee1ff"); d=ImageDraw.Draw(im)
    d.ellipse((420,55,485,120),fill="#ffe36e")
    ground=720
    d.rectangle((0,ground,W,H),fill="#dbe6ef")
    for i in range(8):
        bx=i*72-8; bh=180+(i*61)%270
        d.rectangle((bx,ground-bh,bx+58,ground),fill="#91a8bd",outline="#536b82",width=2)
        for wx in range(bx+8,bx+48,16):
            for wy in range(ground-bh+15,ground-10,26):
                d.rectangle((wx,wy,wx+6,wy+9),fill="#fff0a6")
    phase=t/max(duration,1); y=390
    if phase<.78:
        rx,ry=380,390
        d.rectangle((rx-45,ry-60,rx+45,ry+35),fill="#69747e",outline="#303840",width=5)
        d.ellipse((rx-34,ry-100,rx+34,ry-32),fill="#69747e",outline="#303840",width=5)
        d.ellipse((rx-20,ry-75,rx-5,ry-60),fill="#ff3333")
        d.ellipse((rx+5,ry-75,rx+20,ry-60),fill="#ff3333")
        d.line((rx-25,ry+35,rx-40,ry+100),fill="#303840",width=10)
        d.line((rx+25,ry+35,rx+40,ry+100),fill="#303840",width=10)
    if phase<.22:
        stickman(d,155,y,False,t); label="A ROBOT THREATENS THE CITY!"
    elif phase<.45:
        stickman(d,155,y,True,t); d.ellipse((90,250,220,560),outline="#ffd700",width=7); label="A HERO AWAKENS!"
    elif phase<.78:
        stickman(d,int(170+100*(phase-.45)/.33),y,True,t)
        for k in range(4):
            a=t*3+k*math.pi/2
            d.line((230,y+60,230+int(100*math.cos(a)),y+60+int(100*math.sin(a))),fill="#ffd700",width=5)
        label="THE SUPERHERO FIGHTS BACK!"
    else:
        stickman(d,270,y,True,t); label="THE CITY IS SAFE!"
        d.text((90,800),"STICKMAN: CITY SAVIOR",fill="#1558d6")
    d.text((22,175),label,fill="#17202a")
    d.text((15,H-30),prompt[:60],fill="#334155")
    return im

@app.get("/health")
def health():
    return {"status":"ok","renderer":"stickman-2d","max_duration_seconds":30}

@app.post("/render")
def render(req:RenderRequest):
    out=Path(tempfile.mkdtemp())/"stickman_video.mp4"
    ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    cmd=[ffmpeg,"-y","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}","-r",str(FPS),"-i","-","-an","-c:v","libx264","-preset","ultrafast","-crf","26","-pix_fmt","yuv420p","-movflags","+faststart",str(out)]
    try:
        p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        for n in range(req.duration*FPS):
            p.stdin.write(frame(n/FPS,req.duration,req.prompt).tobytes())
        p.stdin.close(); err=p.stderr.read().decode("utf-8","replace"); code=p.wait(timeout=150)
        if code or not out.exists() or out.stat().st_size<1000:
            raise HTTPException(500,"FFmpeg render failed: "+err[-900:])
    except HTTPException: raise
    except Exception as e:
        try:p.kill()
        except Exception:pass
        raise HTTPException(500,"Render failed: "+str(e))
    return FileResponse(out,media_type="video/mp4",filename="stickman_video.mp4")
