import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {spawn, spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {z} from "zod";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.AUTOPILOT_ROOT || "/opt/stickman-video-director/skills/directing-stickman-videos";
const CLI = path.join(ROOT, "scripts/autopilot.mjs");
const B5_CLI = path.join(ROOT, "scripts/character-explainer.mjs");
const MEDIA_CLI = path.join(ROOT, "scripts/gemini-media.mjs");
const PROJECTS = path.resolve(process.env.PROJECTS_DIR || "/tmp/stickman-projects");
const TOKEN = process.env.MCP_PATH_TOKEN || "";
const BASE_URL = (process.env.PUBLIC_BASE_URL || "https://sticmen-video.onrender.com").replace(/\/+$/, "");
const UPSTREAM_COMMIT = "d58cf5b1d83996bc961694f046335454de599770";
const PORT = Number(process.env.PORT || 10000);
const STYLES = ["B1", "B2", "B3", "B4", "B5", "B6"];
const activeJobs = new Map();

await fsp.mkdir(PROJECTS, {recursive: true});

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {"content-type": "application/json; charset=utf-8", "content-length": body.length});
  res.end(body);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function textResult(value) {
  return {content: [{type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2)}]};
}
function errorResult(error) {
  return {isError: true, content: [{type: "text", text: error?.message || String(error)}]};
}
async function tool(fn) {
  try { return textResult(await fn()); } catch (error) { return errorResult(error); }
}
function parseOutput(stdout, stderr, status) {
  const s = (stdout || "").trim();
  let parsed;
  try { parsed = JSON.parse(s); } catch {}
  return {exit_code: status, result: parsed ?? s, stderr: (stderr || "").trim().slice(-5000)};
}
function runSync(script, args, timeout = 120000) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT, encoding: "utf8", timeout, maxBuffer: 12 * 1024 * 1024,
    env: {...process.env, NO_COLOR: "1"}
  });
  if (result.error) throw new Error(result.error.message);
  const output = parseOutput(result.stdout, result.stderr, result.status);
  if (result.status !== 0) throw new Error(JSON.stringify(output));
  return output.result;
}
function validId(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Invalid project ID");
  }
  return id;
}
function projectDir(id) {
  const dir = path.resolve(PROJECTS, validId(id));
  if (!dir.startsWith(PROJECTS + path.sep)) throw new Error("Project path escaped storage root");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error("Project not found");
  return dir;
}

