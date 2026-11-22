/**
 * dsh-caller 客户端半边的离线验收：把 lib/client.js 放进一个假的浏览器环境里
 * （domino 提供真 DOM，React 19 + react-dom/server 负责真渲染），
 * 然后把「设置面板注册」「弹窗」「循环提示音」「关闭即停音」「SSE 事件处理」全部跑一遍。
 *
 *   node tools/test-client.mjs
 *
 * 这个测试存在的理由：DSH 不允许我操作它自己的窗口，所以浏览器那半边没法靠截图验收，
 * 只能靠一个真 DOM + 真 React 的环境把它跑起来。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, "..", "lib", "client.js");

/**
 * 验收需要一个真 DOM（domino）和一个真 React（react + react-dom），
 * 它们是**测试依赖**、不是插件运行时依赖。按「本仓库 node_modules →
 * DSH 自带的依赖 → 环境变量指定的锚点」依次找；一个都找不到就明确跳过，
 * 而不是假装通过。
 */
function tryRequire(anchor) {
  try {
    return createRequire(anchor);
  } catch (error) {
    return null;
  }
}

function tryCall(operation) {
  try {
    return operation();
  } catch (error) {
    return null;
  }
}

const DSH_HOME = process.env.DSH_HOME ?? "C:/Users/friday/.dsh";
const ANCHORS = [
  path.join(HERE, "..", "package.json"),
  process.env.DSH_CALLER_REACT_ENTRY,
  process.env.DSH_CALLER_DOMINO_ENTRY,
  path.join(DSH_HOME, "profiles", "node_modules", "x.js"),
  "I:/Software/DSH/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-trajectory/node_modules/react/package.json",
].filter((anchor) => typeof anchor === "string" && anchor.length > 0);

function resolveAny(specs, anchors) {
  for (const anchor of anchors) {
    const req = tryRequire(anchor);
    if (req === null) continue;
    for (const spec of specs) {
      const found = tryCall(() => req(spec));
      if (found !== null && found !== undefined) return found;
    }
  }
  return null;
}

const domino = resolveAny(["@mixmark-io/domino", "domino"], ANCHORS);

/**
 * React、react-dom、react/jsx-runtime 三个必须来自同一份、版本配对：
 * react-dom 与 react 版本不一致会抛 "Incompatible React versions"，而
 * React 19 的元素类型符号与 React 18 的 jsx-runtime 也不兼容（渲染时会报
 * "Objects are not valid as a React child"）。所以逐个锚点成对解析，
 * 并用一次最小渲染探针确认这一组确实能用。
 */
let React = null;
let reactServer = null;
let jsxRuntime = null;
for (const anchor of ANCHORS) {
  const req = tryRequire(anchor);
  if (req === null) continue;
  const react = tryCall(() => req("react"));
  const server = tryCall(() => req("react-dom/server"));
  const jsx = tryCall(() => req("react/jsx-runtime"));
  if (react === null || server === null || jsx === null) continue;
  const probe = tryCall(() => {
    server.renderToStaticMarkup(jsx.jsx("div", { children: "probe" }));
    return true;
  });
  if (probe !== true) continue;
  React = react;
  reactServer = server;
  jsxRuntime = jsx;
  break;
}

if (domino === null || React === null || reactServer === null || jsxRuntime === null) {
  const missing = [
    domino === null ? "domino" : null,
    React === null ? "react + react-dom + react/jsx-runtime（同源、能配对）" : null,
  ].filter(Boolean);
  console.log(`跳过客户端验收：找不到 ${missing.join(" / ")}（它们是测试依赖，不在插件运行时依赖里）。`);
  console.log("在仓库根跑一次 `npm install` 即可；或用 DSH_CALLER_REACT_ENTRY / DSH_CALLER_DOMINO_ENTRY 指到别处。");
  process.exit(0);
}

const { renderToStaticMarkup } = reactServer;

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/* ------------------------------------------------------------------ *
 * 假浏览器
 * ------------------------------------------------------------------ */

const document = domino.createDocument("<!doctype html><html><head></head><body></body></html>");

/** domino 查不到时返回 undefined（浏览器返回 null），统一归一成 null。 */
const q = (selector) => document.querySelector(selector) ?? null;
const qa = (selector) => Array.from(document.querySelectorAll(selector));
/** domino 要求派发它自己的 Event 对象。 */
const domEvent = (type) => {
  const event = document.createEvent("Event");
  event.initEvent(type, true, false);
  return event;
};

const storage = new Map();
const listeners = new Map();
const timers = new Map();
let timerSeq = 0;

class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init === undefined ? undefined : init.detail;
  }
}

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  emit(type, payload) {
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
  }
  close() {
    this.closed = true;
  }
}

