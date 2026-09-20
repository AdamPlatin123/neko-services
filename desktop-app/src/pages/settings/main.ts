/**
 * 纸质配置页——她的登记表。
 * 五个章节各司其职；所有后端交互经 src/lib/api.ts，断线一律优雅降级。
 * 文案规则（DESIGN.md）：她执笔的一律文楷、第一人称；系统状态一律思源黑。
 */
import { initTheme, toggleTheme } from "../../lib/night.ts";
import { getConfig, saveConfig, testLlm, getStatus, searchMemory } from "../../lib/api.ts";
import type { MemoryHit } from "../../lib/api.ts";
import { loadPetPrefs, savePetPrefs } from "../../lib/pet-prefs.ts";
import type { PetPrefs } from "../../lib/pet-prefs.ts";
import "./settings.css";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`找不到 ${sel}`);
  return el;
};

function flash(el: HTMLElement, text: string, ms = 2600): void {
  el.textContent = text;
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), ms);
}

/* ---------------- 顶栏：灯下读书 ---------------- */
initTheme();
const nightToggle = $("#night-toggle");
nightToggle.addEventListener("click", () => {
  const theme = toggleTheme();
  nightToggle.setAttribute("aria-pressed", theme === "night" ? "true" : "false");
});
nightToggle.setAttribute("aria-pressed", document.documentElement.dataset.theme === "night" ? "true" : "false");

/* ---------------- 一、我的钥匙串 ---------------- */
const fBaseUrl = $<HTMLInputElement>("#f-base-url");
const fModel = $<HTMLInputElement>("#f-model");
const fApiKey = $<HTMLInputElement>("#f-api-key");
const keysErr = $("#keys-err");
const keysOk = $("#keys-ok");
const keysDegrade = $("#keys-degrade");
const keysPath = $("#keys-path");
const btnSave = $<HTMLButtonElement>("#btn-save");
const btnTest = $<HTMLButtonElement>("#btn-test");

function currentKeys() {
  return { base_url: fBaseUrl.value.trim(), model: fModel.value.trim(), api_key: fApiKey.value.trim() };
}

void getConfig().then((r) => {
  if (r.ok) {
    fBaseUrl.value = r.config.base_url;
    fModel.value = r.config.model;
    fApiKey.value = r.config.api_key;
    keysPath.textContent = r.config_path;
    keysPath.hidden = false;
  } else if (r.degraded) {
    keysDegrade.hidden = false;
    keysPath.hidden = true;
  } else {
    // 有中间层、但档案柜状态异常（无文件/坏文件）
    keysDegrade.hidden = false;
    keysDegrade.textContent = `${r.message ?? "档案柜打不开。"}——先写在纸上，等连上后再誊一遍。`;
  }
});

btnSave.addEventListener("click", () => {
  void saveConfig(currentKeys()).then((r) => {
    if (r.ok) {
      keysErr.classList.remove("show");
      keysPath.textContent = r.config_path;
      keysPath.hidden = false;
      flash(keysOk, "我记下来了。");
    } else if (r.degraded) {
      flash(keysErr, "纸受了潮，字没写进去——配置服务没应我。", 4000);
    } else {
      flash(keysErr, r.message ?? "纸受了潮，字没写进去。", 4000);
    }
  });
});

btnTest.addEventListener("click", () => {
  btnTest.disabled = true;
  btnTest.textContent = "我去敲门了……";
  keysErr.classList.remove("show");
  keysOk.classList.remove("show");
  void testLlm(currentKeys()).then((r) => {
    btnTest.disabled = false;
    btnTest.textContent = "试一试";
    if (r.ok) {
      flash(keysOk, `对上了。门那头有回音（${r.latency_ms} ms）。`, 4000);
      return;
    }
    if (r.degraded) {
      flash(keysErr, "没人帮我递这把钥匙——配置服务没应我（npm run dev 时会自动带上它）。", 5000);
      return;
    }
    const msg = r.message ?? "";
    let her: string;
    switch (r.error_kind) {
      case "empty":
        her = "地址和型号都还没填全，我总得知道敲哪扇门。";
        break;
      case "auth":
        her = "这把钥匙打不开这扇门，再检查一下好吗？";
        break;
      case "model":
        her = "门开了，但她不在这个房间——型号名对吗？";
        break;
      case "network":
        her = msg.includes("超时") ? "我敲了很久，没人应（超时了）。" : "这扇门根本没找到，地址再核一核好吗？";
        break;
      default:
        her = `门后传来奇怪的声音${msg ? `（${msg}）` : ""}，再试一次？`;
    }
    flash(keysErr, her, 6000);
  });
});

// 回车 = 记下来（纸面习惯）
for (const input of [fBaseUrl, fModel, fApiKey]) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btnSave.click();
  });
}

/* ---------------- 二、我会在这些房间出现（10s 轮询） ---------------- */
const ROOMS = [
  { key: "desktop", label: "桌面", line: "她就在桌面上，离你半个屏幕。" },
  { key: "qq", label: "QQ", line: "她在 QQ 那间屋里冒了个泡。" },
  { key: "wechat", label: "微信", line: "微信那边的她刚醒。" },
  { key: "terminal", label: "终端", line: "她此刻在你的终端里，正看你 debug。" },
] as const;

const whereLine = $("#where-line");