function b5OutputDir(id) {
  const dir = path.resolve(PROJECTS, ".b5-output", validId(id));
  const root = path.resolve(PROJECTS, ".b5-output");
  if (!dir.startsWith(root + path.sep)) throw new Error("B5 output path escaped storage root");
  fs.mkdirSync(dir, {recursive: true});
  return dir;
}
function safeOutputFile(id, relative, mustExist = false) {
  const base = b5OutputDir(id);
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\0")) {
    throw new Error("Use an output-relative file path");
  }
  const normalized = relative.replace(/\\/g, "/");
  if (normalized.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid relative output path");
  const target = path.resolve(base, normalized);
  if (!target.startsWith(base + path.sep)) throw new Error("Output path escaped its storage root");
  if (mustExist) {
    const real = fs.realpathSync(target);
    if (!real.startsWith(fs.realpathSync(base) + path.sep)) throw new Error("Output symlink escaped its storage root");
    if (!fs.statSync(real).isFile()) throw new Error("Not a regular output file");
    return real;
  }
  let parent = path.dirname(target);
  while (parent.startsWith(base) && !fs.existsSync(parent)) parent = path.dirname(parent);
  if (!parent.startsWith(base) || !fs.realpathSync(parent).startsWith(fs.realpathSync(base))) {
    throw new Error("Output parent directory escaped its storage root");
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Refusing to follow an output symbolic link.");
  return target;
}

function safeFile(id, relative, mustExist = false) {
  const base = projectDir(id);
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\0")) {
    throw new Error("Use a project-relative file path");
  }
  const normalized = relative.replace(/\\/g, "/");
  if (normalized.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid relative path");
  const target = path.resolve(base, normalized);
  if (!target.startsWith(base + path.sep)) throw new Error("File path escaped project");
  if (mustExist) {
    const real = fs.realpathSync(target);
    if (!real.startsWith(fs.realpathSync(base) + path.sep)) throw new Error("File symlink escaped project");
    if (!fs.statSync(real).isFile()) throw new Error("Not a regular file");
    return real;
  }
  let parent = path.dirname(target);
  while (parent.startsWith(base) && !fs.existsSync(parent)) parent = path.dirname(parent);
  if (!parent.startsWith(base) || !fs.realpathSync(parent).startsWith(fs.realpathSync(base))) {
    throw new Error("Parent directory escaped project");
  }
  return target;
}
function readProject(id) {
  const file = safeFile(id, "project.json", true);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function jobDir(id) {
  const d = path.join(projectDir(id), ".chatgpt", "jobs");
  fs.mkdirSync(d, {recursive: true});
  return d;
}
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temp, file);
}
function startJob(projectId, label, script, args) {
  projectDir(projectId);
  if (activeJobs.size > 0) throw new Error("Only one rendering/generation task may run at a time on this instance.");
  for (const [id, child] of activeJobs) {
    if (child.projectId === projectId) throw new Error("A task is already running for this project: " + id);
  }
  const id = crypto.randomUUID();
  const folder = jobDir(projectId);
  const statusFile = path.join(folder, id + ".json");
  const logFile = path.join(folder, id + ".log");
  const fd = fs.openSync(logFile, "a");
  const meta = {job_id: id, project_id: projectId, stage: label, status: "running",
    started_at: new Date().toISOString(), pid: null, exit_code: null, log_file: logFile};
  writeJsonAtomic(statusFile, meta);
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT, env: {...process.env, NO_COLOR: "1"},
    stdio: ["ignore", fd, fd]
  });
  fs.closeSync(fd);
  meta.pid = child.pid || null;
  writeJsonAtomic(statusFile, meta);
  activeJobs.set(id, {projectId, child, statusFile, logFile});
  child.on("error", error => {
    meta.status = "failed"; meta.error = error.message; meta.finished_at = new Date().toISOString();
    writeJsonAtomic(statusFile, meta); activeJobs.delete(id);
  });
  child.on("close", code => {
    meta.status = code === 0 ? "completed" : "failed";
    meta.exit_code = code; meta.finished_at = new Date().toISOString();
    writeJsonAtomic(statusFile, meta); activeJobs.delete(id);
  });
  return {job_id: id, project_id: projectId, stage: label, status: "running",
    message: "Task started. Poll autopilot_job_status until it completes."};
}
function signedUrl(projectId, relative, area = "project") {
  const expires = Date.now() + 30 * 60 * 1000;
  const payload = area + "\n" + projectId + "\n" + relative + "\n" + expires;
  const sig = crypto.createHmac("sha256", TOKEN).update(payload).digest("hex");
  return BASE_URL + "/download/" + projectId + "?area=" + area + "&file=" + encodeURIComponent(relative) +
    "&expires=" + expires + "&sig=" + sig;
}
function verifyDownload(projectId, relative, area, expires, sig) {
  if (!TOKEN || !["project", "b5_output"].includes(area) ||
      !/^\d+$/.test(String(expires)) || Number(expires) < Date.now() ||
      Number(expires) > Date.now() + 31 * 60 * 1000) return false;
  const expected = crypto.createHmac("sha256", TOKEN)
    .update(area + "\n" + projectId + "\n" + relative + "\n" + expires).digest("hex");
  return safeEqual(expected, sig);
}
function collectFiles(base, relative = "", out = []) {
  if (out.length >= 250) return out;
  for (const entry of fs.readdirSync(path.join(base, relative), {withFileTypes: true})) {
    if (entry.name === ".chatgpt" || entry.name === "node_modules") continue;
    const rel = path.posix.join(relative.replace(/\\/g, "/"), entry.name);
    const full = path.join(base, rel);
    if (entry.isDirectory()) collectFiles(base, rel, out);
    else if (entry.isFile()) out.push({path: rel, bytes: fs.statSync(full).size});
    if (out.length >= 250) break;
  }
  return out;
}
function addProjectTool(server) {
  server.tool("autopilot_read_reference",
    "Read an exact original upstream Skill instruction or reference document. Only SKILL.md and references/*.md are exposed.",
    {relative_path: z.string().max(240)},
    async ({relative_path}) => tool(() => {
      const rel = relative_path.replace(/\\\\/g, "/");
      if (!(rel === "SKILL.md" || rel.startsWith("references/")) ||
          rel.split("/").some(part => !part || part === "." || part === "..") ||
          !rel.endsWith(".md")) throw new Error("Only SKILL.md or a references/*.md document can be read.");
      const file = path.resolve(ROOT, rel);
      if (!file.startsWith(path.resolve(ROOT) + path.sep) && rel !== "SKILL.md") throw new Error("Reference path escaped upstream root.");
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 600000) throw new Error("Reference is missing or too large.");
      return {source: "kaomei/stickman-video-director@" + UPSTREAM_COMMIT, path: rel, content: fs.readFileSync(file, "utf8")};
    })
  );
  server.tool("autopilot_doctor",
    "Check the original Stickman Video Director Autopilot runtime installed on the server. Does not generate media.",
    {style: z.enum(STYLES).optional()},
    async ({style}) => tool(() => runSync(CLI, ["doctor", ...(style ? ["--style", style] : [])]))
  );
  server.tool("autopilot_workflow",
    "Read the original installed production workflow for a selected Autopilot style and aspect ratio.",
    {style: z.enum(STYLES), ratio: z.enum(["16:9", "9:16"]).default("16:9")},
    async ({style, ratio}) => tool(() => runSync(CLI, ["workflow", "--style", style, "--ratio", ratio]))
  );
  server.tool("autopilot_init",
    "Create a new isolated project using the original Autopilot initializer. B5 has its own route; B1-B4 and B6 use their original initializers.",
    {style: z.enum(STYLES), ratio: z.enum(["16:9", "9:16", "both"]).optional()},
    async ({style, ratio}) => tool(() => {
      const id = crypto.randomUUID();
      const dir = path.join(PROJECTS, id);
      const args = ["init", dir, "--style", style];
      if (style === "B6" && !ratio) throw new Error("B6 initialization requires a native ratio: 16:9, 9:16 or both.");
      if (style !== "B6" && ratio === "both") throw new Error("The both-ratios option is supported only by B6.");
      if (ratio && style !== "B5") args.push("--ratio", ratio);
      if (style === "B5" && ratio) throw new Error("B5 uses its dedicated native scene route and does not accept --ratio during init.");
      const result = runSync(CLI, args);
      return {project_id: id, style, directory: "created", initializer: result,
        note: "Project files are private to this server. Use autopilot_write_file to add the approved script, media and manifest."};
    })
  );
  server.tool("autopilot_write_file",
    "Write a text or base64-encoded media asset into a project. Executable source files require explicit trusted_code_authorized=true and are run only through the original allowlisted Autopilot stages.",
    {project_id: z.string(), relative_path: z.string(), content: z.string().max(22000000),
      encoding: z.enum(["utf8", "base64"]).default("utf8"),
      overwrite: z.boolean().default(false),
      trusted_code_authorized: z.boolean().default(false)},
    async (input) => tool(async () => {
      const {project_id, relative_path, content, encoding, overwrite, trusted_code_authorized} = input;
      const ext = path.extname(relative_path).toLowerCase();
      const allowed = [".json", ".txt", ".md", ".wav", ".mp3", ".ogg", ".flac", ".png", ".jpg", ".jpeg",
        ".webp", ".srt", ".vtt", ".ttf", ".otf", ".m4a", ".mp4", ".mjs", ".js", ".cjs", ".py"];
      if (!allowed.includes(ext)) throw new Error("File extension is not allowed");
      if ([".mjs", ".js", ".cjs", ".py"].includes(ext) && !trusted_code_authorized) {
        throw new Error("Executable project code requires trusted_code_authorized=true after you have reviewed and accepted that code.");
      }
      const target = safeFile(project_id, relative_path);
      if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error("Refusing to write through a symbolic link.");
      if (fs.existsSync(target) && !overwrite) throw new Error("File already exists; set overwrite=true to replace it.");
      const bytes = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
      if (encoding === "base64" && bytes.toString("base64").replace(/=+$/, "") !== content.replace(/=+$/, "")) {
        throw new Error("Invalid base64 content");
      }
      if (bytes.length > 15 * 1024 * 1024) throw new Error("Each uploaded file is limited to 15 MiB.");
      await fsp.mkdir(path.dirname(target), {recursive: true});
      await fsp.writeFile(target, bytes, {flag: overwrite ? "w" : "wx"});
      return {project_id, file: relative_path, bytes: bytes.length, saved: true};
    })
  );
  server.tool("autopilot_read_file",
    "Read a project file or B5 external output. Small images are returned for visual inspection; large files use signed download links.",
    {project_id: z.string(), relative_path: z.string(), area: z.enum(["project", "b5_output"]).default("project")},
    async ({project_id, relative_path, area}) => {
      try {
        const file = area === "b5_output"
          ? safeOutputFile(project_id, relative_path, true)
          : safeFile(project_id, relative_path, true);
        const stat = fs.statSync(file);
        const ext = path.extname(file).toLowerCase();
        if (stat.size > 2 * 1024 * 1024) return textResult({file: relative_path, area, bytes: stat.size,
          download_url: signedUrl(project_id, relative_path, area), note: "File is too large to embed in a tool response."});
        if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
          const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
          return {content: [{type: "image", data: fs.readFileSync(file).toString("base64"), mimeType}]};
        }
        if ([".json", ".txt", ".md", ".srt", ".vtt", ".log"].includes(ext)) {
          return textResult({file: relative_path, area, content: fs.readFileSync(file, "utf8")});
        }
        return textResult({file: relative_path, area, bytes: stat.size, download_url: signedUrl(project_id, relative_path, area)});
      } catch (error) { return errorResult(error); }
    }
  );
  server.tool("autopilot_list_files",
    "List files in a project or its dedicated B5 output workspace.",
    {project_id: z.string(), area: z.enum(["project", "b5_output"]).default("project")},
    async ({project_id, area}) => tool(() => collectFiles(area === "b5_output" ? b5OutputDir(project_id) : projectDir(project_id)))
  );
  server.tool("autopilot_project_status",
    "Summarize a project's current manifest, checkpoint and available output files.",
    {project_id: z.string()},
    async ({project_id}) => tool(() => {
      const dir = projectDir(project_id);
      let manifest;
      const manifestPath = path.join(dir, "project.json");
      if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      else manifest = {style: fs.existsSync(path.join(dir, "scene", "config.json")) ? "B5" : "unknown"};
      const files = collectFiles(dir);
      let checkpoint = null;
      for (const candidate of ["output/checkpoint.json", "output/preview-report.json", "output/film-report.json"]) {
        const p = path.join(dir, candidate);
        if (fs.existsSync(p)) {
          try { checkpoint = {...(checkpoint || {}), [candidate]: JSON.parse(fs.readFileSync(p, "utf8"))}; } catch {}
        }
      }
      return {project_id, style: manifest.style, width: manifest.width, height: manifest.height,
        ratio: manifest.width > manifest.height ? "16:9" : "9:16",
        files, checkpoint, storage_note: "Render Free storage is ephemeral; download completed files promptly."};
    })
  );
  server.tool("autopilot_run_stage",
    "Run one original Autopilot stage asynchronously. Preview is not approval. approve requires explicit user confirmation plus the style's independent review files. render requires explicit authorization for full production and a valid approval created by the original runtime.",
    {project_id: z.string(),
      stage: z.enum(["validate", "preview", "approve", "render", "review-pack", "check-review",
        "accept-visual", "accept-text", "accept-picture", "draft", "preflight", "plan-iteration"]),
      seconds: z.number().positive().max(60).optional(),
      user_confirmed_sample: z.boolean().default(false),
      user_confirmed_full_production: z.boolean().default(false),
      trusted_code_authorized: z.boolean().default(false),
      note: z.string().max(500).optional(),
      visual_review: z.string().optional(),
      text_review: z.string().optional(),
      picture_review: z.string().optional(),
      review_file: z.string().optional()},
    async (input) => tool(() => {
      const {project_id, stage} = input;
      const dir = projectDir(project_id);
      const manifest = readProject(project_id);
      if (manifest.style === "B5") throw new Error("B5 uses its dedicated route. Call autopilot_run_b5 instead of autopilot_run_stage.");
      const projectArg = manifest.style === "B6" ? dir : path.join(dir, "project.json");
      const args = [stage, projectArg];
      if (stage === "preview") args.push("--seconds", String(input.seconds || 10));
      if (stage === "approve") {
        if (!input.user_confirmed_sample) throw new Error("The user must explicitly approve this preview before approve can run.");
        args.push("--note", input.note || "User explicitly approved the reviewed sample.");
        for (const [field, flag] of [["visual_review", "--visual-review"], ["text_review", "--text-review"], ["picture_review", "--picture-review"]]) {
          if (input[field]) args.push(flag, safeFile(project_id, input[field], true));
        }
      }
      if (stage === "render" && !input.user_confirmed_full_production) {
        throw new Error("Full production requires explicit user authorization.");
      }
      if (["accept-visual", "accept-text", "accept-picture", "check-review"].includes(stage)) {
        if (!input.review_file) throw new Error(stage + " requires review_file.");
        args.push("--review", safeFile(project_id, input.review_file, true));
      }
      if (manifest.style === "B6") {
        if (!input.trusted_code_authorized) throw new Error("B6 executes reviewed project-local scene code. Confirm trusted_code_authorized=true only after inspecting and accepting that code.");
        args.push("--trusted-code");
      }
      return startJob(project_id, stage, CLI, args);
    })
  );
  server.tool("autopilot_run_b5",
    "Run the original dedicated B5 Character Explainer route. Path arguments must use @project/path or @output/path. It executes project-local scene code, so trusted_code_authorized must be true after code inspection.",
    {project_id: z.string(),
      command: z.enum(["validate", "frames", "encode", "reference-study", "plan-lock", "png-review-pack",
        "png-first-read-seal", "png-review-check", "png-revision-review-pack", "review-pack", "preview-ready", "accept"]),
      arguments: z.array(z.string()).max(50).default([]),
      trusted_code_authorized: z.boolean().default(false)},
    async (input) => tool(() => {
      if (!input.trusted_code_authorized) throw new Error("B5 runs authored local scene code. Inspect it and obtain explicit user authorization first.");
      const pathFlags = new Set(["--output", "--frames-dir", "--audio", "--plan-lock", "--previous",
        "--candidate-dir", "--evidence-dir", "--review", "--png-evidence", "--image-first-read",
        "--image-first-seal", "--png-review", "--png-revision", "--previous-evidence",
        "--previous-first-read", "--previous-seal", "--previous-review", "--preview-ready",
        "--diagnostic-masks"]);
      const outputFlags = new Set(["--output"]);
      const mapped = [];
      for (let i = 0; i < input.arguments.length; i++) {
        const arg = input.arguments[i];
        if (arg.includes("\0") || /^[a-z]+:\/\//i.test(arg)) throw new Error("URLs and NUL bytes are not accepted in B5 arguments.");
        if (pathFlags.has(arg)) {
          const raw = input.arguments[++i];
          if (!raw) throw new Error("Missing value for B5 path argument " + arg);
          let resolved;
          if (raw.startsWith("@project/")) {
            if (outputFlags.has(arg)) throw new Error("--output must use @output/path, not @project/path.");
            resolved = safeFile(input.project_id, raw.slice("@project/".length), !outputFlags.has(arg));
          } else if (raw.startsWith("@output/")) {
            resolved = safeOutputFile(input.project_id, raw.slice("@output/".length), !outputFlags.has(arg));
          } else {
            throw new Error("B5 path values must begin with @project/ or @output/.");
          }
          mapped.push(arg, resolved);
        } else {
          if (path.isAbsolute(arg) || arg.split(/[\\/]/).includes("..")) {
            throw new Error("Absolute paths and parent traversal are blocked in B5 arguments.");
          }
          mapped.push(arg);
        }
      }
      const args = [input.command, projectDir(input.project_id), ...mapped];
      if (!mapped.includes("--trusted-code")) args.push("--trusted-code");
      return startJob(input.project_id, "B5 " + input.command, B5_CLI, args);
    })
  );
  server.tool("autopilot_generate_media",
    "Optional original Gemini media adapter. Makes exactly one external API request for an image or speech file; requires GEMINI_API_KEY and explicit user authorization. Provider usage may be billed; no automatic retries.",
    {project_id: z.string(), kind: z.enum(["image", "speech"]),
      prompt: z.string().max(12000).optional(), narration_text: z.string().max(12000).optional(),
      output_path: z.string(), model: z.string().regex(/^[A-Za-z0-9._-]{2,100}$/),
      voice: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
      user_authorized_external_api: z.boolean()},
    async (input) => tool(async () => {
      if (!input.user_authorized_external_api) throw new Error("External generation requires explicit user authorization.");
      if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured on the Render service. Add it in Render Environment settings; never paste it into chat.");
      if (input.kind === "image" && !input.prompt) throw new Error("prompt is required for image generation.");
      if (input.kind === "speech" && (!input.narration_text || !input.voice)) throw new Error("narration_text and voice are required for speech.");
      const output = safeFile(input.project_id, input.output_path);
      if (fs.existsSync(output)) throw new Error("Output exists. Inspect the previous request receipt before retrying.");
      const inputName = ".chatgpt/" + crypto.randomUUID() + (input.kind === "image" ? ".prompt.txt" : ".narration.txt");
      const inputPath = safeFile(input.project_id, inputName);
      await fsp.mkdir(path.dirname(inputPath), {recursive: true});
      await fsp.writeFile(inputPath, input.kind === "image" ? input.prompt : input.narration_text, {flag: "wx"});
      const args = [input.kind, "--model", input.model, "--output", output,
        input.kind === "image" ? "--prompt" : "--text", inputPath, "--allow-network"];
      if (input.kind === "speech") args.push("--voice", input.voice);
      return startJob(input.project_id, "Gemini " + input.kind + " generation", MEDIA_CLI, args);
    })
  );
  server.tool("autopilot_job_status",
    "Poll an asynchronous Autopilot or media-generation task and read its recent log output.",
    {project_id: z.string(), job_id: z.string()},
    async ({project_id, job_id}) => tool(() => {
      const id = validId(job_id);
      const file = path.join(jobDir(project_id), id + ".json");
      if (!fs.existsSync(file)) throw new Error("Job not found in this project.");
      const meta = JSON.parse(fs.readFileSync(file, "utf8"));
      if (meta.project_id !== project_id) throw new Error("Job/project mismatch.");
      if (meta.status === "running" && !activeJobs.has(id)) {
        meta.status = "interrupted"; meta.finished_at = new Date().toISOString();
        meta.note = "The server restarted or lost the process; inspect the project and resume only the failed stage.";
        writeJsonAtomic(file, meta);
      }
      const logFile = path.join(jobDir(project_id), id + ".log");
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-7000) : "";
      return {...meta, log};
    })
  );
  server.tool("autopilot_download_link",
    "Create a short-lived signed download link for a project file or a B5 output file.",
    {project_id: z.string(), relative_path: z.string(), area: z.enum(["project", "b5_output"]).default("project")},
    async ({project_id, relative_path, area}) => tool(() => {
      const file = area === "b5_output"
        ? safeOutputFile(project_id, relative_path, true)
        : safeFile(project_id, relative_path, true);
      const stat = fs.statSync(file);
      return {file: relative_path, area, bytes: stat.size, expires_in_seconds: 1800,
        download_url: signedUrl(project_id, relative_path, area)};
    })
  );
}

