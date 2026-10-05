/**
 * dsh-caller 客户端插件：把「呼叫主人」装进 DSH。
 *
 * 两件事：
 *   1. 往设置面板注册一个「呼叫主人」栏目（settings.section / id=caller），
 *      音频、音量、文案、停留时长全在里面改，存 localStorage（dsh-caller:*）；
 *   2. 常驻一条到宿主的 SSE 通道，收到 call 事件就弹窗 + 播提示音。
 *
 * 零侵入：不读业务 DOM、不改内置包文件、无外部请求，所有资源都来自本插件宿主路由。
 */
window.__ModuleLoader__.load({
  id: "dsh-caller",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var jsxRuntime = require("react/jsx-runtime");
    var rawJsx = jsxRuntime.jsx;
    var rawJsxs = jsxRuntime.jsxs;

    /**
     * React 只认「数组里元素自带 key」，而这里满屏都是静态 children 数组。
     * 与其给每个数组项手写 key，不如在 jsx/jsxs 的入口统一补一次，顺手消掉开发期告警。
     */
    function keyedChildren(children) {
      return children.map(function (item, index) {
        if (!React.isValidElement(item) || item.key !== undefined && item.key !== null) return item;
        return React.cloneElement(item, { key: "dsh-caller-" + index });
      });
    }

    function jsx(type, props, key) {
      var next = props;
      if (next !== null && typeof next === "object" && Array.isArray(next.children)) {
        next = Object.assign({}, next, { children: keyedChildren(next.children) });
      }
      return key === undefined ? rawJsx(type, next) : rawJsx(type, next, key);
    }

    function jsxs(type, props, key) {
      var next = props;
      if (next !== null && typeof next === "object" && Array.isArray(next.children)) {
        next = Object.assign({}, next, { children: keyedChildren(next.children) });
      }
      return key === undefined ? rawJsxs(type, next) : rawJsxs(type, next, key);
    }

    /* ================================================================ *
     * 常量与配置读写
     * ================================================================ */

    var BASE = "/api/dsh-caller";
    var NS = "dsh-caller:";
    var CHANGE = "dsh-caller:change";
    var RUNTIME_FLAG = "__dshCallerRuntime";

    var DEFAULTS = {
      /** 允许 AI（模型工具 call_owner）呼叫我 */
      enabled: "1",
      /** 弹窗小标题 */
      title: "呼叫",
      /** 弹窗主文案 */
      text: "主人，人家有事找你",
      /** 播放提示音 */
      soundOn: "1",
      /** tts = 用系统语音朗读当前文案；builtin = 内置音效；file = 本地音频文件 */
      soundSource: "tts",
      /** soundSource=builtin 时选中的内置音频 */
      builtin: "chime-clear.wav",
      /** soundSource=file 时的本地音频绝对路径 */
      filePath: "",
      /** 音量 0~1 */
      volume: "0.9",
      /** 一直响到主人手动关闭弹窗为止；关掉就只响一遍 */
      loop: "1",
      /** 语音语速 -10~10 */
      voiceRate: "0",
      /** 指定语音音色名，留空用系统默认中文音色 */
      voice: "",
      /** 弹窗停留毫秒数，0 = 不自动关闭（必须主人手动关） */
      durationMs: "0",
      /** 同时发系统通知 */
      notify: "0",
    };

    function readPref(key) {
      try {
        var value = window.localStorage.getItem(NS + key);
        return value === null ? DEFAULTS[key] : value;
      } catch (error) {
        return DEFAULTS[key];
      }
    }

    function writePref(key, value) {
      try {
        window.localStorage.setItem(NS + key, String(value));
      } catch (error) {
        /* 隐私模式下写不进去也不该影响功能 */
      }
      try {
        window.dispatchEvent(new CustomEvent(CHANGE, { detail: { key: key, value: String(value) } }));
      } catch (error) {
        /* 事件派发失败只影响面板刷新 */
      }
    }

    function readConfig() {
      var config = {};
      for (var key in DEFAULTS) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) config[key] = readPref(key);
      }
      return config;
    }

    function clamp01(value) {
      var number = typeof value === "number" ? value : Number.parseFloat(value);
      if (!Number.isFinite(number)) return 0.9;
      return Math.max(0, Math.min(1, number));
    }

    /* ================================================================ *
     * 样式
     * ================================================================ */

    var CSS = [
      ".dsh-caller-root{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;gap:12px;padding:11vh 16px 16px;pointer-events:none;font-family:inherit;-webkit-font-smoothing:antialiased}",
      ".dsh-caller-card{pointer-events:auto;position:relative;width:min(432px,92vw);box-sizing:border-box;border-radius:20px;padding:18px 20px 16px;display:flex;flex-direction:column;overflow:hidden;",
      "background:var(--dsw-alias-bg-overlay,#ffffff);color:var(--dsw-alias-label-primary,#1b1b1f);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.10));",
      "box-shadow:0 18px 48px -12px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.08);animation:dsh-caller-in .34s cubic-bezier(.16,1.15,.3,1) both}",
      ".dsh-caller-card.dsh-caller-urgent{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 18px 56px -10px rgba(77,107,254,.55),0 2px 8px rgba(0,0,0,.10)}",
      ".dsh-caller-card.dsh-caller-out{animation:dsh-caller-out .2s ease-in both}",
      "@keyframes dsh-caller-in{from{opacity:0;transform:translateY(-14px) scale(.94)}to{opacity:1;transform:none}}",
      "@keyframes dsh-caller-out{to{opacity:0;transform:translateY(-10px) scale(.96)}}",
      ".dsh-caller-main{display:flex;gap:12px;align-items:flex-start}",
      ".dsh-caller-emoji{font-size:28px;line-height:1.15;transform-origin:50% 15%;animation:dsh-caller-bell 1.5s ease-in-out 2}",
      "@keyframes dsh-caller-bell{0%,100%{transform:rotate(0)}15%{transform:rotate(-16deg)}30%{transform:rotate(14deg)}45%{transform:rotate(-10deg)}60%{transform:rotate(8deg)}75%{transform:rotate(-4deg)}}",
      ".dsh-caller-body{flex:1;min-width:0}",
      ".dsh-caller-title{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,#6b6f7a);margin-bottom:4px}",
      ".dsh-caller-text{font-size:16px;font-weight:600;line-height:1.5;white-space:pre-wrap;word-break:break-word}",
      ".dsh-caller-reason{margin-top:6px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b6f7a);white-space:pre-wrap;word-break:break-word}",
      ".dsh-caller-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}",
      ".dsh-caller-ok{border:none;border-radius:10px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}",
      ".dsh-caller-ok:hover{filter:brightness(1.06)}",
      ".dsh-caller-progress{position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--dsw-alias-brand-primary,#4d6bfe);transform-origin:left;animation-name:dsh-caller-shrink;animation-timing-function:linear;animation-fill-mode:forwards}",
      "@keyframes dsh-caller-shrink{from{transform:scaleX(1)}to{transform:scaleX(0)}}",
    ].join("");

    function injectStyles() {
      // 用宽松比较：某些环境（以及无头 DOM）查不到时返回 undefined 而不是 null。
      if (document.querySelector("style[data-dsh-caller]") != null) return;
      var style = document.createElement("style");
      style.setAttribute("data-dsh-caller", "css");
      style.textContent = CSS;
      (document.head ?? document.documentElement).appendChild(style);
    }

    /* ================================================================ *
     * 弹窗
     * ================================================================ */

    var popupHost = null;

    function ensurePopupHost() {
      if (popupHost !== null && popupHost.parentNode !== null) return popupHost;
      popupHost = document.createElement("div");
      popupHost.className = "dsh-caller-root";
      popupHost.setAttribute("data-dsh-caller", "root");
      (document.body ?? document.documentElement).appendChild(popupHost);
      return popupHost;
    }

    function dismissCard(card) {
      if (card.getAttribute("data-dsh-caller-closing") === "1") return;
      card.setAttribute("data-dsh-caller-closing", "1");
      if (card._dshCallerTimer !== undefined) window.clearTimeout(card._dshCallerTimer);
      // 先掐声音再淡出：呼叫是「一直叫到主人手动关掉」，关掉就必须立刻安静。
      var onDismiss = card._dshCallerOnDismiss;
      card._dshCallerOnDismiss = undefined;
      if (typeof onDismiss === "function") {
        try {
          onDismiss();
        } catch (error) {
          /* 停音失败也不能把卡片卡在屏幕上 */
        }
      }
      card.classList.add("dsh-caller-out");
      window.setTimeout(function () {
        card.remove();
        if (popupHost !== null && popupHost.childElementCount === 0) popupHost.hidden = true;
      }, 220);
    }

    function onEscape(event) {
      if (event.key !== "Escape" || popupHost === null) return;
      var cards = popupHost.querySelectorAll(".dsh-caller-card:not(.dsh-caller-out)");
      if (cards.length === 0) return;
      dismissCard(cards[cards.length - 1]);
    }

    /**
     * 弹出一个呼叫窗口。文案一律用 textContent 写入，模型给什么就显示什么，绝不解释成 HTML。
     * @returns 该卡片的关闭函数。
     */
    function showPopup(options) {
      injectStyles();
      var host = ensurePopupHost();
      host.hidden = false;

      var card = document.createElement("div");
      card.className = "dsh-caller-card" + (options.urgent ? " dsh-caller-urgent" : "");

      var main = document.createElement("div");
      main.className = "dsh-caller-main";

      var emoji = document.createElement("div");
      emoji.className = "dsh-caller-emoji";
      emoji.textContent = options.urgent ? "🚨" : "🔔";

      var body = document.createElement("div");
      body.className = "dsh-caller-body";

      if (options.title) {
        var title = document.createElement("div");
        title.className = "dsh-caller-title";
        title.textContent = options.title;
        body.appendChild(title);
      }
      var text = document.createElement("div");
      text.className = "dsh-caller-text";
      text.textContent = options.text;
      body.appendChild(text);

      if (options.reason) {
        var reason = document.createElement("div");
        reason.className = "dsh-caller-reason";
        reason.textContent = options.reason;
        body.appendChild(reason);
      }

      main.appendChild(emoji);
      main.appendChild(body);

      var actions = document.createElement("div");
      actions.className = "dsh-caller-actions";
      var ok = document.createElement("button");
      ok.type = "button";
      ok.className = "dsh-caller-ok";
      ok.textContent = "知道啦";
      actions.appendChild(ok);

      card.appendChild(main);
      card.appendChild(actions);
      card._dshCallerOnDismiss = typeof options.onDismiss === "function" ? options.onDismiss : undefined;

      if (options.durationMs > 0) {
        var progress = document.createElement("div");
        progress.className = "dsh-caller-progress";
        progress.style.animationDuration = options.durationMs + "ms";
        card.appendChild(progress);
      }

      host.appendChild(card);
      ok.addEventListener("click", function () {
        dismissCard(card);
      });
      try {
        ok.focus({ preventScroll: true });
      } catch (error) {
        /* 某些环境不认 focus 选项，不影响弹窗 */
      }
      if (options.durationMs > 0) {
        card._dshCallerTimer = window.setTimeout(function () {
          dismissCard(card);
        }, options.durationMs);
      }
      // 最多同时挂 3 张，再多就把最老的挤掉（连带停掉它的声音），避免无限叠加。
      // 只数「还开着」的卡片：正在淡出的不算，否则连点几下会把新卡片也一起挤掉。
      var alive = [];
      var mounted = host.querySelectorAll(".dsh-caller-card");
      for (var index = 0; index < mounted.length; index += 1) {
        if (mounted[index].getAttribute("data-dsh-caller-closing") !== "1") alive.push(mounted[index]);
      }
      for (var extra = 0; extra < alive.length - 3; extra += 1) dismissCard(alive[extra]);
      return function () {
        dismissCard(card);
      };
    }

    /* ================================================================ *
     * 提示音
     * ================================================================ */

    function soundSrc(config, text) {
      if (config.soundSource === "file") {
        var filePath = (config.filePath || "").trim();
        if (filePath === "") return null;
        return BASE + "/file?path=" + encodeURIComponent(filePath);
      }
      if (config.soundSource === "tts") {
        var spoken = (text || config.text || "").trim();
        if (spoken === "") return null;
        var query = "?text=" + encodeURIComponent(spoken) + "&rate=" + encodeURIComponent(config.voiceRate || "0");
        if ((config.voice || "").trim() !== "") query += "&voice=" + encodeURIComponent(config.voice.trim());
        return BASE + "/tts" + query;
      }
      var name = config.builtin || "chime-clear.wav";
      return BASE + "/assets?f=" + encodeURIComponent(name);
    }

    function noop() {}

    /**
     * 播放提示音。默认一直循环，直到主人手动关掉弹窗——所以这里返回一个 stop()，
     * 由弹窗的关闭路径负责调用：点「知道啦」、按 Esc、超时自动关、被新呼叫挤掉，都会停。
     * @returns 停止播放的函数（可以安全地重复调用）。
     */
    function playSound(config, text) {
      if (config.soundOn === "0") return noop;
      var volume = clamp01(config.volume);
      var loop = config.loop !== "0";
      var stopped = false;
      var fellBack = false;
      var current = null;

      var silence = function (audio) {
        if (audio === null) return;
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch (error) {
          /* ignore */
        }
      };

      /** @returns 是否成功起了播放器。 */
      var start = function (url) {
        if (stopped) return false;
        var audio;
        try {
          audio = new Audio(url);
        } catch (error) {
          return false;
        }
        audio.loop = loop;
        audio.volume = volume;
        current = audio;
        audio.addEventListener("error", function () {
          if (!stopped) fallback();
        });
        try {
          var promise = audio.play();
          if (promise && typeof promise.catch === "function") {
            promise.catch(function () {
              if (!stopped) fallback();
            });
          }
        } catch (error) {
          if (!stopped) fallback();
        }
        return true;
      };

      /** 用户设置的音源放不出来时，退到内置音效，保证「叫得动」。 */
      var fallback = function () {
        if (stopped || fellBack) return;
        fellBack = true;
        silence(current);
        current = null;
        start(BASE + "/assets?f=" + encodeURIComponent("chime-clear.wav"));
      };

      var src = soundSrc(config, text);
      if (src === null || !start(src)) fallback();

      return function () {
        stopped = true;
        silence(current);
        current = null;
      };
    }

    /* ================================================================ *
     * 宿主通道：SSE 为主，轮询兜底
     * ================================================================ */

    var transport = { source: null, poll: null, since: 0, sawHello: false };

    function registerWithHost() {
      var config = readConfig();
      try {
        var promise = fetch(BASE + "/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aiCallEnabled: config.enabled !== "0" }),
        });
        if (promise && typeof promise.catch === "function") promise.catch(function () {});
      } catch (error) {
        /* 上报失败只影响工具回执的准确性 */
      }
    }

    function notifySystem(config, text) {
      if (config.notify !== "1") return;
      try {
        if (typeof Notification === "undefined") return;
        if (Notification.permission === "granted") {
          new Notification(config.title || "呼叫", { body: text });
        }
      } catch (error) {
        /* 系统通知是可选增强 */
      }
    }

    function handleCallEvent(event) {
      if (!event || event.kind !== "call") return;
      if (typeof event.id === "number" && event.id > transport.since) transport.since = event.id;
      var config = readConfig();
      if (config.enabled === "0") return;

      var duration = Number.parseInt(config.durationMs, 10);
      if (!Number.isFinite(duration) || duration < 0) duration = 0;
      // 只有明确设了「自动关闭」才给紧急呼叫加时；0 = 一直挂着等主人手动关。
      if (event.urgent && duration > 0) duration = Math.max(duration, 15000);

      var text = String(event.text || config.text || "").trim() || "主人，人家有事找你";
      // 先起声音再弹窗：关窗那一刻就能把同一个播放器掐掉。
      var stopSound = event.silent === true ? null : playSound(config, text);
      showPopup({
        title: config.title,
        text: text,
        reason: typeof event.reason === "string" ? event.reason : "",
        urgent: event.urgent === true,
        durationMs: duration,
        onDismiss: stopSound === null ? undefined : stopSound,
      });
      notifySystem(config, text);
      try {
        window.focus();
      } catch (error) {
        /* 抢焦点失败无所谓，弹窗已经在了 */
      }
    }

    function stopPolling() {
      if (transport.poll === null) return;
      window.clearInterval(transport.poll);
      transport.poll = null;
    }

    function startPolling() {
      if (transport.poll !== null) return;
      var tick = function () {
        fetch(BASE + "/poll?since=" + transport.since)
          .then(function (response) {
            return response.json();
          })
          .then(function (data) {
            if (!data) return;
            if (Array.isArray(data.events)) {
              for (var index = 0; index < data.events.length; index += 1) handleCallEvent(data.events[index]);
            }
            if (typeof data.seq === "number" && data.seq > transport.since) transport.since = data.seq;
          })
          .catch(function () {});
      };
      // 先对齐一次序号，免得把历史呼叫当成新呼叫补弹一遍。
      fetch(BASE + "/poll?since=999999999")
        .then(function (response) {
          return response.json();
        })
        .then(function (data) {
          if (data && typeof data.seq === "number") transport.since = Math.max(transport.since, data.seq);
        })
        .catch(function () {})
        .then(function () {
          if (transport.poll !== null) return;
          transport.poll = window.setInterval(tick, 1500);
        });
    }

    function connectStream() {
      if (typeof EventSource === "undefined") {
        startPolling();
        return;
      }
      var source;
      try {
        source = new EventSource(BASE + "/stream");
      } catch (error) {
        startPolling();
        return;
      }
      transport.source = source;
      source.addEventListener("hello", function (message) {
        transport.sawHello = true;
        stopPolling();
        try {
          var payload = JSON.parse(message.data);
          if (payload && typeof payload.latest === "number" && payload.latest > transport.since) {
            transport.since = payload.latest;
          }
        } catch (error) {
          /* hello 解析失败不影响后续 call */
        }
        registerWithHost();
      });
      source.addEventListener("call", function (message) {
        try {
          handleCallEvent(JSON.parse(message.data));
        } catch (error) {
          console.warn("[dsh-caller] 呼叫事件解析失败", error);
        }
      });
      source.addEventListener("error", function () {
        // EventSource 自己会重连；只要还没握上手，就先靠轮询兜住。
        if (!transport.sawHello) startPolling();
      });
    }

    function startRuntime() {
      if (window[RUNTIME_FLAG] === true) return;
      window[RUNTIME_FLAG] = true;
      injectStyles();
      window.addEventListener(CHANGE, registerWithHost);
      window.addEventListener("keydown", onEscape);
      connectStream();
    }

    /* ================================================================ *
     * 设置面板
     * ================================================================ */

    var ROW = {
      alignItems: "center",
      borderBottom: "1px solid var(--dsw-alias-border-l1, #eef0f4)",
      display: "flex",
      gap: "12px",
      justifyContent: "space-between",
      padding: "10px 0",
    };
    var CARD = {
      border: "1px solid var(--dsw-alias-border-l2, #e3e6ec)",
      borderRadius: "14px",
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      marginTop: "10px",
      padding: "10px 14px 12px",
      width: "100%",
    };
    var CARD_TITLE = {
      color: "var(--dsw-alias-label-secondary, #6b6f7a)",
      fontSize: "12px",
      fontWeight: 600,
      paddingBottom: "2px",
    };
    var HINT = {
      color: "var(--dsw-alias-label-secondary, #6b6f7a)",
      fontSize: "11px",
      lineHeight: "15px",
      maxWidth: "260px",
    };
    var INPUT = {
      background: "var(--dsw-alias-bg-layer-1, transparent)",
      border: "1px solid var(--dsw-alias-border-l2, #d8dbe3)",
      borderRadius: "8px",
      boxSizing: "border-box",
      color: "inherit",
      flex: "0 1 240px",
      fontFamily: "inherit",
      fontSize: "13px",
      minWidth: 0,
      padding: "6px 8px",
    };

    function useConfig() {
      var pair = React.useState(readConfig);
      var setConfig = pair[1];
      React.useEffect(function () {
        var sync = function () {
          setConfig(readConfig());
        };
        window.addEventListener(CHANGE, sync);
        return function () {
          window.removeEventListener(CHANGE, sync);
        };
      }, []);
      return pair[0];
    }

    function Button(props) {
      var style = {
        background: props.primary ? "var(--dsw-alias-brand-primary, #4d6bfe)" : "var(--dsw-alias-bg-layer-1, transparent)",
        border: props.primary ? "1px solid transparent" : "1px solid var(--dsw-alias-border-l2, #d8dbe3)",
        borderRadius: "10px",
        color: props.primary ? "#fff" : "inherit",
        cursor: "pointer",
        flex: "0 0 auto",
        fontFamily: "inherit",
        fontSize: "13px",
        padding: "6px 12px",
      };
      return jsx("button", { type: "button", style: style, onClick: props.onClick, children: props.children });
    }

    function Card(props) {
      return jsxs("div", {
        style: CARD,
        children: [
          jsx("div", { style: CARD_TITLE, children: props.title }),
          props.children,
        ],
      });
    }

    function Toggle(props) {
      var config = useConfig();
      var on = config[props.pref] !== "0";
      return jsxs("div", {
        style: ROW,
        children: [
          jsxs("div", {
            style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
            children: [
              jsx("span", { children: props.label }),
              props.hint ? jsx("span", { style: HINT, children: props.hint }) : null,
            ],
          }),
          jsx("button", {
            type: "button",
            role: "switch",
            "aria-checked": on,
            "aria-label": props.label,
            onClick: function (event) {
              event.preventDefault();
              event.stopPropagation();
              writePref(props.pref, on ? "0" : "1");
              if (props.onChange) props.onChange(!on);
            },
            style: {
              alignItems: "center",
              background: on ? "var(--dsw-alias-brand-primary, #4d6bfe)" : "var(--dsw-alias-border-l2, #c9cdd6)",
              border: "none",
              borderRadius: "999px",
              cursor: "pointer",
              display: "flex",
              flex: "0 0 auto",
              height: "24px",
              justifyContent: on ? "flex-end" : "flex-start",
              padding: "3px",
              transition: "background 160ms ease",
              width: "44px",
            },
            children: jsx("span", {
              style: {
                background: "#fff",
                borderRadius: "50%",
                boxShadow: "0 1px 3px rgb(0 0 0 / 25%)",
                height: "18px",
                width: "18px",
              },
            }),
          }),
        ],
      });
    }

    function TextRow(props) {
      var config = useConfig();
      return jsxs("label", {
        style: ROW,
        children: [
          jsx("span", { style: { minWidth: 0 }, children: props.label }),
          jsx("input", {
            type: "text",
            value: config[props.pref],
            placeholder: props.placeholder || "",
            maxLength: props.maxLength || 300,
            onChange: function (event) {
              writePref(props.pref, event.target.value);
            },
            style: INPUT,
          }),
        ],
      });
    }

    function AreaRow(props) {
      var config = useConfig();
      return jsxs("label", {
        style: { display: "flex", flexDirection: "column", gap: "6px", padding: "10px 0" },
        children: [
          jsx("span", { children: props.label }),
          jsx("textarea", {
            value: config[props.pref],
            placeholder: props.placeholder || "",
            maxLength: props.maxLength || 300,
            rows: props.rows || 2,
            onChange: function (event) {
              writePref(props.pref, event.target.value);
            },
            style: Object.assign({}, INPUT, { flex: "1 1 auto", resize: "vertical", width: "100%" }),
          }),
        ],
      });
    }

    function SelectRow(props) {
      var config = useConfig();
      return jsxs("label", {
        style: ROW,
        children: [
          jsx("span", { children: props.label }),
          jsx("select", {
            value: config[props.pref],
            onChange: function (event) {
              writePref(props.pref, event.target.value);
            },
            style: Object.assign({}, INPUT, { cursor: "pointer", flex: "0 1 220px" }),
            children: props.options.map(function (option) {
              return jsx("option", { value: option.value, children: option.label }, option.value);
            }),
          }),
        ],
      });
    }

    function RangeRow(props) {
      var config = useConfig();
      var raw = Number.parseFloat(config[props.pref]);
      var value = Number.isFinite(raw) ? raw : props.fallback;
      return jsxs("label", {
        style: ROW,
        children: [
          jsx("span", { children: props.label }),
          jsxs("div", {
            style: { alignItems: "center", display: "flex", flex: "0 1 240px", gap: "10px", minWidth: 0 },
            children: [
              jsx("input", {
                type: "range",
                min: props.min,
                max: props.max,
                step: props.step,
                value: value,
                onChange: function (event) {
                  writePref(props.pref, event.target.value);
                },
                style: { flex: "1 1 auto", minWidth: 0 },
              }),
              jsx("span", {
                style: Object.assign({}, HINT, { flex: "0 0 auto", maxWidth: "none", minWidth: "46px", textAlign: "right" }),
                children: props.format(value),
              }),
            ],
          }),
        ],
      });
    }

    function CallerPanel() {
      var config = useConfig();
      var fileRef = React.useRef(null);
      var statePair = React.useState("");
      var status = statePair[0];
      var setStatus = statePair[1];

      var popupText = function () {
        return (config.text || "").trim() || "主人，人家有事找你";
      };

      var popupDuration = function () {
        var duration = Number.parseInt(config.durationMs, 10);
        return !Number.isFinite(duration) || duration < 0 ? 0 : duration;
      };

      /** 只预览弹窗：不出声，也不自动关，方便慢慢看样式。 */
      var preview = function () {
        showPopup({ title: config.title, text: popupText(), durationMs: 0 });
      };

      /** 试听只响一遍，不然在设置页里会一直响下去。 */
      var previewSound = function () {
        playSound(Object.assign({}, readConfig(), { loop: "0" }), popupText());
      };

      /** 完整来一次呼叫：一直响 + 弹窗，直到主人手动关掉为止。 */
      var callNow = function () {
        var current = readConfig();
        var stop = current.soundOn === "0" ? noop : playSound(current, popupText());
        showPopup({
          title: current.title,
          text: popupText(),
          durationMs: popupDuration(),
          onDismiss: stop,
        });
      };

      var pickFile = function () {
        if (fileRef.current !== null) fileRef.current.click();
      };

      var onFilePicked = function (event) {
        var file = event.target.files && event.target.files[0];
        event.target.value = "";
        if (!file) return;
        setStatus("⏳ 正在导入 " + file.name + " …");
        fetch(BASE + "/upload?name=" + encodeURIComponent(file.name), { method: "POST", body: file })
          .then(function (response) {
            return response.json().then(function (data) {
              return { ok: response.ok, data: data };
            });
          })
          .then(function (result) {
            if (!result.ok || !result.data || typeof result.data.path !== "string") {
              throw new Error((result.data && result.data.error) || "导入失败");
            }
            writePref("filePath", result.data.path);
            writePref("soundSource", "file");
            setStatus("✅ 已导入：" + result.data.path);
          })
          .catch(function (error) {
            setStatus("❌ 导入失败：" + String((error && error.message) || error));
          });
      };

      var enableNotification = function (next) {
        if (!next) return;
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "default") {
            Notification.requestPermission().catch(function () {});
          }
        } catch (error) {
          /* 通知是可选增强 */
        }
      };

      return jsxs("div", {
        style: { display: "flex", flexDirection: "column", paddingBottom: "20px", width: "100%" },
        children: [
          jsxs("div", {
            style: { color: "var(--dsw-alias-label-secondary, #6b6f7a)", fontSize: "13px", lineHeight: "20px", paddingTop: "4px" },
            children: [
              "需要你本人回来的时候，让 DSH 弹窗并出声喊你。模型可以用工具 ",
              jsx("code", { children: "call_owner" }),
              " 触发；你也可以用下面的按钮随时试一次。",
            ],
          }),

          jsx(Card, {
            title: "呼叫方式",
            children: [
              jsx(Toggle, {
                pref: "enabled",
                label: "允许 AI 呼叫我",
                hint: "关掉之后，模型调用 call_owner 不会弹窗、也不会出声。",
              }),
              jsx(TextRow, { pref: "title", label: "弹窗小标题", placeholder: "呼叫", maxLength: 24 }),
              jsx(AreaRow, {
                pref: "text",
                label: "弹窗文案（默认：主人，人家有事找你）",
                placeholder: "主人，人家有事找你",
                maxLength: 300,
                rows: 2,
              }),
              jsx(RangeRow, {
                pref: "durationMs",
                label: "弹窗停留",
                min: 0,
                max: 60000,
                step: 1000,
                fallback: 0,
                format: function (value) {
                  return value <= 0 ? "手动关" : Math.round(value / 1000) + " 秒后自动关";
                },
              }),
            ],
          }),

          jsx(Card, {
            title: "提示音",
            children: [
              jsx(Toggle, { pref: "soundOn", label: "播放提示音" }),
              jsx(Toggle, {
                pref: "loop",
                label: "一直响，直到我关掉弹窗",
                hint: "呼叫会循环播放提示音，你不点「知道啦」它就一直在响；关掉则只响一遍。",
              }),
              jsx(SelectRow, {
                pref: "soundSource",
                label: "音频来源",
                options: [
                  { value: "tts", label: "系统语音朗读当前文案" },
                  { value: "builtin", label: "内置音效" },
                  { value: "file", label: "本地音频文件" },
                ],
              }),
              config.soundSource === "builtin"
                ? jsx(SelectRow, {
                    pref: "builtin",
                    label: "选择音效",
                    options: [
                      { value: "chime-clear.wav", label: "清脆门铃" },
                      { value: "chime-soft.wav", label: "柔和木琴" },
                      { value: "chime-urgent.wav", label: "急促三连" },
                      { value: "voice-default.wav", label: "女声：主人，人家有事找你" },
                    ],
                  })
                : null,
              config.soundSource === "tts"
                ? jsxs("div", {
                    style: ROW,
                    children: [
                      jsxs("div", {
                        style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
                        children: [
                          jsx("span", { children: "语音音色（可选）" }),
                          jsx("span", { style: HINT, children: "想换音色就在这里填系统语音名，留空用默认中文音色。" }),
                        ],
                      }),
                      jsx("input", {
                        type: "text",
                        value: config.voice,
                        placeholder: "Microsoft Huihui Desktop",
                        onChange: function (event) {
                          writePref("voice", event.target.value);
                        },
                        style: INPUT,
                      }),
                    ],
                  })
                : null,
              config.soundSource === "tts"
                ? jsx(RangeRow, {
                    pref: "voiceRate",
                    label: "语速",
                    min: -10,
                    max: 10,
                    step: 1,
                    fallback: 0,
                    format: function (value) {
                      return value > 0 ? "+" + value : String(value);
                    },
                  })
                : null,
              config.soundSource === "file"
                ? jsxs("div", {
                    style: { display: "flex", flexDirection: "column", gap: "6px", padding: "10px 0" },
                    children: [
                      jsx("span", { children: "音频文件" }),
                      jsxs("div", {
                        style: { alignItems: "center", display: "flex", gap: "8px" },
                        children: [
                          jsx("input", {
                            type: "text",
                            value: config.filePath,
                            placeholder: "D:\\sounds\\ding.mp3",
                            onChange: function (event) {
                              writePref("filePath", event.target.value);
                            },
                            style: Object.assign({}, INPUT, { flex: "1 1 auto" }),
                          }),
                          jsx(Button, { onClick: pickFile, children: "选择文件…" }),
                        ],
                      }),
                      jsx("span", { style: HINT, children: "支持 wav / mp3 / m4a / aac / ogg / opus / flac / webm，也可以直接粘贴绝对路径。" }),
                    ],
                  })
                : null,
              jsx(RangeRow, {
                pref: "volume",
                label: "音量",
                min: 0,
                max: 1,
                step: 0.05,
                fallback: 0.9,
                format: function (value) {
                  return Math.round(value * 100) + "%";
                },
              }),
              jsx("div", {
                style: Object.assign({}, ROW, { borderBottom: "none", justifyContent: "flex-start" }),
                children: jsx(Button, { onClick: previewSound, children: "试听提示音（只响一遍）" }),
              }),
            ],
          }),

          jsx(Card, {
            title: "提醒方式",
            children: [
              jsx(Toggle, {
                pref: "notify",
                label: "同时发送系统通知",
                hint: "窗口不在最前面时，用 Windows 通知再提醒一次。",
                onChange: enableNotification,
              }),
              jsxs("div", {
                style: Object.assign({}, ROW, { borderBottom: "none", flexWrap: "wrap", justifyContent: "flex-start" }),
                children: [
                  jsx(Button, { onClick: callNow, primary: true, children: "立即呼叫（测试）" }),
                  jsx(Button, { onClick: preview, children: "只预览弹窗" }),
                ],
              }),
              status === ""
                ? null
                : jsx("div", { style: Object.assign({}, HINT, { maxWidth: "none", paddingBottom: "8px", wordBreak: "break-all" }), children: status }),
            ],
          }),

          jsx("input", {
            ref: fileRef,
            type: "file",
            accept: "audio/*",
            style: { display: "none" },
            onChange: onFilePicked,
          }),
        ],
      });
    }

    function registerSettings(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined) {
        console.warn("[dsh-caller] slots 服务不可用，跳过设置面板注册（弹窗与提示音不受影响）");
        return;
      }
      slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "caller", order: 7, label: "呼叫主人" },
          function () {
            return jsx(CallerPanel, {});
          },
        );
      });
    }

    function apply(ctx) {
      try {
        startRuntime();
      } catch (error) {
        console.warn("[dsh-caller] 运行时启动失败", error);
      }
      try {
        registerSettings(ctx);
      } catch (error) {
        console.warn("[dsh-caller] 设置面板注册失败（弹窗与提示音不受影响）", error);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots"];

    startRuntime();
    return module.exports;
  },
});