function renderStatus(): void {
  void getStatus().then((r) => {
    if (!r.ok) {
      for (const room of ROOMS) setRoom(room.key, false);
      whereLine.textContent = "我看不清房间的灯——状态服务没应我。";
      return;
    }
    for (const room of ROOMS) {
      setRoom(room.key, r.entries[room.key]?.online ?? false);
    }
    // 优先报她在意的房间：终端 > 桌面 > QQ > 微信
    const current = ROOMS.slice().reverse().find((room) => r.entries[room.key]?.online);
    whereLine.textContent = current ? current.line : "她还没醒。先把灯打开（启动 N.E.K.O），再回来看。";
  });
}

function setRoom(key: string, online: boolean): void {
  const st = $(`#st-${key}`);
  st.classList.toggle("on", online);
  st.textContent = "";
  const dot = document.createElement("span");
  dot.className = "dot";
  st.append(dot, online ? "在" : "未连");
}

renderStatus();
window.setInterval(renderStatus, 10_000);

/* ---------------- 三、我的回忆册（只读） ---------------- */
const fMemoryQuery = $<HTMLInputElement>("#f-memory-query");
const btnMemorySearch = $<HTMLButtonElement>("#btn-memory-search");
const memoryErr = $("#memory-err");
const memoryResults = $("#memory-results");

function hitTime(hit: MemoryHit): string {
  const meta = hit.metadata ?? {};
  for (const k of ["created_at", "timestamp", "time", "datetime"]) {
    const v = meta[k];
    if (typeof v === "string" && v) return v.replace("T", " ").slice(0, 19);
    if (typeof v === "number" && v > 0) {
      const d = new Date(v * (v > 1e12 ? 1 : 1000));
      if (!Number.isNaN(d.getTime())) return d.toISOString().replace("T", " ").slice(0, 19);
    }
  }
  return "—";
}

function hitScore(hit: MemoryHit): string {
  const s = hit.score;
  if (typeof s !== "number" || Number.isNaN(s)) return "—";
  return s <= 1 ? `${(s * 100).toFixed(0)}%` : s.toFixed(2);
}

function renderMemory(hits: MemoryHit[]): void {
  memoryResults.textContent = "";
  if (hits.length === 0) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "她想了想——这一页是空白的。";
    memoryResults.append(empty);
    return;
  }
  for (const hit of hits) {
    const item = document.createElement("div");
    item.className = "memory-item";
    const content = document.createElement("p");
    content.className = "content";
    content.textContent = hit.content ?? "（这段回忆没有字，只有画面。）";
    const meta = document.createElement("p");
    meta.className = "meta";
    const metaItems = [
      `来源 ${hit.source ?? hit.type ?? "—"}`,
      `时间 ${hitTime(hit)}`,
      `相似 ${hitScore(hit)}`,
    ];
    meta.textContent = metaItems.join("　·　");
    item.append(content, meta);
    memoryResults.append(item);
  }
}

function doMemorySearch(): void {
  const query = fMemoryQuery.value.trim();
  if (!query) {
    flash(memoryErr, "要翻回忆册，总得告诉我翻什么。", 3000);
    return;
  }
  btnMemorySearch.disabled = true;
  btnMemorySearch.textContent = "翻着呢……";
  void searchMemory(query).then((r) => {
    btnMemorySearch.disabled = false;
    btnMemorySearch.textContent = "翻一翻";
    if (r.ok) {
      memoryErr.classList.remove("show");
      renderMemory(r.hits);
    } else if (r.degraded) {
      flash(memoryErr, "回忆册还锁着——记忆服务没应我。", 5000);
    } else {
      flash(memoryErr, r.message ?? "回忆册还锁着。", 5000);
    }
  });
}

btnMemorySearch.addEventListener("click", doMemorySearch);
fMemoryQuery.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doMemorySearch();
});

/* ---------------- 四、桌面陪伴（localStorage） ---------------- */
const fPetEnabled = $<HTMLInputElement>("#f-pet-enabled");
const fPetSize = $<HTMLInputElement>("#f-pet-size");
const petSizeOut = $("#pet-size-out");
const petOk = $("#pet-ok");
const fDndFrom = $<HTMLInputElement>("#f-pet-dnd-from");
const fDndTo = $<HTMLInputElement>("#f-pet-dnd-to");

const prefs: PetPrefs = loadPetPrefs();

function applyPrefsToControls(): void {
  fPetEnabled.checked = prefs.enabled;
  fPetSize.value = String(prefs.size);
  petSizeOut.textContent = `${prefs.size}px`;
  const radio = document.querySelector<HTMLInputElement>(`input[name="pet-corner"][value="${prefs.corner}"]`);
  if (radio) radio.checked = true;
  fDndFrom.value = prefs.dndFrom;
  fDndTo.value = prefs.dndTo;
}

function persistPrefs(): void {
  savePetPrefs(prefs);
  flash(petOk, "记好了。");
}

applyPrefsToControls();

fPetEnabled.addEventListener("change", () => {
  prefs.enabled = fPetEnabled.checked;
  persistPrefs();
});
fPetSize.addEventListener("input", () => {
  prefs.size = Number(fPetSize.value);
  petSizeOut.textContent = `${prefs.size}px`;
});
fPetSize.addEventListener("change", persistPrefs);
document.querySelectorAll<HTMLInputElement>("input[name='pet-corner']").forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked) {
      prefs.corner = radio.value as PetPrefs["corner"];
      persistPrefs();
    }
  });
});
fDndFrom.addEventListener("change", () => {
  prefs.dndFrom = fDndFrom.value;
  persistPrefs();
});
fDndTo.addEventListener("change", () => {
  prefs.dndTo = fDndTo.value;
  persistPrefs();
});
