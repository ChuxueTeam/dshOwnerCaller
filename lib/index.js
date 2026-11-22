/**
 * dsh-caller —— 「呼叫主人」插件（宿主半边）。
 *
 * 零侵入：不改任何内置包文件，只做四件事。
 *   1. /api/dsh-caller/stream   SSE 通道，把「呼叫」事件实时推给浏览器窗口；
 *   2. /api/dsh-caller/poll     轮询兜底（SSE 建不起来时用）；
 *   3. /api/dsh-caller/assets   内置音频（assets/*.wav）只读路由；
 *   4. /api/dsh-caller/file     用户自定义音频文件只读路由（限音频扩展名）；
 *   5. /api/dsh-caller/tts      用 Windows SAPI 把弹窗文案合成语音（带磁盘缓存）；
 *   6. /api/dsh-caller/register 浏览器上报自己的设置（是否允许 AI 呼叫）。
 *
 * 另外向工具表注册一个模型工具 call_owner，让 Agent 能主动把用户叫回来。
 * 叫不叫得动，最终由浏览器里的设置面板说了算。
 */
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis 插件名（loader 诊断用）。 */
export const name = "dsh-caller";

/** 硬依赖：没有 webServer 就没有推送给浏览器的那条腿。 */
export const inject = ["webServer"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, "..", "assets");
const ROUTE = "/api/dsh-caller";
const TTS_CACHE_DIR = path.join(os.tmpdir(), "dsh-caller-tts");
const DATA_DIR = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "dsh-caller");
const UPLOAD_DIR = path.join(DATA_DIR, "audio");
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/* ---------- DeepSeek 语音合成（官方 tools/tts） ---------- */

const DEEPSEEK_TTS_URL = "https://api.deepseek.com/v1/tools/tts";
const DEEPSEEK_CACHE_DIR = path.join(DATA_DIR, "deepseek-tts");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
/** 官方只提供两种音色：stella（海星，女声）与 tide（暗潮，男声）。 */
const DEEPSEEK_VOICES = new Set(["stella", "tide"]);
const DEEPSEEK_DEFAULT_VOICE = "tide";
/** 官方上限 10,000 计费字符；弹窗文案本身最多 300 字，这里留足余量即可。 */
const DEEPSEEK_MAX_TEXT = 3000;

const MIME = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".weba": "audio/webm",
  ".webm": "audio/webm",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".weba", ".webm"]);

/* ------------------------------------------------------------------ *
 * 事件总线：宿主进程内单例。插件被 HMR 重新 apply 时不丢已连接的窗口。
 * ------------------------------------------------------------------ */
const HUB = Symbol.for("dsh-caller.hub");

function hub() {
  if (globalThis[HUB] === undefined) {
    globalThis[HUB] = {
      seq: 0,
      /** 活着的 SSE 连接：{ res, id } */
      streams: new Set(),
      /** 最近 N 条事件，给轮询兜底与迟到订阅者用 */
      history: [],
      /** 浏览器上报的「允许 AI 呼叫」，默认允许 */
      aiCallEnabled: true,
      clientSeenAt: 0,
    };
  }
  return globalThis[HUB];
}