class FakeAudio {
  static instances = [];
  constructor(src) {
    this.src = src;
    this.volume = 1;
    this.played = false;
    this.paused = true;
    this.currentTime = 0;
    this.loop = false;
    this.listeners = new Map();
    FakeAudio.instances.push(this);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  play() {
    this.played = true;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

const fetches = [];
function fakeFetch(url, options) {
  fetches.push({ url: String(url), options });
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ seq: 0, events: [], aiCallEnabled: true }),
    text: () => Promise.resolve(""),
  });
}

const window = {
  document,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    const list = listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  },
  dispatchEvent(event) {
    for (const handler of listeners.get(event.type) ?? []) handler(event);
    return true;
  },
  setTimeout(callback, delay) {
    timerSeq += 1;
    timers.set(timerSeq, setTimeout(callback, delay));
    return timerSeq;
  },
  clearTimeout(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  },
  setInterval(callback, delay) {
    timerSeq += 1;
    timers.set(timerSeq, setInterval(callback, delay));
    return timerSeq;
  },
  clearInterval(id) {
    clearInterval(timers.get(id));
    timers.delete(id);
  },
  focus() {},
  CustomEvent: FakeCustomEvent,
};

const registrations = [];
window.__ModuleLoader__ = {
  mode: "live",
  pendingQueue: [],
  load(registration) {
    registrations.push(registration);
  },
  create() {},
};

globalThis.window = window;
globalThis.document = document;
globalThis.EventSource = FakeEventSource;
globalThis.Audio = FakeAudio;
globalThis.CustomEvent = FakeCustomEvent;
globalThis.fetch = fakeFetch;
globalThis.Notification = undefined;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 载入 bundle
 * ------------------------------------------------------------------ */

await import(pathToFileURL(BUNDLE).href);

check("bundle 用正确的 id 注册自己", registrations.length === 1 && registrations[0].id === "dsh-caller", registrations.map((r) => r.id).join(","));

const fakeRequire = (specifier) => {
  if (specifier === "react") return React;
  if (specifier === "react/jsx-runtime") return jsxRuntime;
  throw new Error(`意外的 require: ${specifier}`);
};

const exportsObject = registrations[0].factory(fakeRequire);
check("exports.apply / exports.inject 齐备", typeof exportsObject.apply === "function" && Array.isArray(exportsObject.inject) && exportsObject.inject.includes("slots"));

check("建立了一条 SSE 连接", FakeEventSource.instances.length === 1, FakeEventSource.instances[0]?.url);
check("SSE 指向 /api/dsh-caller/stream", FakeEventSource.instances[0]?.url === "/api/dsh-caller/stream");
check("样式已注入", q("style[data-dsh-caller]") !== null);

const source = FakeEventSource.instances[0];

/* ------------------------------------------------------------------ *
 * 设置面板注册
 * ------------------------------------------------------------------ */

const sectionRegistrations = [];
const itemRegistrations = [];
const fakeContext = {
  get(name) {
    if (name !== "slots") return undefined;
    return {
      inject(key, callback) {
        callback();
      },
      register(key, render) {
        if (key.id === "caller") sectionRegistrations.push({ key, render });
        else itemRegistrations.push({ key, render });
        return () => {};
      },
    };
  },
};

exportsObject.apply(fakeContext);

check("注册了且只注册了一个设置栏目", sectionRegistrations.length === 1, `section=${sectionRegistrations.length} item=${itemRegistrations.length}`);
const section = sectionRegistrations[0];
check("栏目 id = caller", section?.key.id === "caller");
check("栏目标题 = 呼叫主人", section?.key.label === "呼叫主人");
check("栏目序号 = 7", section?.key.order === 7);
check("栏目没有额外子 slot（面板只渲染一次）", section?.key.children === undefined);

const markup = renderToStaticMarkup(section.render({}));
const expectedTexts = [
  "允许 AI 呼叫我",
  "弹窗小标题",
  "弹窗文案",
  "弹窗停留",
  "手动关",
  "播放提示音",
  "一直响，直到我关掉弹窗",
  "音频来源",
  "DeepSeek 语音（在线 · 推荐）",
  "系统语音（本机 SAPI）",
  "内置音效",
  "本地音频文件",
  "音色",
  "暗潮 · 男声（tide）",
  "海星 · 女声（stella）",
  "DeepSeek API Key",
  "音量",
  "试听提示音（只响一遍）",
  "同时发送系统通知",
  "立即呼叫（测试）",
  "只预览弹窗",
];
for (const text of expectedTexts) {
  check(`设置面板包含「${text}」`, markup.includes(text));
}
check("面板已去掉「重复次数」（改成循环/单次）", !markup.includes("重复次数"));
check("设置面板只渲染一份（无重复）", markup.split("试听提示音").length - 1 === 1, `出现 ${markup.split("试听提示音").length - 1} 次`);
check("面板默认文案正确", markup.includes("主人，哦鲸鲸找你"));

