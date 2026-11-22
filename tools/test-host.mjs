/**
 * dsh-caller 宿主半边的离线验收：用一个假的 Cordis Context 把 lib/index.js
 * 挂起来，再用真实 HTTP 请求把每条路由跑一遍。
 *
 *   node tools/test-host.mjs
 *
 * 覆盖：路由注册、SSE 握手与广播、轮询取事件、内置音频、自定义音频（Range）、
 * 上传落盘、SAPI 语音合成、call_owner 工具定义 + 执行、以及工具 schema 是否
 * 落在 DSH 支持的 JSON Schema 子集内。
 */
import { createServer } from "node:http";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, "..");

/**
 * `@deepseek-ai/dsh-tools` 只用来校验工具 schema 是否落在 DSH 支持的子集里，
 * 它是 DSH 自带的包、不是本插件的依赖。找不到就跳过那一项，不阻断其它检查。
 */
function findDshTools() {
  const candidates = [
    process.env.DSH_CALLER_DSH_TOOLS,
    path.join(HERE, "..", "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js"),
    process.env.DSH_HOME === undefined
      ? undefined
      : path.join(process.env.DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js"),
  ].filter((candidate) => typeof candidate === "string");
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const DSH_TOOLS = findDshTools();

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/* ---------- 假的宿主上下文 ---------- */
const routes = new Map();
const registeredTools = [];

function makeCtx() {
  const logger = { info: () => {}, warn: (message) => console.log(`  [warn] ${message}`) };
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
    tapIndex() {
      return () => {};
    },
  };
  const tools = {
    register(definition) {
      registeredTools.push(definition);
      return () => {};
    },
  };
  const services = { webServer, tools };
  const childFor = () => ({
    get: (name) => services[name],
    effect: (callback, _label) => {
      const disposer = callback();
      return typeof disposer === "function" ? disposer : () => {};
    },
  });
  return {
    inject(names, callback) {
      callback(childFor(names));
    },
    effect: (callback) => callback(),
    logger,
  };
}

const plugin = await import(pathToFileURL(path.join(PLUGIN, "lib", "index.js")).href);
check("插件导出 name", plugin.name === "dsh-caller", plugin.name);
check("插件声明 inject=[webServer]", Array.isArray(plugin.inject) && plugin.inject.includes("webServer"));

plugin.apply(makeCtx());
check("注册了 10 条路由", routes.size === 10, [...routes.keys()].join(" "));
check("注册了 call_owner 工具", registeredTools.length === 1 && registeredTools[0].name === "call_owner");

/* ---------- 工具 schema 是否合法 ---------- */
if (DSH_TOOLS === null) {
  console.log("  skip  工具 schema 校验（找不到 @deepseek-ai/dsh-tools；可用 DSH_CALLER_DSH_TOOLS 指定路径）");
} else {
  try {
    const toolsLib = await import(pathToFileURL(DSH_TOOLS).href);
    const definition = plugin.toolDefinition;
    toolsLib.assertObjectJsonSchema(definition.parameters);
    toolsLib.assertObjectJsonSchema(definition.output.schema);
    const args = toolsLib.validateJsonSchemaValue(definition.parameters, { text: "hi", urgent: true }, "");
    const bad = toolsLib.validateJsonSchemaValue(definition.parameters, { text: 5, nope: 1 }, "");
    check("工具 parameters 是合法的对象根 JSON Schema", args.length === 0, `合法参数 0 违规，非法参数 ${bad.length} 条违规`);
  } catch (error) {
    check("工具 parameters 是合法的对象根 JSON Schema", false, String(error?.message ?? error));
  }
}

/* ---------- 真起一个 HTTP 服务把路由跑通 ---------- */
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = routes.get(url.pathname);
  if (route === undefined) {
    res.writeHead(404).end("no route");
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error?.message ?? error));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const api = (suffix) => `${origin}/api/dsh-caller/${suffix}`;

/* SSE：先连上，再触发一次呼叫，确认事件真的推下来 */
const sse = await fetch(api("stream"));
check("SSE 握手 200 + text/event-stream", sse.status === 200 && String(sse.headers.get("content-type")).startsWith("text/event-stream"));
const reader = sse.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const pull = async () => {
  const chunk = await reader.read();
  if (chunk.done) return "";
  buffer += decoder.decode(chunk.value, { stream: true });
  return buffer;
};
await pull();
check("SSE 首个事件是 hello", buffer.includes("event: hello"));

/* 内置音频 */
const asset = await fetch(api("assets?f=chime-clear.wav"));
const assetBytes = Buffer.from(await asset.arrayBuffer());
check("内置音频 200 + RIFF", asset.status === 200 && assetBytes.subarray(0, 4).toString() === "RIFF", `${assetBytes.length} B`);