/** 广播一条事件，返回当前送达的窗口数。 */
function publish(kind, payload) {
  const state = hub();
  const event = { kind, id: ++state.seq, at: Date.now(), ...payload };
  state.history.push(event);
  if (state.history.length > 50) state.history.splice(0, state.history.length - 50);
  const frame = `event: ${kind}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const stream of [...state.streams]) {
    try {
      stream.res.write(frame);
    } catch {
      state.streams.delete(stream);
    }
  }
  return state.streams.size;
}

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.length) });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** 把 assets 目录内的相对路径解析成绝对路径；越界返回 null。 */
function resolveAsset(rel) {
  const target = path.normalize(path.join(ASSETS_DIR, rel));
  if (target !== ASSETS_DIR && !target.startsWith(ASSETS_DIR + path.sep)) return null;
  return target;
}

/** 读取请求体（限 64 KiB），返回解析后的 JSON 或 undefined。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

/** 带 Range 支持的音频响应（<audio> 拖动进度条需要 206）。 */
function serveAudio(req, res, file, info, cacheControl = "public, max-age=3600") {
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const total = info.size;
  let start = 0;
  let end = total - 1;
  let status = 200;

  const range = req.headers.range;
  if (typeof range === "string") {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match !== null) {
      if (match[1] === "" && match[2] !== "") {
        start = Math.max(0, total - Number(match[2]));
      } else {
        start = Number(match[1]);
        end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      status = 206;
    }
  }

  const headers = {
    "Content-Type": type,
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
  };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file, { start, end }).pipe(res);
}

/* ------------------------------------------------------------------ *
 * Windows SAPI 语音合成
 * ------------------------------------------------------------------ */

const POWERSHELL =
  process.env.SystemRoot !== undefined
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

/** 纯 ASCII 脚本；文案与参数一律走环境变量，避免任何转义/编码问题。 */
const SAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "if ($env:DSH_CALLER_VOICE) { try { $synth.SelectVoice($env:DSH_CALLER_VOICE) } catch { } }",
  "$synth.Rate = [int]$env:DSH_CALLER_RATE",
  "$synth.Volume = 100",
  "$synth.SetOutputToWaveFile($env:DSH_CALLER_OUT)",
  "$synth.Speak($env:DSH_CALLER_TEXT)",
  "$synth.Dispose()",
  "",
].join("\r\n");

/**
 * 解析 WAV 的 fmt / data chunk 位置。只在结构认得出来时才返回，认不出就返回 null。
 */
function readWavLayout(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) return null;
    if (id === "fmt " && size >= 16) {
      format = {
        blockAlign: buffer.readUInt16LE(body + 12),
        sampleRate: buffer.readUInt32LE(body + 4),
      };
    } else if (id === "data") {
      data = { size, sizeOffset: offset + 4 };
    }
    offset = body + size + (size % 2);
  }
  return format === null || data === null ? null : { format, data };
}

/**
 * 在 WAV 末尾补一段静音。循环播放时「语音→静音→语音」比「语音紧接语音」自然得多。
 * 只认自己的结构：data 不是最后一个 chunk、或格式看不懂，就原样不动（宁可不加，也不能弄坏音频）。
 */
async function appendSilence(file, seconds) {
  if (!(seconds > 0)) return;
  const buffer = await readFile(file);
  const layout = readWavLayout(buffer);
  if (layout === null) return;
  const { format, data } = layout;
  const dataEnd = data.sizeOffset + 4 + data.size + (data.size % 2);
  if (dataEnd !== buffer.length) return;
  if (format.blockAlign <= 0 || format.sampleRate <= 0) return;
  const wanted = Math.round(format.sampleRate * format.blockAlign * seconds);
  const silence = wanted - (wanted % format.blockAlign);
  if (silence <= 0) return;
  const padded = Buffer.alloc(buffer.length + silence);
  buffer.copy(padded, 0);
  padded.writeUInt32LE(data.size + silence, data.sizeOffset);
  padded.writeUInt32LE(padded.length - 8, 4);
  await writeFile(file, padded);
}

async function synthesize(text, voice, rate, out) {
  await mkdir(TTS_CACHE_DIR, { recursive: true });
  const scriptPath = path.join(TTS_CACHE_DIR, "sapi.ps1");
  await writeFile(scriptPath, SAPI_SCRIPT, "utf8");
  const temp = `${out}.${process.pid}.tmp.wav`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        env: {
          ...process.env,
          DSH_CALLER_TEXT: text,
          DSH_CALLER_VOICE: voice,
          DSH_CALLER_RATE: String(rate),
          DSH_CALLER_OUT: temp,
        },
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && existsSync(temp)) resolve();
      else reject(new Error(`SAPI 退出码 ${code}: ${stderr.trim().slice(0, 400) || "无输出"}`));
    });
  });
  await rename(temp, out);
  // 循环播放时给语音留一口气，否则听起来像「主人，人家有事找你主人，人家有事找你」。
  await appendSilence(out, 1.05);
}

/* ------------------------------------------------------------------ *
 * 路由处理
 * ------------------------------------------------------------------ */

function handleStream(req, res) {
  const state = hub();
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");
  const stream = { res, id: ++state.seq };
  state.streams.add(stream);
  state.clientSeenAt = Date.now();
  try {
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        id: stream.id,
        aiCallEnabled: state.aiCallEnabled,
        latest: state.seq,
      })}\n\n`,
    );
  } catch {
    state.streams.delete(stream);
    return;
  }
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* 连接已断，close 回调会清理 */
    }
  }, 25000);
  const cleanup = () => {
    clearInterval(ping);
    state.streams.delete(stream);
  };
  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("error", cleanup);
}

