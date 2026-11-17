# Stickman Video Director — ChatGPT bridge

This repository runs the **original** open-source Stickman Video Director Autopilot runtime from upstream commit `d58cf5b1d83996bc961694f046335454de599770`, with a small authenticated MCP bridge so ChatGPT can use the project's real CLI.

Upstream project: https://github.com/kaomei/stickman-video-director  
License: MIT. The upstream license is included in the Docker image at `/opt/stickman-video-director/LICENSE`.

## What this changes

- The old procedural Pillow renderer is no longer the active service.
- Render builds a pinned copy of the original Skill runtime and its original scripts/assets.
- The service exposes original Autopilot workflow, doctor, initialization, validation, preview, approval, rendering, B5 route, optional Gemini media adapter, project files and download links as MCP tools.
- No original renderer is reimplemented or silently replaced.

## ChatGPT connection

The MCP endpoint is private and uses a secret path token. In Render, add:

- `MCP_PATH_TOKEN`: a long random token (keep it private; do not commit it).
- `PUBLIC_BASE_URL`: the public Render service URL.
- `GEMINI_API_KEY`: optional. Only needed if you choose the original optional Gemini image/speech adapter.

The private ChatGPT plugin package should point to:

```
https://sticmen-video.onrender.com/mcp/<MCP_PATH_TOKEN>
```

Do not share the plugin or token publicly. The plugin is a tool bridge; ChatGPT still directs the story, prepares project files and follows the original sample-review/approval gates.

## Main MCP tools

- `autopilot_doctor`, `autopilot_workflow`, `autopilot_init`
- `autopilot_write_file`, `autopilot_read_file`, `autopilot_list_files`, `autopilot_project_status`
- `autopilot_run_stage` for validate, preview, approve, render and review stages
- `autopilot_run_b5` for the dedicated B5 route
- `autopilot_generate_media` for the optional one-request Gemini adapter
- `autopilot_job_status`, `autopilot_download_link`

The API never runs arbitrary shell commands. Executable project files and B5/B6 code require an explicit trusted-code flag. Preview and full rendering are separate stages; approval is not inferred from a successful render.

## Deployment

The repository uses the Dockerfile. Render installs Node 20, FFmpeg/FFprobe and the original runtime dependencies, then starts `server.mjs`.

After deploying, check:

- `/health` — bridge/runtime status
- `/mcp/<MCP_PATH_TOKEN>` — private MCP endpoint (ChatGPT plugin connection)

## Important Render Free limitations

Free web services spin down after 15 minutes without inbound traffic, and their local filesystem is ephemeral: project files and generated videos can disappear after spin-down, restart or redeploy. Free instances also have only 512 MB RAM. This is suitable for a limited test, not a reliable multi-stage production workflow. For dependable preview → review → approval → full render, use a paid service with a persistent disk mounted at `/var/data`, then set `PROJECTS_DIR=/var/data/stickman-projects`.

The full upstream Skill assets are large. The build uses sparse checkout to exclude unrelated repository demos/docs, but retains the original Autopilot Skill assets and scripts. Rendering can still exceed free-instance memory/time limits depending on style, duration and resolution.

## Generation and cost

The original project is a production workflow, not a text-to-video model by itself. ChatGPT authors the script/scene direction and prepares the manifest; the original runtime validates and renders it. Narration and illustrations must come from files you provide, a configured generation tool, or a selected provider. The optional bundled Gemini adapter requires a configured API key and may incur provider charges. No API call is made automatically without explicit authorization.