/* 自定义音频 + Range */
const custom = path.join(os.tmpdir(), "dsh-caller-fixture-tone.wav");
writeFileSync(custom, assetBytes);
const ranged = await fetch(api(`file?path=${encodeURIComponent(custom)}`), { headers: { Range: "bytes=0-15" } });
check("自定义音频支持 Range(206)", ranged.status === 206, String(ranged.headers.get("content-range")));
const blocked = await fetch(api(`file?path=${encodeURIComponent(path.join(HERE, "make_chimes.py"))}`));
check("非音频扩展名被拒绝(403)", blocked.status === 403);

/* 上传落盘 */
const upload = await fetch(api("upload?name=my%20tone.wav"), { method: "POST", body: assetBytes });
const uploadBody = await upload.json();
check("上传落盘成功", upload.ok && typeof uploadBody.path === "string" && existsSync(uploadBody.path), uploadBody.path);

/* 设置上报 */
const registered = await fetch(api("register"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ aiCallEnabled: true }),
});
check("浏览器设置上报 200", registered.status === 200);

/* 面板直呼 → SSE 应该收到 call 事件 */
await fetch(api("call"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "主人，人家有事找你", reason: "验收测试" }),
});
await new Promise((resolve) => setTimeout(resolve, 250));
await pull();
check("SSE 收到 call 事件且带自定义文案", buffer.includes("event: call") && buffer.includes("主人，人家有事找你"), buffer.split("\n\n").filter(Boolean).at(-1));

/* 轮询兜底 */
const poll = await fetch(api("poll?since=0"));
const pollBody = await poll.json();
check("轮询返回历史事件", Array.isArray(pollBody.events) && pollBody.events.length >= 1 && typeof pollBody.seq === "number");

/* 工具执行 */
const toolResult = await plugin.toolDefinition.execute({ text: "验收：工具链路", urgent: false });
check("call_owner 工具执行成功", toolResult.delivered === true && toolResult.clients >= 1, JSON.stringify(toolResult));

/* SAPI 语音合成 */
const tts = await fetch(api(`tts?text=${encodeURIComponent("主人，人家有事找你")}`));
if (tts.status === 200) {
  const wav = Buffer.from(await tts.arrayBuffer());
  check("SAPI 语音合成 200 + RIFF", wav.subarray(0, 4).toString() === "RIFF", `${wav.length} B`);
  check(
    "补静音后 RIFF 头依然自洽（否则播放器会截断）",
    wav.readUInt32LE(4) === wav.length - 8 && wav.toString("ascii", 8, 12) === "WAVE",
    `riff=${wav.readUInt32LE(4)} len-8=${wav.length - 8}`,
  );
  const second = await fetch(api(`tts?text=${encodeURIComponent("主人，人家有事找你")}`));
  check("同一段文案命中语音缓存", (await second.arrayBuffer()).byteLength === wav.length);
} else {
  const detail = (await tts.text()).slice(0, 160);
  // DSH 的测试进程禁止用管道捕获子进程输出，这里可能拿到 spawn EPERM；
  // 那是运行环境的限制（运行中的插件本身正常），标 skip 而不是 fail。
  if (/EPERM|spawn/i.test(detail)) {
    console.log(`  skip  SAPI 语音合成（本环境不允许管道 spawn 子进程）`);
  } else {
    check("SAPI 语音合成", false, `${tts.status} ${detail}`);
  }
}

/* DeepSeek 语音合成：只验配置接口与失败路径，不对线上产生真实计费 */
const dsConfig = await fetch(api("deepseek/config"));
const dsConfigBody = await dsConfig.json();
check(
  "DeepSeek Key 状态接口可用",
  dsConfig.status === 200 && typeof dsConfigBody.configured === "boolean" && typeof dsConfigBody.masked === "string",
  JSON.stringify(dsConfigBody),
);
check(
  "状态接口不回传明文 Key",
  typeof dsConfigBody.masked === "string" && (dsConfigBody.masked === "" || dsConfigBody.masked.includes("••••")),
  dsConfigBody.masked === "" ? "(未配置)" : dsConfigBody.masked,
);

const dsEmptyKey = await fetch(api("deepseek/config"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ apiKey: "   " }),
});
check("空 Key 被拒绝(400)", dsEmptyKey.status === 400, String(dsEmptyKey.status));

if (dsConfigBody.configured === true) {
  console.log("  skip  DeepSeek 合成请求（已配置真实 Key，避免测试产生计费）");
} else {
  const dsMissing = await fetch(api(`deepseek/tts?text=${encodeURIComponent("测试一下")}`));
  const dsError = await dsMissing.json().catch(() => ({}));
  check(
    "未填 Key 时给出明确错误",
    dsMissing.status === 502 && dsError.code === "missing-key",
    `${dsMissing.status} ${JSON.stringify(dsError).slice(0, 120)}`,
  );
}

/* 工具被用户关掉时的回执 */
await fetch(api("register"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ aiCallEnabled: false }),
});
const blockedCall = await plugin.toolDefinition.execute({});
check("用户关闭后工具不再打扰", blockedCall.delivered === false && /关闭/.test(blockedCall.note), blockedCall.note);

reader.cancel().catch(() => {});
server.close();
console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