function handlePoll(req, res) {
  const state = hub();
  const url = new URL(req.url, "http://127.0.0.1");
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  state.clientSeenAt = Date.now();
  sendJson(res, 200, {
    seq: state.seq,
    aiCallEnabled: state.aiCallEnabled,
    events: state.history.filter((event) => event.id > since),
  });
}

function handleAssets(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const rel = (url.searchParams.get("f") ?? "").split("?")[0];
  const file = resolveAsset(rel);
  if (file === null || rel === "" || !existsSync(file) || !statSync(file).isFile()) {
    sendText(res, 404, "not found");
    return;
  }
  serveAudio(req, res, file, statSync(file));
}

function handleFile(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const raw = url.searchParams.get("path") ?? "";
  if (raw.trim() === "") {
    sendText(res, 400, "缺少 path 参数");
    return;
  }
  let file;
  try {
    file = path.resolve(raw);
  } catch {
    sendText(res, 400, "路径无法解析");
    return;
  }
  if (!AUDIO_EXT.has(path.extname(file).toLowerCase())) {
    sendText(res, 403, "只允许音频文件（wav/mp3/m4a/aac/ogg/opus/flac/webm）");
    return;
  }
  if (!existsSync(file)) {
    sendText(res, 404, "文件不存在");
    return;
  }
  const info = statSync(file);
  if (!info.isFile()) {
    sendText(res, 404, "不是文件");
    return;
  }
  if (info.size > MAX_AUDIO_BYTES) {
    sendText(res, 413, "音频文件过大（上限 128 MiB）");
    return;
  }
  serveAudio(req, res, file, info, "no-cache");
}

async function handleTts(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const text = (url.searchParams.get("text") ?? "").trim().slice(0, 300);
  if (text === "") {
    sendText(res, 400, "缺少 text 参数");
    return;
  }
  const voice = (url.searchParams.get("voice") ?? "").trim().slice(0, 120);
  const rawRate = Number(url.searchParams.get("rate") ?? 0);
  const rate = Number.isFinite(rawRate) ? Math.max(-10, Math.min(10, Math.trunc(rawRate))) : 0;
  const key = crypto.createHash("sha1").update(`${voice}\u0000${rate}\u0000${text}\u0000v2`).digest("hex");
  const out = path.join(TTS_CACHE_DIR, `${key}.wav`);
  if (!existsSync(out)) {
    try {
      await synthesize(text, voice, rate, out);
    } catch (error) {
      sendText(res, 502, `语音合成失败：${String(error?.message ?? error)}`);
      return;
    }
  }
  serveAudio(req, res, out, statSync(out));
}

/* ------------------------------------------------------------------ *
 * 宿主侧配置：只存敏感信息（DeepSeek API Key），其它偏好留在浏览器里。
 * ------------------------------------------------------------------ */

/** 读 <DSH_HOME>/dsh-caller/config.json；文件不存在或坏掉都当成空配置。 */
async function readHostConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
    return {};
  } catch (error) {
    return {};
  }
}

