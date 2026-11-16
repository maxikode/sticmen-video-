# Stickman Video Renderer

A basic FastAPI service that generates a simple procedural 2D stickman superhero MP4 with Pillow and bundled FFmpeg.

## Render API
- GET /health
- POST /render with JSON body: {"prompt":"Stickman superhero saves city","duration":10}
- duration range: 5–30 seconds; response is an MP4 download.

## Deploy on Render
Create a Render Web Service from this repository, select Python runtime, build command `pip install -r requirements.txt`, start command `uvicorn main:app --host 0.0.0.0 --port $PORT`. Free instances can sleep and may have limits.

## Notes
This is procedural 2D animation, not cinematic AI video. The prompt is shown as a caption and does not dynamically create arbitrary story actions yet. ChatGPT plugin integration is a separate next phase.