/* ------------------------------------------------------------------ *
 * SSE 事件 → 弹窗 + 循环提示音 + 关闭停音
 * ------------------------------------------------------------------ */

const popupText = () => q(".dsh-caller-text")?.textContent ?? null;

source.emit("hello", { data: JSON.stringify({ id: 1, aiCallEnabled: true, latest: 7 }) });
await wait(0);
check("hello 后把设置上报给宿主", fetches.some((entry) => entry.url === "/api/dsh-caller/register" && entry.options?.method === "POST"));

source.emit("call", { data: JSON.stringify({ kind: "call", id: 8, text: "测试文案：来一下", reason: "验收", urgent: false }) });
const firstAudio = FakeAudio.instances.at(-1);
check("弹窗显示了事件里的自定义文案", popupText() === "测试文案：来一下", popupText());
check("弹窗带上了 reason 小字", q(".dsh-caller-reason")?.textContent === "验收");
check("默认走 DeepSeek 语音", firstAudio?.src?.startsWith("/api/dsh-caller/deepseek/tts?text=") === true, firstAudio?.src);
check("默认音色是 tide", firstAudio?.src?.includes("voice=tide") === true, firstAudio?.src);
check("音量取设置里的 0.9", firstAudio?.volume === 0.9, String(firstAudio?.volume));
check("默认弹窗小标题是「呼叫」", q(".dsh-caller-title")?.textContent === "呼叫");
check("普通呼叫没有 urgent 样式", q(".dsh-caller-urgent") === null);
check("提示音默认循环播放（一直响）", firstAudio?.loop === true, String(firstAudio?.loop));
check("呼叫时音频确实在播", firstAudio?.paused === false);
check("默认不自动关闭（停留时长 = 0）", q(".dsh-caller-progress") === null);

qa(".dsh-caller-card").at(-1).querySelector(".dsh-caller-ok").dispatchEvent(domEvent("click"));
await wait(400);
check("点「知道啦」后卡片被移除", qa(".dsh-caller-card").length === 0, `cards=${qa(".dsh-caller-card").length}`);
check("点「知道啦」后声音立刻停掉", firstAudio?.paused === true);

/* 省略 text 时用设置里的默认文案；紧急呼叫换样式 */
source.emit("call", { data: JSON.stringify({ kind: "call", id: 9, urgent: true }) });
const urgentCard = q(".dsh-caller-urgent");
check("紧急呼叫弹出一张卡片", qa(".dsh-caller-card").length === 1);
check("紧急呼叫带 urgent 样式", urgentCard !== null);
check("紧急呼叫显示设置里的默认文案", urgentCard?.querySelector(".dsh-caller-text")?.textContent === "主人，哦鲸鲸找你");
check("紧急呼叫改用 🚨", urgentCard?.querySelector(".dsh-caller-emoji")?.textContent === "🚨");
check("紧急呼叫同样是循环响", FakeAudio.instances.at(-1)?.loop === true);

/* silent 只弹窗不响 */
const audioBeforeSilent = FakeAudio.instances.length;
source.emit("call", { data: JSON.stringify({ kind: "call", id: 10, silent: true, text: "安静" }) });
check("silent=true 不产生播放", FakeAudio.instances.length === audioBeforeSilent);
check("silent=true 仍然弹窗", qa(".dsh-caller-card").length === 2);

/* Esc 关掉最上面那张，并且要一起停音 */
const silentCard = qa(".dsh-caller-card").at(-1);
window.dispatchEvent(new FakeCustomEvent("keydown"));
for (const handler of listeners.get("keydown") ?? []) handler({ key: "Escape" });
await wait(400);
check("按 Esc 关掉最上面一张卡片", qa(".dsh-caller-card").length === 1, `cards=${qa(".dsh-caller-card").length}`);
check("Esc 关掉的是最新那张", silentCard.getAttribute("data-dsh-caller-closing") === "1");

/* 关掉「允许 AI 呼叫我」后不再打扰 */
storage.set("dsh-caller:enabled", "0");
const cardsBefore = qa(".dsh-caller-card").length;
source.emit("call", { data: JSON.stringify({ kind: "call", id: 11, text: "不该出现" }) });
check("关闭开关后忽略呼叫事件", qa(".dsh-caller-card").length === cardsBefore);
storage.set("dsh-caller:enabled", "1");

/* 清场 */
for (const card of qa(".dsh-caller-card")) card.querySelector(".dsh-caller-ok").dispatchEvent(domEvent("click"));
await wait(400);
check("清场：之前的卡片都关掉了", qa(".dsh-caller-card").length === 0, `cards=${qa(".dsh-caller-card").length}`);

