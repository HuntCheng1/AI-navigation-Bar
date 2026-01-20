(() => {
  const ROOT_ID = "cgpt-nav-root";
  const STORE_KEY = "cgpt_nav_meta_v1";

  // 防止 SPA 重复注入
  if (window.__cgptNavInited) return;
  window.__cgptNavInited = true;

  const state = {
    meta: { items: {} }, // key -> { name?: string, fav?: boolean }
    showOnlyFav: false,
    lastSig: "",
    observer: null,
    timer: null,
    url: location.href
  };

  const isGemini = location.hostname.includes("gemini.google.com");

  function normalizeSpaces(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function stripUiPrefixes(t) {
    // “你说/You said”等常见 UI/无障碍前缀，通常不是用户真实输入
    return (t || "")
      .replace(/^(你说|我说|你说过|我说过)\s*[:：]\s*/i, "")
      .replace(/^(you said|you wrote)\s*[:：]\s*/i, "")
      .replace(/^(chatgpt said|assistant|gemini said)\s*[:：]\s*/i, "");
  }

  function getTextFromMessage(node) {
    if (!node) return "";
    let content;

    if (isGemini) {
      // Gemini 文本提取
      content = node.querySelector(".message-content") || node;
    } else {
      // ChatGPT
      content =
        node.querySelector?.(".markdown") ||
        node.querySelector?.(".prose") ||
        node;
    }

    let t = normalizeSpaces(content?.innerText || "");
    t = stripUiPrefixes(t);
    return t;
  }

  function hashString(str) {
    let h = 2166136261; // FNV-1a
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function getRole(node) {
    if (isGemini) {
      const tag = node.tagName.toLowerCase();
      if (tag === "user-query" || node.getAttribute("data-test-id") === "user-query") return "user";
      if (tag === "model-response" || node.getAttribute("data-test-id") === "model-response") return "assistant";
      if (node.querySelector("user-query")) return "user";
      if (node.querySelector("model-response")) return "assistant";
      return "unknown";
    }

    return (
      node.getAttribute?.("data-message-author-role") ||
      node.querySelector?.("[data-message-author-role]")?.getAttribute?.("data-message-author-role") ||
      ""
    );
  }

  // 多路探测消息 turn
  function findMessageNodes() {
    const main = document.querySelector("main") || document.body;

    if (isGemini) {
      // Gemini 策略
      // 1. 尝试找 custom elements
      const candidates = Array.from(main.querySelectorAll("user-query, model-response"));
      if (candidates.length) return candidates;
      // 2. 尝试找 data-test-id
      const dataTestIds = Array.from(main.querySelectorAll('[data-test-id="user-query"], [data-test-id="model-response"]'));
      if (dataTestIds.length) return dataTestIds;
      // 3. 尝试找 class
      const classes = Array.from(main.querySelectorAll('.user-query, .model-response'));
      if (classes.length) return classes;

      return [];
    }

    // ChatGPT 策略
    const turns = Array.from(
      main.querySelectorAll('[data-testid^="conversation-turn"], [data-testid="conversation-turn"]')
    );
    if (turns.length) {
      return turns.filter((n) => getTextFromMessage(n).length > 0);
    }

    const roleNodes = Array.from(main.querySelectorAll("[data-message-author-role]"));
    if (roleNodes.length) {
      const filtered = roleNodes.filter((n) => !n.parentElement?.closest?.("[data-message-author-role]"));
      const list = filtered.length ? filtered : roleNodes;
      return list.filter((n) => getTextFromMessage(n).length > 0);
    }

    const articles = Array.from(main.querySelectorAll("article"));
    if (articles.length) {
      return articles.filter((a) => getTextFromMessage(a).length > 0);
    }

    return [];
  }

  function stableKeyForNode(node, idx) {
    const role = getRole(node);
    const known =
      node.getAttribute?.("data-message-id") ||
      node.getAttribute?.("data-testid") ||
      node.id ||
      "";

    if (known) return `known:${known}|r:${role}`;

    const prefix = getTextFromMessage(node).slice(0, 140);
    const h = hashString(`${role}|${prefix}`);
    return `h:${h}|r:${role}|i:${idx}`;
  }

  function preview(node) {
    const t = getTextFromMessage(node);
    return t ? t.slice(0, 60) : "(空)";
  }

  function scrollToMessageStart(node) {
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => {
      const offset = 90;
      window.scrollBy({ top: -offset, left: 0, behavior: "instant" });
    }, 50);
  }

  // storage
  function loadMeta() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORE_KEY], (res) => {
          resolve(res && res[STORE_KEY] ? res[STORE_KEY] : { items: {} });
        });
      } catch (_) {
        resolve({ items: {} });
      }
    });
  }

  function saveMeta() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [STORE_KEY]: state.meta }, () => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  function getItemMeta(key) {
    return state.meta.items[key] || {};
  }

  async function setItemMeta(key, patch) {
    state.meta.items[key] = { ...(state.meta.items[key] || {}), ...patch };
    await saveMeta();
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatTimestamp(d) {
    // YYYYMMDD_HHMMSS
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mi = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
  }

  function roleLabel(role) {
    const r = (role || "").toLowerCase();
    if (r === "user") return "User";
    if (r === "assistant") return "Assistant";
    if (!r) return "Unknown";
    return role;
  }

  function escapeFenceConflicts(text) {
    // 避免内容里含 ``` 导致 Markdown fence 破坏：用 ~~~ 包裹更稳
    // 这里只做最小处理：如果含 ~~~ 则退回 ```text
    if (text.includes("~~~")) return { fence: "```text", end: "```" };
    return { fence: "~~~text", end: "~~~" };
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportFavorites() {
    const nodes = findMessageNodes();
    const favs = [];

    nodes.forEach((node, i) => {
      const key = stableKeyForNode(node, i);
      const meta = getItemMeta(key);
      if (!meta.fav) return;

      const role = getRole(node);
      const content = getTextFromMessage(node);
      const title = (meta.name && meta.name.trim())
        ? meta.name.trim()
        : `${i + 1}. ${preview(node)}`;

      favs.push({
        idx: i + 1,
        key,
        role: roleLabel(role),
        title,
        content
      });
    });

    if (!favs.length) {
      alert("当前页面没有收藏的节点（请先点 ☆ 变 ★ 再导出）。");
      return;
    }

    const now = new Date();
    const ts = formatTimestamp(now);
    const filename = `chatgpt_favorites_${ts}.md`;

    const lines = [];
    lines.push(`# ChatGPT 收藏导出`);
    lines.push(`- ExportedAt: ${now.toISOString()}`);
    lines.push(`- Page: ${location.href}`);
    lines.push(`- Count: ${favs.length}`);
    lines.push("");
    lines.push("> 说明：以下内容为当前对话页面中“已收藏★”的消息原文导出，便于后续粘贴回 ChatGPT 让其理解。");
    lines.push("");

    favs.forEach((it) => {
      lines.push(`---`);
      lines.push(`## ${it.idx}. [${it.role}] ${it.title}`);
      lines.push(`- Key: \`${it.key}\``);
      lines.push("");
      const fence = escapeFenceConflicts(it.content || "");
      lines.push(fence.fence);
      lines.push((it.content || "").replace(/\r\n/g, "\n"));
      lines.push(fence.end);
      lines.push("");
    });

    downloadText(filename, lines.join("\n"));
  }

  function buildUI() {
    if (document.getElementById(ROOT_ID)) return;

    const root = document.createElement("div");
    root.id = ROOT_ID;

    const header = document.createElement("div");
    header.id = "cgpt-nav-header";

    const title = document.createElement("div");
    title.id = "cgpt-nav-title";
    title.textContent = "对话导航";

    const actions = document.createElement("div");
    actions.id = "cgpt-nav-actions";

    const btnTop = document.createElement("button");
    btnTop.id = "cgpt-nav-btn-top";
    btnTop.textContent = "↑";
    btnTop.title = "回到顶部";

    const btnFilter = document.createElement("button");
    btnFilter.id = "cgpt-nav-btn-filter";
    btnFilter.textContent = "★";
    btnFilter.title = "仅显示收藏";

    const btnRefresh = document.createElement("button");
    btnRefresh.id = "cgpt-nav-btn-refresh";
    btnRefresh.textContent = "↻";
    btnRefresh.title = "刷新目录";

    const btnExport = document.createElement("button");
    btnExport.id = "cgpt-nav-btn-export";
    btnExport.textContent = "⤓";
    btnExport.title = "导出收藏到本地（.md）";

    const btnCollapse = document.createElement("button");
    btnCollapse.id = "cgpt-nav-btn-collapse";
    btnCollapse.textContent = "≡";
    btnCollapse.title = "折叠/展开";

    actions.appendChild(btnTop);
    actions.appendChild(btnFilter);
    actions.appendChild(btnRefresh);
    actions.appendChild(btnExport);
    actions.appendChild(btnCollapse);

    header.appendChild(title);
    header.appendChild(actions);

    const list = document.createElement("div");
    list.id = "cgpt-nav-list";

    root.appendChild(header);
    root.appendChild(list);

    (document.body || document.documentElement).appendChild(root);

    btnTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    btnCollapse.addEventListener("click", () => root.classList.toggle("cgpt-nav-collapsed"));

    btnFilter.addEventListener("click", () => {
      state.showOnlyFav = !state.showOnlyFav;
      btnFilter.style.background = state.showOnlyFav
        ? "rgba(255,255,255,0.18)"
        : "rgba(255,255,255,0.1)";
      renderIfChanged(true);
    });

    btnRefresh.addEventListener("click", () => renderIfChanged(true));
    btnExport.addEventListener("click", () => exportFavorites());
  }

  function computeSig(nodes) {
    return nodes.map((n, i) => stableKeyForNode(n, i)).join("||");
  }

  function startInlineEdit(textEl, key, fallbackText) {
    const old = (getItemMeta(key).name || "").trim();

    const input = document.createElement("input");
    input.className = "cgpt-nav-input";
    input.value = old || fallbackText || "";
    input.setAttribute("maxlength", "80");

    const parent = textEl.parentElement;
    if (!parent) return;
    parent.replaceChild(input, textEl);

    input.focus();
    input.select();

    const finish = async () => {
      const v = input.value.trim();
      await setItemMeta(key, { name: v });
      renderIfChanged(true);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish();
      if (e.key === "Escape") renderIfChanged(true);
    });

    input.addEventListener("blur", finish);
  }

  function renderList(nodes) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    const list = root.querySelector("#cgpt-nav-list");
    const title = root.querySelector("#cgpt-nav-title");
    if (!list || !title) return;

    title.textContent = `对话导航 (${nodes.length})`;
    list.innerHTML = "";

    const filtered = state.showOnlyFav
      ? nodes.filter((n, i) => !!getItemMeta(stableKeyForNode(n, i)).fav)
      : nodes;

    filtered.forEach((node) => {
      const originalIdx = nodes.indexOf(node);
      const key = stableKeyForNode(node, originalIdx);
      const meta = getItemMeta(key);
      const role = getRole(node);

      const defaultLabel = `${originalIdx + 1}. ${preview(node)}`;
      const label = meta.name && meta.name.trim() ? meta.name.trim() : defaultLabel;

      const item = document.createElement("div");
      item.className = "cgpt-nav-item";
      item.dataset.key = key;

      const badge = document.createElement("div");
      badge.className = "cgpt-nav-badge";
      badge.textContent = role ? role[0].toUpperCase() : "?";

      const star = document.createElement("button");
      star.className = "cgpt-nav-star";
      star.title = meta.fav ? "取消收藏" : "收藏";
      star.textContent = meta.fav ? "★" : "☆";
      star.addEventListener("click", async (e) => {
        e.stopPropagation();
        await setItemMeta(key, { fav: !meta.fav });
        renderIfChanged(true);
      });

      const text = document.createElement("div");
      text.className = "cgpt-nav-text";
      text.textContent = label;
      text.title = "双击重命名";
      text.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startInlineEdit(text, key, label);
      });

      const edit = document.createElement("button");
      edit.className = "cgpt-nav-edit";
      edit.title = "重命名";
      edit.textContent = "✎";
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        startInlineEdit(text, key, label);
      });

      item.appendChild(badge);
      item.appendChild(star);
      item.appendChild(text);
      item.appendChild(edit);

      item.addEventListener("click", () => {
        const latest = findMessageNodes();
        const found = latest.find((n, i) => stableKeyForNode(n, i) === key);
        scrollToMessageStart(found || node);
      });

      list.appendChild(item);
    });

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.style.opacity = "0.7";
      empty.style.fontSize = "12px";
      empty.style.padding = "10px 12px";
      empty.textContent = state.showOnlyFav
        ? "暂无收藏（点 ★ 取消筛选）"
        : "未找到对话消息（点 ↻ 刷新 / 或稍等页面加载）";
      list.appendChild(empty);
    }
  }

  function renderIfChanged(force = false) {
    const nodes = findMessageNodes();
    const sig = computeSig(nodes);
    if (!force && sig === state.lastSig) return;
    state.lastSig = sig;
    renderList(nodes);
  }

  function scheduleRender(force = false) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => renderIfChanged(force), 200);
  }

  function chooseObserveTarget() {
    const main = document.querySelector("main") || document.body;
    if (isGemini) return main;

    const candidate =
      main.querySelector?.('[data-testid^="conversation-turn"]')?.parentElement ||
      main;
    return candidate || main;
  }

  function startObserver() {
    const target = chooseObserveTarget();

    if (state.observer) {
      try { state.observer.disconnect(); } catch (_) { }
    }

    state.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") {
          scheduleRender(false);
          break;
        }
      }
      if (location.href !== state.url) {
        state.url = location.href;
        scheduleRender(true);
      }
    });

    state.observer.observe(target, { childList: true, subtree: true });
  }

  async function init() {
    state.meta = await loadMeta();

    let tries = 0;
    const tick = () => {
      tries++;
      const main = document.querySelector("main") || document.body;

      if (main) {
        buildUI();
        renderIfChanged(true);
        startObserver();
        return;
      }
      if (tries < 240) requestAnimationFrame(tick);
    };
    tick();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init);
  }
})();
