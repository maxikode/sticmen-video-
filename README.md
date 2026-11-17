# Stickman Video Director — ChatGPT integration

This repository hosts a small MCP bridge to the **original** open-source Stickman Video Director Autopilot. It does not replace the upstream renderer with a homemade video generator.

- Upstream: https://github.com/kaomei/stickman-video-director
- Pinned upstream commit: `d58cf5b1d83996bc961694f046335454de599770`
- Upstream license: MIT; the Docker image includes the original `LICENSE`.

## How it works

1. Render builds the pinned upstream Skill runtime and its original scripts/assets.
2. The MCP bridge exposes the original workflow, documentation, project initialization, file management, validation, preview, review and rendering stages to ChatGPT.
3. ChatGPT acts as the director/author: it researches when needed, writes the script and scene plan, prepares project manifests and assets, and calls the original runtime for validation and rendering.
4. The original production gates remain in place. A preview is not approval; a full render requires the user's explicit authorization and the original style-specific review/approval artifacts.

The original Autopilot is **not a text-to-video model by itself**. It renders project files prepared by the agent. Narration and illustrations must be supplied, generated with a currently available ChatGPT tool, or generated through a configured provider. The optional original Gemini adapter needs `GEMINI_API_KEY` and may incur provider charges; it is never called without explicit authorization.

## ChatGPT plugin connection

The private `stickman-video-studio` plugin connects to:

`https://sticmen-video.onrender.com/mcp/<private-path-token>`

The path token must be stored only as the `MCP_PATH_TOKEN` secret in Render Environment settings and in the private plugin's `mcp.json`; it must never be committed to this repository. The token previously present in `render.yaml` has been rotated. Set the new value in Render and keep the plugin private. If you rotate it again, update Render and the plugin endpoint together.

## MCP tools

- `autopilot_doctor` — inspect installed runtime dependencies.
- `autopilot_workflow` and `autopilot_read_reference` — read original style workflow and source references.
- `autopilot_init` — create an isolated project with the original initializer.
- `autopilot_write_file`, `autopilot_read_file`, `autopilot_list_files`, `autopilot_project_status` — manage project files and inspect results.
- `autopilot_run_stage` — run original B1–B4/B6 validation, preview, approval, rendering and review stages.
- `autopilot_run_b5` — use the dedicated original B5 Character Explainer route.
- `autopilot_generate_media` — optional single-request original Gemini image/speech adapter; requires a configured key and explicit authorization.
- `autopilot_job_status` and `autopilot_download_link` — track asynchronous work and retrieve output files.

The bridge does not expose arbitrary shell execution. Executable project code is guarded by an explicit trusted-code flag. B5 and B6 have their own code-authored workflows and are not silently treated as B1–B4 projects.

## Deployment

Render uses the Dockerfile and installs Node 22, FFmpeg/FFprobe, Python dependencies and the pinned upstream runtime. The health endpoint is:

`https://sticmen-video.onrender.com/health`

The `/mcp/<private-path-token>` endpoint is intended for the private ChatGPT plugin only.

## Render Free limitations

Free web services sleep after 15 minutes without inbound traffic and use ephemeral storage. Project files and generated videos can be lost after a restart, sleep or redeploy. Free instances also have only 512 MB RAM. This is suitable for a small proof-of-concept, not reliable long-form production. A paid instance with persistent storage is recommended for multi-stage projects; set `PROJECTS_DIR` to the persistent disk mount, for example `/var/data/stickman-projects`.

The original Skill's assets are large. The Docker build uses sparse checkout to omit unrelated repository demos and docs while retaining the original Autopilot scripts and assets. Render time and memory still depend on style, duration, resolution and scene complexity.

## Privacy and cost

Project files are stored on the Render service filesystem and are not written back to GitHub. The service is private by an unguessable MCP path, but any person who obtains that path can call the bridge. Download links are signed and expire after 30 minutes. Do not upload private material unless you are comfortable processing it on the hosting service.

The upstream project is open source; image/TTS providers and hosting are separate services with their own terms and possible costs. No paid generation call is made automatically.