function addReferenceTool(server) {
  server.tool("autopilot_read_reference",
    "Read an original Stickman Video Director reference, workflow guide, example manifest or source script from the pinned upstream installation. Use the style-specific production and QA documents before authoring a project.",
    {relative_path: z.string().min(1).max(240)},
    async ({relative_path}) => tool(() => {
      const normalized = relative_path.replace(/\\\\/g, "/");
      const allowedRoots = ["references/", "examples/", "scripts/", "tests/"];
      if (!allowedRoots.some(root => normalized.startsWith(root)) ||
          normalized.split("/").some(part => !part || part === "." || part === "..")) {
        throw new Error("Only files under the installed references/, examples/, scripts/ or tests/ directories can be read.");
      }
      const target = path.resolve(ROOT, normalized);
      if (!target.startsWith(ROOT + path.sep)) throw new Error("Reference path escaped the installed project.");
      const real = fs.realpathSync(target);
      if (!real.startsWith(fs.realpathSync(ROOT) + path.sep) || !fs.statSync(real).isFile()) {
        throw new Error("Reference file not found.");
      }
      const stat = fs.statSync(real);
      if (stat.size > 120000) throw new Error("Reference is larger than 120 KB; read a narrower text reference.");
      const ext = path.extname(real).toLowerCase();
      if (![".md", ".json", ".mjs", ".js", ".py", ".txt"].includes(ext)) {
        throw new Error("Only text-based reference files can be read through this tool.");
      }
      return {path: normalized, content: fs.readFileSync(real, "utf8")};
    })
  );
}