/* 显式设置了「自动关闭」时才自动关，并且也要停音 */
storage.set("dsh-caller:durationMs", "60");
source.emit("call", { data: JSON.stringify({ kind: "call", id: 12, text: "自动关闭" }) });
const autoAudio = FakeAudio.instances.at(-1);
check("设置了停留时长后卡片带进度条", qa(".dsh-caller-card").at(-1).querySelector(".dsh-caller-progress") !== null);
await wait(500);
check("超时后卡片自动消失", qa(".dsh-caller-card").length === 0, `cards=${qa(".dsh-caller-card").length}`);
check("自动关闭也会停掉声音", autoAudio?.paused === true);
storage.set("dsh-caller:durationMs", "0");

/* 本地音频文件 / 内置音效两条分支 */
storage.set("dsh-caller:soundSource", "file");
storage.set("dsh-caller:filePath", "D:\\sounds\\ding.mp3");
source.emit("call", { data: JSON.stringify({ kind: "call", id: 13, text: "文件音" }) });
check("本地文件分支拼出 /file?path=", decodeURIComponent(FakeAudio.instances.at(-1)?.src ?? "") === "/api/dsh-caller/file?path=D:\\sounds\\ding.mp3", FakeAudio.instances.at(-1)?.src);
check("本地文件分支也循环", FakeAudio.instances.at(-1)?.loop === true);

storage.set("dsh-caller:soundSource", "builtin");
storage.set("dsh-caller:builtin", "chime-soft.wav");
source.emit("call", { data: JSON.stringify({ kind: "call", id: 14, text: "内置音" }) });
check("内置音效分支拼出 /assets?f=", FakeAudio.instances.at(-1)?.src === "/api/dsh-caller/assets?f=chime-soft.wav", FakeAudio.instances.at(-1)?.src);

/* 关掉循环 → 只响一遍 */
storage.set("dsh-caller:loop", "0");
source.emit("call", { data: JSON.stringify({ kind: "call", id: 15, text: "只响一遍" }) });
check("关掉循环后音频不循环", FakeAudio.instances.at(-1)?.loop === false);
storage.set("dsh-caller:loop", "1");

/* 自定义来源失败 → 退回内置音效，并且兜底音也要能被关窗停掉 */
storage.set("dsh-caller:soundSource", "file");
const beforeFallback = FakeAudio.instances.length;
source.emit("call", { data: JSON.stringify({ kind: "call", id: 16, text: "兜底" }) });
const primary = FakeAudio.instances.at(-1);
check("自定义音频先按用户设置播放", primary.src.startsWith("/api/dsh-caller/file?path="), primary.src);
for (const handler of primary.listeners.get("error") ?? []) handler();
const fallbackAudio = FakeAudio.instances.at(-1);
check("自定义音频出错后补一记内置音效", FakeAudio.instances.length === beforeFallback + 2 && fallbackAudio.src === "/api/dsh-caller/assets?f=chime-clear.wav", fallbackAudio.src);
check("兜底音同样循环", fallbackAudio.loop === true);
check("兜底时旧的播放器被掐掉", primary.paused === true);
for (const handler of primary.listeners.get("error") ?? []) handler();
check("兜底只补一次", FakeAudio.instances.length === beforeFallback + 2, `audios=${FakeAudio.instances.length}`);
qa(".dsh-caller-card").at(-1).querySelector(".dsh-caller-ok").dispatchEvent(domEvent("click"));
await wait(400);
check("关掉弹窗后兜底音也停了", fallbackAudio.paused === true);

/* 被新呼叫挤掉的旧卡片必须停音 */
for (const card of qa(".dsh-caller-card")) card.querySelector(".dsh-caller-ok").dispatchEvent(domEvent("click"));
await wait(400);
storage.set("dsh-caller:soundSource", "builtin");
const squeezed = [];
for (let index = 0; index < 4; index += 1) {
  source.emit("call", { data: JSON.stringify({ kind: "call", id: 20 + index, text: `第 ${index + 1} 次` }) });
  squeezed.push(FakeAudio.instances.at(-1));
}
const stillOpen = qa(".dsh-caller-card").filter((card) => card.getAttribute("data-dsh-caller-closing") !== "1");
check("最多同时挂 3 张卡片（多出来的正在淡出）", stillOpen.length === 3, `alive=${stillOpen.length} total=${qa(".dsh-caller-card").length}`);
check("被挤掉的卡片声音也停了", squeezed[0]?.paused === true && squeezed[1]?.paused === false);

/* 损坏的 JSON 不能让运行时崩掉 */
try {
  source.emit("call", { data: "{ this is not json" });
  check("坏事件不会打挂运行时", true);
} catch (error) {
  check("坏事件不会打挂运行时", false, String(error));
}

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