/** 合并写回，原子替换，避免写一半断电留下半个文件。 */
async function writeHostConfig(patch) {
  const current = await readHostConfig();
  const next = { ...current, ...patch };
  await mkdir(DATA_DIR, { recursive: true });
  const temp = `${CONFIG_FILE}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temp, CONFIG_FILE);
  return next;
}

/** 只在界面上露出头尾，绝不把完整 Key 发回浏览器。 */
function maskApiKey(key) {
  if (key.length <= 8) return "••••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/** 配置里的 Key 优先，其次环境变量。 */
async function resolveDeepseekKey() {
  const config = await readHostConfig();
  const stored = typeof config.deepseekApiKey === "string" ? config.deepseekApiKey.trim() : "";
  if (stored !== "") return stored;
  const fromEnv = (process.env.DEEPSEEK_API_KEY ?? "").trim();
  return fromEnv;
}

/**
 * 调 DeepSeek 官方整段合成接口，落成 WAV。
 * https://api-docs.deepseek.com/zh-cn/guides/tts/
 */
async function synthesizeDeepseek(text, voice, out) {
  const apiKey = await resolveDeepseekKey();
  if (apiKey === "") {
    const error = new Error("还没填 DeepSeek API Key");
    error.code = "missing-key";
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let response;
  try {
    response = await fetch(DEEPSEEK_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_id: voice,
        format: "wav",
        filter_markdown: true,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const wrapped = new Error(
      error?.name === "AbortError" ? "DeepSeek 语音合成超时" : `连不上 DeepSeek：${String(error?.message ?? error)}`,
    );
    wrapped.code = "network";
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    const error = new Error(`DeepSeek 语音合成失败（HTTP ${response.status}）：${detail || response.statusText}`);
    error.code = `http-${response.status}`;
    throw error;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 44 || buffer.subarray(0, 4).toString() !== "RIFF") {
    const error = new Error("DeepSeek 返回的不是 WAV 音频");
    error.code = "bad-audio";
    throw error;
  }

  await mkdir(DEEPSEEK_CACHE_DIR, { recursive: true });
  const temp = `${out}.${process.pid}.tmp.wav`;
  await writeFile(temp, buffer);
  await rename(temp, out);
  // 与本地语音一致：尾巴补一小段静音，循环播放时才有呼吸感。
  await appendSilence(out, 1.05);
}

/** GET /deepseek/config 读状态（只回掩码），POST 保存或清除 Key。 */
async function handleDeepseekConfig(req, res) {
  if (req.method === "GET") {
    const apiKey = await resolveDeepseekKey();
    sendJson(res, 200, {
      configured: apiKey !== "",
      masked: apiKey === "" ? "" : maskApiKey(apiKey),
      fromEnv: apiKey !== "" && (await readHostConfig()).deepseekApiKey === undefined,
    });
    return;
  }
  if (req.method !== "POST") {
    sendText(res, 405, "只接受 GET 或 POST");
    return;
  }
  const body = await readJsonBody(req);
  if (body === undefined) {
    sendJson(res, 400, { error: "请求体不是合法 JSON" });
    return;
  }
  if (body.clear === true) {
    await writeHostConfig({ deepseekApiKey: "" });
    sendJson(res, 200, { configured: false, masked: "" });
    return;
  }
  if (typeof body.apiKey !== "string") {
    sendJson(res, 400, { error: "缺少 apiKey" });
    return;
  }
  const apiKey = body.apiKey.trim();
  if (apiKey === "") {
    sendJson(res, 400, { error: "API Key 不能为空" });
    return;
  }
  if (!/^[\x21-\x7e]{8,200}$/.test(apiKey)) {
    sendJson(res, 400, { error: "API Key 里不该有空格或中文，请检查是否复制完整" });
    return;
  }
  await writeHostConfig({ deepseekApiKey: apiKey });
  sendJson(res, 200, { configured: true, masked: maskApiKey(apiKey) });
}

/** GET /deepseek/tts?text=&voice= 合成并返回 WAV；同文案同音色走磁盘缓存，不重复计费。 */
async function handleDeepseekTts(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const text = (url.searchParams.get("text") ?? "").trim().slice(0, DEEPSEEK_MAX_TEXT);
  if (text === "") {
    sendJson(res, 400, { error: "缺少 text 参数" });
    return;
  }
  const requested = (url.searchParams.get("voice") ?? "").trim();
  const voice = DEEPSEEK_VOICES.has(requested) ? requested : DEEPSEEK_DEFAULT_VOICE;
  const key = crypto.createHash("sha1").update(`deepseek\u0000${voice}\u0000${text}\u0000v1`).digest("hex");
  const out = path.join(DEEPSEEK_CACHE_DIR, `${key}.wav`);

  if (!existsSync(out)) {
    try {
      await synthesizeDeepseek(text, voice, out);
    } catch (error) {
      sendJson(res, 502, {
        error: String(error?.message ?? error),
        code: typeof error?.code === "string" ? error.code : "tts-failed",
      });
      return;
    }
  }
  serveAudio(req, res, out, statSync(out));
}

async function handleRegister(req, res) {
  if (req.method !== "POST") {
    sendText(res, 405, "只接受 POST");
    return;
  }
  const body = await readJsonBody(req);
  const state = hub();
  if (body !== undefined && typeof body.aiCallEnabled === "boolean") {
    state.aiCallEnabled = body.aiCallEnabled;
  }
  state.clientSeenAt = Date.now();
  sendJson(res, 200, { ok: true, aiCallEnabled: state.aiCallEnabled, streams: state.streams.size });
}

/** 给设置面板「立即呼叫」用的宿主直呼入口（等价于工具，但不经模型）。 */
async function handleCall(req, res) {
  if (req.method !== "POST") {
    sendText(res, 405, "只接受 POST");
    return;
  }
  const body = await readJsonBody(req);
  const raw = body !== undefined && typeof body.text === "string" ? body.text.trim() : "";
  const text = raw === "" ? undefined : raw.slice(0, 300);
  const urgent = body !== undefined && body.urgent === true;
  const note = String((body !== undefined && typeof body.reason === "string" ? body.reason : "") ?? "").slice(0, 200);
  const clients = publish("call", {
    ...(text !== undefined ? { text } : {}),
    urgent,
    ...(note.trim() === "" ? {} : { reason: note.trim() }),
    source: "panel",
  });
  sendJson(res, 200, { delivered: clients > 0, clients });
}

/**
 * 设置面板「选择本地音频文件」的落盘入口：浏览器把用户挑中的文件 POST 上来，
 * 存进 <DSH_HOME>/dsh-caller/audio/，再把绝对路径回给面板填进输入框。
 */
async function handleUpload(req, res) {
  if (req.method !== "POST") {
    sendText(res, 405, "只接受 POST");
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  const rawName = (url.searchParams.get("name") ?? "").trim();
  const ext = path.extname(rawName).toLowerCase();
  if (!AUDIO_EXT.has(ext)) {
    sendText(res, 403, "只允许音频文件（wav/mp3/m4a/aac/ogg/opus/flac/webm）");
    return;
  }
  const stem = path
    .basename(rawName, path.extname(rawName))
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "_")
    .slice(0, 60) || "audio";
  await mkdir(UPLOAD_DIR, { recursive: true });
  const target = path.join(UPLOAD_DIR, `${stem}-${Date.now().toString(36)}${ext}`);
  const temp = `${target}.part`;
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = createWriteStream(temp);
      out.on("error", reject);
      out.on("finish", resolve);
      req.on("error", reject);
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          req.destroy();
          out.destroy();
          reject(new Error("音频文件过大"));
        }
      });
      req.pipe(out);
    });
  } catch (error) {
    sendText(res, 400, String(error?.message ?? error));
    return;
  }
  await rename(temp, target);
  sendJson(res, 200, { path: target, bytes: size });
}

/* ------------------------------------------------------------------ *
 * 模型工具
 * ------------------------------------------------------------------ */

/**
 * 工具定义直接写成已经编译好的 JSON Schema 形状（= defineTool 的产物），
 * 这样插件无需 import 任何 DSH 包，`link:` 安装时也不依赖 node_modules 布局。
 */
export const toolDefinition = {
  name: "call_owner",
  description:
    "呼叫用户本人（主人）：在用户屏幕上弹出一个提示窗口，并按用户在「呼叫主人」设置里配置的方案播放提示音。" +
    "注意这是强打扰手段——提示音会一直循环、弹窗也不会自动消失，直到用户亲手关掉它，所以只在用户确实需要回到电脑前时使用：" +
    "任务已经完成、需要用户确认或补充信息、发现阻塞需要用户决策、用户很久没有回应而你仍然有进展要汇报。" +
    "不要用它做普通的进度播报，不要在短时间内重复呼叫同一个人，也不要在用户已经回到对话里之后再叫。" +
    "关于文案：`text` 只改屏幕上显示的字，随时可以按场合自定义；真正被念出来的「播报语」由用户在设置里固定，" +
    "所以换 `text` 不会触发在线语音合成，反复呼叫也不额外消耗。只有确实需要换一句念出来的话时才传 `speak`——那会触发一次在线合成（按字符计费）。",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      text: {
        type: "string",
        description:
          "本次弹窗要显示的文字（最多 300 字），只影响屏幕显示，不会改变播报语、也不会触发在线语音合成。省略时使用设置里的默认文案。",
      },
      speak: {
        type: "string",
        description:
          "可选：覆盖播报语，让语音念出这句话（最多 300 字）。这会触发一次在线语音合成并按字符计费，所以默认不要传——不传就沿用用户设置好的固定播报语（已缓存，零额外请求）。",
      },
      reason: {
        type: "string",
        description: "可选的一句话说明，会作为小字显示在弹窗里，让用户知道你为什么叫他。",
      },
      urgent: {
        type: "boolean",
        description: "是否紧急：使用更醒目的提示方式，并让弹窗停留更久。默认 false。",
      },
      silent: {
        type: "boolean",
        description: "只弹窗、不播放任何声音。默认 false。",
      },
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["delivered", "clients", "note"],
      properties: {
        delivered: { type: "boolean", description: "是否真的推送到至少一个打开的 DSH 窗口。" },
        clients: { type: "integer", description: "收到本次呼叫的窗口数量。" },
        text: { type: "string", description: "实际使用的弹窗文案。" },
        note: { type: "string", description: "给模型的简短回执说明。" },
      },
    },
    render(_args, value) {
      return [{ type: "text", text: JSON.stringify(value) }];
    },
  },
  async execute(args) {
    const state = hub();
    const raw = typeof args.text === "string" ? args.text.trim() : "";
    const text = raw.slice(0, 300);
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 200) : "";
    const urgent = args.urgent === true;
    const silent = args.silent === true;
    // 只有模型显式要求时才带上 speak；一旦带上，客户端才会为这句话单独合成一次。
    const speak = typeof args.speak === "string" ? args.speak.trim().slice(0, 300) : "";

    if (!state.aiCallEnabled) {
      return {
        delivered: false,
        clients: 0,
        note: "用户已在「设置 → 呼叫主人」里关闭了「允许 AI 呼叫」，本次没有弹出任何东西。请改用普通文字回复，不要反复尝试。",
      };
    }
    if (state.streams.size === 0) {
      return {
        delivered: false,
        clients: 0,
        note: "当前没有打开的 DSH 窗口（浏览器端未连接），呼叫没有送达。请用普通文字回复，用户下次打开窗口时就能看到。",
      };
    }
    const clients = publish("call", {
      ...(text === "" ? {} : { text }),
      ...(speak === "" ? {} : { speak }),
      ...(reason === "" ? {} : { reason }),
      urgent,
      silent,
      source: "tool",
    });
    return {
      delivered: clients > 0,
      clients,
      ...(text === "" ? {} : { text }),
      note:
        "已经呼叫用户：窗口已弹窗，提示音会一直响到用户亲手关闭为止。请在回复里简要说明你需要用户做什么，然后停下来等用户，不要再重复呼叫。",
    };
  },
};

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  ctx.inject(["webServer"], (wctx) => {
    const webServer = wctx.get("webServer");
    const routes = [
      { kind: "exact", path: `${ROUTE}/stream`, handler: (req, res) => handleStream(req, res) },
      { kind: "exact", path: `${ROUTE}/poll`, handler: (req, res) => handlePoll(req, res) },
      { kind: "exact", path: `${ROUTE}/assets`, handler: (req, res) => handleAssets(req, res) },
      { kind: "exact", path: `${ROUTE}/file`, handler: (req, res) => handleFile(req, res) },
      { kind: "exact", path: `${ROUTE}/tts`, handler: (req, res) => handleTts(req, res) },
      { kind: "exact", path: `${ROUTE}/deepseek/config`, handler: (req, res) => handleDeepseekConfig(req, res) },
      { kind: "exact", path: `${ROUTE}/deepseek/tts`, handler: (req, res) => handleDeepseekTts(req, res) },
      { kind: "exact", path: `${ROUTE}/register`, handler: (req, res) => handleRegister(req, res) },
      { kind: "exact", path: `${ROUTE}/call`, handler: (req, res) => handleCall(req, res) },
      { kind: "exact", path: `${ROUTE}/upload`, handler: (req, res) => handleUpload(req, res) },
    ];
    const disposers = routes.map((route) => webServer.register(route));
    wctx.effect(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 组合拆除时重复 dispose 是正常的 */
          }
        }
      },
      "dsh-caller: HTTP 路由",
    );
  });

  ctx.inject(["tools"], (tctx) => {
    try {
      const tools = tctx.get("tools");
      const dispose = tools.register(toolDefinition);
      tctx.effect(() => dispose, "dsh-caller: call_owner 工具");
      ctx.logger?.info?.("dsh-caller: 已注册工具 call_owner");
    } catch (error) {
      ctx.logger?.warn?.(`dsh-caller: 注册 call_owner 工具失败（设置面板与弹窗不受影响）：${String(error?.message ?? error)}`);
    }
  });

  ctx.logger?.info?.("dsh-caller: 已挂载（SSE /api/dsh-caller/stream）");
}