function makeMcpServer() {
  const server = new McpServer(
    {name: "stickman-video-director-chatgpt", version: "1.1.0"},
    {maxToolInputElements: 1000}
  );
  addReferenceTool(server);
  addProjectTool(server);
  return server;
}
async function readBody(req, limit = 24 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "accept,content-type,mcp-session-id,mcp-protocol-version,last-event-id");
}
const httpServer = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  if (url.pathname === "/health") {
    json(res, 200, {status: "ok", service: "stickman-video-director-chatgpt",
      upstream: "kaomei/stickman-video-director", upstream_commit: UPSTREAM_COMMIT,
      autopilot_installed: fs.existsSync(CLI), mcp_configured: Boolean(TOKEN),
      project_storage: PROJECTS});
    return;
  }
  if (url.pathname === "/") {
    json(res, 200, {service: "Stickman Video Director ChatGPT bridge", mcp: "/mcp/<private-token>", health: "/health"});
    return;
  }
  if (url.pathname.startsWith("/download/")) {
    try {
      const id = url.pathname.split("/")[2];
      const relative = url.searchParams.get("file") || "";
      const area = url.searchParams.get("area") || "project";
      const expires = url.searchParams.get("expires") || "";
      const sig = url.searchParams.get("sig") || "";
      if (!verifyDownload(id, relative, area, expires, sig)) { json(res, 403, {error: "Invalid or expired download link"}); return; }
      const file = area === "b5_output"
        ? safeOutputFile(id, relative, true)
        : safeFile(id, relative, true);
      res.writeHead(200, {"content-type": mimeFor(file), "content-length": fs.statSync(file).size,
        "content-disposition": "attachment; filename=\"" + path.basename(file).replace(/["\\]/g, "") + "\"",
        "cache-control": "private, no-store"});
      fs.createReadStream(file).pipe(res);
    } catch (error) { json(res, 404, {error: error.message}); }
    return;
  }
  if (url.pathname.startsWith("/mcp/")) {
    const supplied = url.pathname.slice("/mcp/".length);
    if (!TOKEN || !safeEqual(supplied, TOKEN)) { json(res, 401, {error: "Unauthorized"}); return; }
    if (req.method !== "POST") { json(res, 405, {error: "MCP endpoint accepts POST requests"}); return; }
    try {
      const body = await readBody(req);
      if (!req.headers.accept) {
        req.headers.accept = "application/json, text/event-stream";
        req.rawHeaders.push("Accept", "application/json, text/event-stream");
      }
      const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
      const mcp = makeMcpServer();
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) json(res, 400, {error: error.message});
      else res.end();
    }
    return;
  }
  json(res, 404, {error: "Not found"});
});
function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return ({".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".json": "application/json",
    ".srt": "application/x-subrip", ".vtt": "text/vtt", ".pdf": "application/pdf"})[ext] || "application/octet-stream";
}
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("Stickman Video Director bridge listening on " + PORT);
  console.log("Autopilot root: " + ROOT);
});
