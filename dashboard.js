// dashboard.js (FULL WORKING - OLD FEATURES KEPT + LATEST BUG FIXED)
// ✅ Keeps your old dashboard behavior (devices dropdown, live cards, charts, zoom/pan, calendar day view,
//    optional range, CSV export, AI panel, status dot, Go Live, JST consistency)
//
// 🔥 LATEST BUG FIXES (your current problems):
// 1) ✅ Day view always shows FULL DAY (00:00 -> 23:59 JST) using Firestore window query
//    -> no more “only 12 hours shown” caused by limit+filter.
// 2) ✅ GLOBAL monitoring no longer uses onSnapshot (real-time) — it uses polling getDocs()
//    -> this prevents browser overload, random “online 12 sec then offline”, late response, UI clears.
// 3) ✅ Query is written in safest Firestore order: where(...) then orderBy(...)
// 4) ✅ Range mode has a safety cap (48h) to avoid freezing (kept, not removed).
//
// ⚠️ REQUIREMENTS (same as before):
// - Luxon must be loaded in HTML AND default timezone set before this runs:
//   luxon.Settings.defaultZone = "Asia/Tokyo";
// - Chart.js + Luxon adapter + chartjs-plugin-zoom loaded
// - firebase-config.js exports firebaseConfig
// - ai.js exports createAI()

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { createAI } from "./ai.js";

/* =======================
   Firebase
======================= */
const app = initializeApp(firebaseConfig);

const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

/* =======================
   AI
======================= */
const AI = createAI();

/* =======================
   Devices
======================= */
const DEVICES = [
  { id: "atom_s3_lite_01", name: "Atom S3 Lite 01" },
  { id: "atom_s3_lite_02", name: "学習支援室" },
  { id: "atom_s3_lite_03", name: "Atom S3 Lite 03" },
  { id: "atom_s3_lite_04", name: "Atom S3 Lite 04" },
];

let currentDeviceId = DEVICES[0].id;

function getCurrentDeviceName() {
  return DEVICES.find((d) => d.id === currentDeviceId)?.name || currentDeviceId;
}

/* =======================
   DOM (top)
======================= */
const deviceSelect = document.getElementById("deviceSelect");
const statusDot = document.getElementById("deviceStatusDot");
const statusText = document.getElementById("deviceStatusText");
const nowEl = document.getElementById("nowDateTime");
const lastUpdatedText = document.getElementById("lastUpdatedText");
const goLiveBtn = document.getElementById("goLiveBtn");

/* =======================
   DOM (cards)
======================= */
const tempNowEl = document.getElementById("tempNow");
const tempMaxEl = document.getElementById("tempMax");
const tempMinEl = document.getElementById("tempMin");

const humNowEl = document.getElementById("humNow");
const humMaxEl = document.getElementById("humMax");
const humMinEl = document.getElementById("humMin");

const pressNowEl = document.getElementById("pressNow");
const pressMaxEl = document.getElementById("pressMax");
const pressMinEl = document.getElementById("pressMin");

const lightNowEl = document.getElementById("lightNow");
const lightMaxEl = document.getElementById("lightMax");
const lightMinEl = document.getElementById("lightMin");

/* =======================
   DOM (charts)
======================= */
const tempCanvas = document.getElementById("tempChart");
const humCanvas = document.getElementById("humChart");
const pressCanvas = document.getElementById("pressChart");
const lightCanvas = document.getElementById("lightChart");

/* =======================
   DOM (chart titles)
======================= */
const tempChartTitleEl = document.getElementById("tempChartTitle");
const humChartTitleEl = document.getElementById("humChartTitle");
const pressChartTitleEl = document.getElementById("pressChartTitle");
const lightChartTitleEl = document.getElementById("lightChartTitle");

/* =======================
   DOM (calendar + range)
======================= */
const calPrevBtn = document.getElementById("calPrevBtn");
const calNextBtn = document.getElementById("calNextBtn");
const calTitleEl = document.getElementById("calTitle");
const calGridEl = document.getElementById("calendarGrid");

const rangeStartEl = document.getElementById("rangeStart");
const rangeEndEl = document.getElementById("rangeEnd");
const rangeMsgEl = document.getElementById("rangeMsg");

/* =======================
   DOM (AI UI)
======================= */
const langSelect = document.getElementById("langSelect");
const aiStatusBadge = document.getElementById("aiStatusBadge");
const aiTitleEl = document.getElementById("aiTitle");
const aiInsightsEl = document.getElementById("aiInsights");
const bigToastEl = document.getElementById("bigToast");

/* =======================
   DOM (CSV)
======================= */
const csvDownloadBtn = document.getElementById("csvDownloadBtn");
const csvDownloadAllBtn = document.getElementById("csvDownloadAllBtn");

// OPTIONAL buttons (only if you add them in HTML later)
const csvDownloadAllDevicesBtn = document.getElementById("csvDownloadAllDevicesBtn");
const csvDownloadAllDevicesLastNBtn = document.getElementById("csvDownloadAllDevicesLastNBtn");

const csvLimitInput = document.getElementById("csvLimitInput");
const csvHintText = document.getElementById("csvHintText");

/* =======================
   State
======================= */
let tempChart = null,
  humChart = null,
  pressChart = null,
  lightChart = null;

let unsubscribeData = null;

let LIVE_MODE = true;
let lastDataMs = null;

const OFFLINE_WARN_MS = 45 * 1000;
const OFFLINE_ALERT_MS = 5 * 60 * 1000;

let IGNORE_ZOOM_EVENTS = false;

let VIEW_MODE = "live"; // live | day | range
let selectedDayStartMs = null;
let rangeStartMs = null;
let rangeEndMs = null;

let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();

let RANGE_INPUT_TIMER = null;
const RANGE_INPUT_DEBOUNCE_MS = 200;

// Selected device listener limits:
const FIRESTORE_LIMIT_DOCS = 6500;   // live last N
const WINDOW_LIMIT_DOCS = 9000;     // day/range window (increase if you log very fast)

// Global monitoring limits (IMPORTANT):
const GLOBAL_LIMIT_DOCS = 120;       // keep small
const GLOBAL_POLL_MS = 15000;        // poll every 15s (stable)

// Safety range cap
const MAX_RANGE_MS = 48 * 60 * 60 * 1000; // 48 hours

let CURRENT_VIEW_ROWS = [];

/* =======================
   Language Mode
======================= */
let LANG_MODE = "auto";
function setLangMode(v) {
  LANG_MODE = v || "auto";
  if (langSelect) langSelect.value = LANG_MODE;
}

/* =======================
   Helpers
======================= */
function formatNum(val, digits) {
  return typeof val === "number" ? val.toFixed(digits) : "--";
}

function tsToMs(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate().getTime(); // Firestore Timestamp
  if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/* ===== JST-safe day math (Luxon) ===== */
function startOfTodayMs() {
  return luxon.DateTime.now().setZone("Asia/Tokyo").startOf("day").toMillis();
}
function endOfTodayMs() {
  return luxon.DateTime.now().setZone("Asia/Tokyo").endOf("day").toMillis() + 1;
}
function startOfDayMs(y, m, day) {
  return luxon.DateTime.fromObject(
    { year: y, month: m + 1, day },
    { zone: "Asia/Tokyo" }
  ).startOf("day").toMillis();
}

/* ===== Display helpers (force JST) ===== */
function fmtTime(ms) {
  if (!ms) return "--";
  return new Date(ms).toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtDateTime(ms) {
  if (!ms) return "--";
  return new Date(ms).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/* ===== datetime-local handling (treat input as JST) ===== */
function toJstDateTimeLocalValueFromMs(ms) {
  const dt = luxon.DateTime.fromMillis(ms, { zone: "Asia/Tokyo" });
  return dt.toFormat("yyyy-LL-dd'T'HH:mm");
}
function parseDateTimeLocalToMs(val) {
  if (!val) return null;
  const dt = luxon.DateTime.fromFormat(val, "yyyy-LL-dd'T'HH:mm", { zone: "Asia/Tokyo" });
  return dt.isValid ? dt.toMillis() : null;
}

function setMsg(text) {
  if (!rangeMsgEl) return;
  rangeMsgEl.textContent = text || "";
}

/* ===== Chart title helpers ===== */
function fmtYMD(ms) {
  const dt = luxon.DateTime.fromMillis(ms, { zone: "Asia/Tokyo" });
  return dt.toFormat("yyyy/LL/dd");
}
function fmtWeekday(ms) {
  return luxon.DateTime.fromMillis(ms, { zone: "Asia/Tokyo" }).toFormat("ccc");
}
function fmtYMDHM(ms) {
  const dt = luxon.DateTime.fromMillis(ms, { zone: "Asia/Tokyo" });
  return `${dt.toFormat("yyyy/LL/dd")} ${dt.toFormat("HH:mm")}`;
}

function updateChartTitles() {
  const set = (el, text) => { if (el) el.textContent = text; };

  if (VIEW_MODE === "day" && selectedDayStartMs) {
    const dayStr = `${fmtYMD(selectedDayStartMs)} ${fmtWeekday(selectedDayStartMs)}`;
    set(tempChartTitleEl, `Temperature (${dayStr})`);
    set(humChartTitleEl, `Humidity (${dayStr})`);
    set(pressChartTitleEl, `Pressure (${dayStr})`);
    set(lightChartTitleEl, `Light (${dayStr})`);
    return;
  }

  if (VIEW_MODE === "range" && typeof rangeStartMs === "number" && typeof rangeEndMs === "number") {
    const endClamped = Math.min(rangeEndMs, Date.now());
    const rangeStr = `${fmtYMDHM(rangeStartMs)} – ${fmtYMDHM(endClamped)}`;
    set(tempChartTitleEl, `Temperature (${rangeStr})`);
    set(humChartTitleEl, `Humidity (${rangeStr})`);
    set(pressChartTitleEl, `Pressure (${rangeStr})`);
    set(lightChartTitleEl, `Light (${rangeStr})`);
    return;
  }

  set(tempChartTitleEl, "Temperature (Today)");
  set(humChartTitleEl, "Humidity (Today)");
  set(pressChartTitleEl, "Pressure (Today)");
  set(lightChartTitleEl, "Light (Today)");
}

/* =======================
   Go Live button text
======================= */
function renderGoLiveButton() {
  if (!goLiveBtn) return;
  goLiveBtn.textContent = LIVE_MODE ? "Go Live" : "Go Live (paused)";
}

/* =======================
   AI UI
======================= */
function setAiBadge(level, lang) {
  if (!aiStatusBadge) return;
  aiStatusBadge.classList.remove("ok", "warn", "alert");

  const L = lang === "jp" ? "jp" : "en";
  const label =
    level === "ALERT"
      ? (L === "jp" ? "AI: 警告" : "AI: ALERT")
      : level === "WARN"
      ? (L === "jp" ? "AI: 注意" : "AI: WARNING")
      : (L === "jp" ? "AI: 正常" : "AI: OK");

  if (level === "ALERT") aiStatusBadge.classList.add("alert");
  else if (level === "WARN") aiStatusBadge.classList.add("warn");
  else aiStatusBadge.classList.add("ok");

  aiStatusBadge.textContent = label;
}

function renderAiMessage(msg) {
  if (!aiInsightsEl) return;
  aiInsightsEl.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = msg || "--";
  aiInsightsEl.appendChild(li);
}

function showBigToast(level, message) {
  if (!bigToastEl) return;
  bigToastEl.classList.remove("hidden", "ok", "warn", "alert");
  bigToastEl.classList.add(level);
  bigToastEl.textContent = message;

  const ms = level === "alert" ? 9000 : 6000;
  clearTimeout(showBigToast._t);
  showBigToast._t = setTimeout(() => bigToastEl.classList.add("hidden"), ms);
}

/* =======================
   Global Modal
======================= */
let MODAL = null;
let MODAL_VISIBLE = false;
let MODAL_EVENT_KEY = null;

function ensureGlobalModal() {
  if (MODAL) return MODAL;

  const overlay = document.createElement("div");
  overlay.id = "aiGlobalModalOverlay";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:9999;";

  const box = document.createElement("div");
  box.id = "aiGlobalModalBox";
  box.style.cssText =
    "width:min(560px,92vw);background:#111827;color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:18px 18px 14px;box-shadow:0 20px 60px rgba(0,0,0,.55);";

  const title = document.createElement("div");
  title.id = "aiGlobalModalTitle";
  title.style.cssText = "font-weight:700;font-size:16px;margin-bottom:10px;";

  const msg = document.createElement("div");
  msg.id = "aiGlobalModalMsg";
  msg.style.cssText =
    "font-size:14px;line-height:1.5;opacity:.95;margin-bottom:14px;";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;justify-content:flex-end;gap:10px;";

  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.textContent = "OK";
  okBtn.style.cssText =
    "padding:10px 14px;border-radius:10px;border:0;background:#3b82f6;color:#fff;font-weight:700;cursor:pointer;";
  okBtn.addEventListener("click", () => hideGlobalModal(true));

  btnRow.appendChild(okBtn);
  box.appendChild(title);
  box.appendChild(msg);
  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  MODAL = { overlay, box, title, msg, okBtn };
  return MODAL;
}

function showGlobalModal(level, text, eventKey, lang) {
  const M = ensureGlobalModal();

  MODAL_VISIBLE = true;
  MODAL_EVENT_KEY = eventKey || null;

  const isJP = lang === "jp";
  const t =
    level === "critical"
      ? (isJP ? "AI: 重要アラート" : "AI: Critical Alert")
      : (isJP ? "AI: Notice" : "AI: Notice");

  M.title.textContent = t;
  M.msg.textContent = text || "--";
  M.okBtn.textContent = "OK";

  M.box.style.borderColor =
    level === "critical" ? "rgba(239,68,68,.7)" : "rgba(255,255,255,.12)";
  M.title.style.color = level === "critical" ? "#fca5a5" : "#e5e7eb";

  M.overlay.style.display = "flex";
}

function hideGlobalModal(ack) {
  if (!MODAL) return;
  MODAL.overlay.style.display = "none";
  MODAL_VISIBLE = false;

  if (ack && MODAL_EVENT_KEY) runGlobalAI({ ackEventKey: MODAL_EVENT_KEY });
  MODAL_EVENT_KEY = null;
}

/* =======================
   Selected device AI update
======================= */
function updateAIUI() {
  const res = AI.update({
    viewMode: VIEW_MODE,
    rows: CURRENT_VIEW_ROWS,
    deviceName: getCurrentDeviceName(),
    langMode: LANG_MODE,
    nowMs: Date.now(),
    rangeStartMs,
    rangeEndMs,
  });

  if (aiTitleEl) aiTitleEl.textContent = res?.title ?? "AI";
  setAiBadge(res?.badgeLevel ?? "OK", res?.lang);
  renderAiMessage(res?.message ?? "--");
}

/* =======================
   Global monitoring payload (POLLED)
======================= */
let GLOBAL_STATE = new Map(); // deviceId -> { deviceId, deviceName, rows, lastDataMs }
let GLOBAL_AI_TIMER = null;

function getGlobalDevicesPayload() {
  const list = [];
  for (const dev of DEVICES) {
    const st = GLOBAL_STATE.get(dev.id) || {
      deviceId: dev.id,
      deviceName: dev.name,
      rows: [],
      lastDataMs: null,
    };
    list.push({
      deviceId: st.deviceId,
      deviceName: st.deviceName,
      rows: st.rows || [],
      lastDataMs: st.lastDataMs || null,
    });
  }
  return list;
}

let LAST_GLOBAL_TOAST_EVENT = null;
let LAST_GLOBAL_TOAST_MS = 0;

function runGlobalAI({ ackEventKey = null } = {}) {
  const res = AI.evaluateGlobal({
    devices: getGlobalDevicesPayload(),
    nowMs: Date.now(),
    langMode: LANG_MODE,
    warnMs: OFFLINE_WARN_MS,
    alertMs: OFFLINE_ALERT_MS,
    repeatWindowMs: 10 * 60 * 1000,
    persistWindowMs: 30 * 60 * 1000,
    modalSnoozeMs: 5 * 60 * 1000,
    ackEventKey,
  });

  const lang = res?.lang || (LANG_MODE === "jp" ? "jp" : "en");

  if (res?.modal) {
    const m = res.modal;
    if (!MODAL_VISIBLE) {
      showGlobalModal(m.level, m.text, m.eventKey, lang);
    } else {
      if (m.level === "critical" && m.eventKey !== MODAL_EVENT_KEY) {
        showGlobalModal(m.level, m.text, m.eventKey, lang);
      }
    }
    return;
  }

  if (res?.toast && !MODAL_VISIBLE) {
    const t = res.toast;
    const now = Date.now();
    const eventKey = t.eventKey || null;

    const minGap = 6000;
    if (eventKey && LAST_GLOBAL_TOAST_EVENT === eventKey && now - LAST_GLOBAL_TOAST_MS < minGap) {
      return;
    }

    LAST_GLOBAL_TOAST_EVENT = eventKey;
    LAST_GLOBAL_TOAST_MS = now;

    showBigToast(t.level, t.text);
  }
}

/* =======================
   Global monitoring (FIXED: POLLING, NOT onSnapshot)
======================= */
let GLOBAL_POLL_HANDLE = null;
let GLOBAL_POLL_INFLIGHT = false;

async function pollGlobalOnce() {
  if (GLOBAL_POLL_INFLIGHT) return;
  GLOBAL_POLL_INFLIGHT = true;

  try {
    for (const dev of DEVICES) {
      try {
        const dataCol = collection(db, "public_readings", dev.id, "data");
        const qData = query(dataCol, orderBy("timestamp", "desc"), limit(GLOBAL_LIMIT_DOCS));
        const snap = await getDocs(qData);

        if (snap.empty) {
          GLOBAL_STATE.set(dev.id, { deviceId: dev.id, deviceName: dev.name, rows: [], lastDataMs: null });
          continue;
        }

        const rows = [];
        snap.forEach((doc) => rows.push(doc.data()));
        rows.reverse();

        const lastMs = tsToMs(rows[rows.length - 1]?.timestamp);
        GLOBAL_STATE.set(dev.id, { deviceId: dev.id, deviceName: dev.name, rows, lastDataMs: lastMs });
      } catch (e) {
        console.error("Global poll error:", dev.id, e);
        GLOBAL_STATE.set(dev.id, { deviceId: dev.id, deviceName: dev.name, rows: [], lastDataMs: null });
      }
    }

    runGlobalAI();
  } finally {
    GLOBAL_POLL_INFLIGHT = false;
  }
}

function startGlobalMonitoring() {
  if (GLOBAL_POLL_HANDLE) clearInterval(GLOBAL_POLL_HANDLE);
  pollGlobalOnce(); // immediate first poll
  GLOBAL_POLL_HANDLE = setInterval(pollGlobalOnce, GLOBAL_POLL_MS);

  if (GLOBAL_AI_TIMER) clearInterval(GLOBAL_AI_TIMER);
  GLOBAL_AI_TIMER = setInterval(() => runGlobalAI(), 5000);
}

/* =======================
   Status (dot/text)
======================= */
function renderStatus() {
  if (!statusDot || !statusText) return;

  if (!lastDataMs) {
    statusDot.classList.remove("online");
    statusDot.classList.add("offline");
    statusText.textContent = "Offline (no data)";
    return;
  }

  const ageMs = Date.now() - lastDataMs;

  if (ageMs < OFFLINE_WARN_MS) {
    statusDot.classList.remove("offline");
    statusDot.classList.add("online");
    statusText.textContent = `Online (${Math.floor(ageMs / 1000)}s ago)`;
  } else if (ageMs < OFFLINE_ALERT_MS) {
    statusDot.classList.remove("offline");
    statusDot.classList.add("online");
    statusText.textContent = `Online (slow: ${Math.floor(ageMs / 1000)}s ago)`;
  } else {
    statusDot.classList.remove("online");
    statusDot.classList.add("offline");
    statusText.textContent = `Offline (last seen ${fmtTime(lastDataMs)})`;
  }
}

function startStatusTicker() {
  setInterval(renderStatus, 1000);
}

/* =======================
   Clock
======================= */
function startLiveClock() {
  if (!nowEl) return;
  const tick = () => (nowEl.textContent = fmtDateTime(Date.now()));
  tick();
  setInterval(tick, 1000);
}

/* =======================
   Chart setup
======================= */
function registerZoomPlugin() {
  const zoomPlugin = window.ChartZoom?.default || window.ChartZoom;
  if (!zoomPlugin) {
    console.warn("❌ chartjs-plugin-zoom not loaded. Zoom disabled.");
    return false;
  }
  Chart.register(zoomPlugin);
  return true;
}

function makeTimeChart(canvas, label, color) {
  return new Chart(canvas, {
    type: "line",
    data: {
      datasets: [{ label, data: [], borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.25 }],
    },
    options: {
      responsive: true,
      parsing: false,
      animation: { duration: 200 },
      adapters: { date: { zone: "Asia/Tokyo" } },
      scales: {
        x: {
          type: "time",
          time: { displayFormats: { hour: "HH:mm", minute: "HH:mm", second: "HH:mm:ss" } },
          ticks: { maxTicksLimit: 10, autoSkip: true },
        },
        y: { beginAtZero: false },
      },
      plugins: {
        zoom: {
          pan: {
            enabled: true,
            mode: "x",
            onPanComplete() {
              if (IGNORE_ZOOM_EVENTS) return;
              LIVE_MODE = false;
              renderGoLiveButton();
            },
          },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: "x",
            onZoomComplete() {
              if (IGNORE_ZOOM_EVENTS) return;
              LIVE_MODE = false;
              renderGoLiveButton();
            },
          },
        },
      },
    },
  });
}

function initCharts() {
  registerZoomPlugin();
  tempChart = makeTimeChart(tempCanvas, "Temperature (°C)", "#ff3b30");
  humChart = makeTimeChart(humCanvas, "Humidity (%)", "#00a3ff");
  pressChart = makeTimeChart(pressCanvas, "Pressure (hPa)", "#22c55e");
  lightChart = makeTimeChart(lightCanvas, "Light (lux)", "#ffb020");
}

/* =======================
   Active window logic
======================= */
function getActiveWindow() {
  const now = Date.now();

  // Day view: EXACT day 00:00 -> 24:00 (JST)
  if (VIEW_MODE === "day" && selectedDayStartMs) {
    return { from: selectedDayStartMs, to: selectedDayStartMs + 24 * 60 * 60 * 1000 };
  }

  // Range view (kept)
  if (VIEW_MODE === "range" && typeof rangeStartMs === "number" && typeof rangeEndMs === "number") {
    const to = Math.min(rangeEndMs, now);
    const from = Math.min(rangeStartMs, to);
    return { from, to };
  }

  // Live defaults to today window
  return { from: startOfTodayMs(), to: endOfTodayMs() };
}

function applyLiveWindow() {
  if (!LIVE_MODE) return;

  const win = getActiveWindow();
  const min = win.from;
  const max = Math.min(Date.now(), win.to);

  [tempChart, humChart, pressChart, lightChart].forEach((ch) => {
    ch.options.scales.x.min = min;
    ch.options.scales.x.max = max;
  });
}

function forceWindowToActiveRange() {
  const win = getActiveWindow();
  [tempChart, humChart, pressChart, lightChart].forEach((ch) => {
    ch.options.scales.x.min = win.from;
    ch.options.scales.x.max = win.to;
  });

  tempChart?.update();
  humChart?.update();
  pressChart?.update();
  lightChart?.update();
}

function updateCharts({ tempPts, humPts, pressPts, lightPts }) {
  applyLiveWindow();

  tempChart.data.datasets[0].data = tempPts;
  humChart.data.datasets[0].data = humPts;
  pressChart.data.datasets[0].data = pressPts;
  lightChart.data.datasets[0].data = lightPts;

  tempChart.update();
  humChart.update();
  pressChart.update();
  lightChart.update();
}

/* =======================
   Cards
======================= */
function setAllCardTextToDash() {
  if (tempNowEl) tempNowEl.textContent = "--";
  if (tempMaxEl) tempMaxEl.textContent = "--";
  if (tempMinEl) tempMinEl.textContent = "--";

  if (humNowEl) humNowEl.textContent = "--";
  if (humMaxEl) humMaxEl.textContent = "--";
  if (humMinEl) humMinEl.textContent = "--";

  if (pressNowEl) pressNowEl.textContent = "--";
  if (pressMaxEl) pressMaxEl.textContent = "--";
  if (pressMinEl) pressMinEl.textContent = "--";

  if (lightNowEl) lightNowEl.textContent = "--";
  if (lightMaxEl) lightMaxEl.textContent = "--";
  if (lightMinEl) lightMinEl.textContent = "--";
}

function updateCards({ latest, tMax, tMin, hMax, hMin, pMax, pMin, lMax, lMin }) {
  if (!latest) {
    setAllCardTextToDash();
    return;
  }

  if (tempNowEl) tempNowEl.textContent = `${formatNum(latest.Temperature, 2)} °C`;
  if (tempMaxEl) tempMaxEl.textContent = `${formatNum(tMax, 2)} °C`;
  if (tempMinEl) tempMinEl.textContent = `${formatNum(tMin, 2)} °C`;

  if (humNowEl) humNowEl.textContent = `${formatNum(latest.Humidity, 2)} %`;
  if (humMaxEl) humMaxEl.textContent = `${formatNum(hMax, 2)} %`;
  if (humMinEl) humMinEl.textContent = `${formatNum(hMin, 2)} %`;

  if (pressNowEl) pressNowEl.textContent = `${formatNum(latest.Pressure, 1)} hPa`;
  if (pressMaxEl) pressMaxEl.textContent = `${formatNum(pMax, 1)} hPa`;
  if (pressMinEl) pressMinEl.textContent = `${formatNum(pMin, 1)} hPa`;

  if (lightNowEl) lightNowEl.textContent = `${formatNum(latest.Light, 1)} lux`;
  if (lightMaxEl) lightMaxEl.textContent = `${formatNum(lMax, 1)} lux`;
  if (lightMinEl) lightMinEl.textContent = `${formatNum(lMin, 1)} lux`;
}

/* =======================
   Firestore subscribe (selected device)
   ✅ FIX: day/range uses window query (full day, no partial)
======================= */
function subscribeToTodayData() {
  if (unsubscribeData) {
    unsubscribeData();
    unsubscribeData = null;
  }

  const dataCol = collection(db, "public_readings", currentDeviceId, "data");

  const win = getActiveWindow();
  const fromDate = new Date(win.from);
  const toDate = new Date(win.to);

  let qData = null;

  if (VIEW_MODE === "day" || VIEW_MODE === "range") {
    // ✅ safest Firestore order: where -> where -> orderBy
    qData = query(
      dataCol,
      where("timestamp", ">=", fromDate),
      where("timestamp", "<", toDate),
      orderBy("timestamp", "asc"),
      limit(WINDOW_LIMIT_DOCS)
    );
  } else {
    qData = query(
      dataCol,
      orderBy("timestamp", "desc"),
      limit(FIRESTORE_LIMIT_DOCS)
    );
  }

  unsubscribeData = onSnapshot(
    qData,
    (snap) => {
      if (snap.empty) {
        lastDataMs = null;
        CURRENT_VIEW_ROWS = [];

        renderStatus();
        if (lastUpdatedText) lastUpdatedText.textContent = "--";
        setAllCardTextToDash();
        updateCharts({ tempPts: [], humPts: [], pressPts: [], lightPts: [] });

        updateAIUI();
        return;
      }

      const rows = [];
      snap.forEach((doc) => rows.push(doc.data()));

      // live query is desc -> reverse to asc
      if (VIEW_MODE === "live") rows.reverse();

      // day/range already in-window
      let finalRows = rows;

      // live still filters to today window (in case last-N includes yesterday)
      if (VIEW_MODE === "live") {
        const win2 = getActiveWindow();
        const filtered = rows.filter((d) => {
          const ms = tsToMs(d.timestamp);
          return ms && ms >= win2.from && ms < win2.to;
        });
        finalRows = filtered.length ? filtered : rows;
      }

      CURRENT_VIEW_ROWS = finalRows;

      const tempPts = [], humPts = [], pressPts = [], lightPts = [];

      let latest = null;
      let tMax = null, tMin = null, hMax = null, hMin = null, pMax = null, pMin = null, lMax = null, lMin = null;

      finalRows.forEach((d) => {
        const ms = tsToMs(d.timestamp);
        if (!ms) return;

        latest = d;

        if (typeof d.Temperature === "number") {
          tempPts.push({ x: ms, y: d.Temperature });
          tMax = tMax === null ? d.Temperature : Math.max(tMax, d.Temperature);
          tMin = tMin === null ? d.Temperature : Math.min(tMin, d.Temperature);
        }
        if (typeof d.Humidity === "number") {
          humPts.push({ x: ms, y: d.Humidity });
          hMax = hMax === null ? d.Humidity : Math.max(hMax, d.Humidity);
          hMin = hMin === null ? d.Humidity : Math.min(hMin, d.Humidity);
        }
        if (typeof d.Pressure === "number") {
          pressPts.push({ x: ms, y: d.Pressure });
          pMax = pMax === null ? d.Pressure : Math.max(pMax, d.Pressure);
          pMin = pMin === null ? d.Pressure : Math.min(pMin, d.Pressure);
        }
        if (typeof d.Light === "number") {
          lightPts.push({ x: ms, y: d.Light });
          lMax = lMax === null ? d.Light : Math.max(lMax, d.Light);
          lMin = lMin === null ? d.Light : Math.min(lMin, d.Light);
        }
      });

   lastDataMs = tsToMs(latest?.timestamp);

renderStatus();
if (lastUpdatedText) lastUpdatedText.textContent = fmtDateTime(lastDataMs);

updateCards({ latest, tMax, tMin, hMax, hMin, pMax, pMin, lMax, lMin });
updateCharts({ tempPts, humPts, pressPts, lightPts });

// ✅ ALWAYS force chart window after setting data
forceWindowToActiveRange();

         updateAIUI();
    },
    (err) => {
      console.error("❌ Firestore onSnapshot error:", err);

      renderStatus();
      updateAIUI();
    }
  );

}
 


/* =======================
   Device dropdown
======================= */
function setupDeviceDropdown() {
  if (!deviceSelect) return;

  deviceSelect.innerHTML = "";
  DEVICES.forEach((dev, idx) => {
    const opt = document.createElement("option");
    opt.value = dev.id;
    opt.textContent = dev.name;
    deviceSelect.appendChild(opt);
    if (idx === 0) currentDeviceId = dev.id;
  });

  deviceSelect.value = currentDeviceId;

  deviceSelect.addEventListener("change", () => {
    currentDeviceId = deviceSelect.value;

    VIEW_MODE = "live";
    selectedDayStartMs = null;
    rangeStartMs = null;
    rangeEndMs = null;
    setMsg("");

    LIVE_MODE = true;
    renderGoLiveButton();
    updateChartTitles();

    syncRangeMaxNow();
    const nowJ = luxon.DateTime.now().setZone("Asia/Tokyo");
    calYear = nowJ.year;
    calMonth = nowJ.month - 1;
    renderCalendar();

    subscribeToTodayData();
    updateAIUI();
  });
}

/* =======================
   Go Live button
======================= */
function setupGoLiveButton() {
  if (!goLiveBtn) return;

  goLiveBtn.addEventListener("click", () => {
    VIEW_MODE = "live";
    selectedDayStartMs = null;
    rangeStartMs = null;
    rangeEndMs = null;
    setMsg("");
    updateChartTitles();

    if (rangeStartEl) rangeStartEl.value = "";
    if (rangeEndEl) rangeEndEl.value = "";

    LIVE_MODE = true;
    renderGoLiveButton();

    IGNORE_ZOOM_EVENTS = true;
    [tempChart, humChart, pressChart, lightChart].forEach((ch) => ch?.resetZoom?.());

    setTimeout(() => {
      IGNORE_ZOOM_EVENTS = false;
      LIVE_MODE = true;
      renderGoLiveButton();
    }, 0);

    const nowJ = luxon.DateTime.now().setZone("Asia/Tokyo");
    calYear = nowJ.year;
    calMonth = nowJ.month - 1;
    renderCalendar();

    subscribeToTodayData();
    updateAIUI();
  });

  setInterval(() => renderGoLiveButton(), 500);
}

/* =======================
   Day rollover (JST)
======================= */
let currentDayKey = null;
function dayKeyNow() {
  return luxon.DateTime.now().setZone("Asia/Tokyo").toFormat("yyyy-LL-dd");
}

function startDayWatcher() {
  currentDayKey = dayKeyNow();
  setInterval(() => {
    const k = dayKeyNow();
    if (k !== currentDayKey) {
      currentDayKey = k;

      VIEW_MODE = "live";
      selectedDayStartMs = null;
      rangeStartMs = null;
      rangeEndMs = null;
      setMsg("");

      LIVE_MODE = true;
      renderGoLiveButton();
      updateChartTitles();

      syncRangeMaxNow();
      renderCalendar();
      subscribeToTodayData();
      updateAIUI();
    }
  }, 10000);
}

/* =======================
   Calendar (JST)
======================= */
function monthName(y, m) {
  const dt = luxon.DateTime.fromObject({ year: y, month: m + 1, day: 1 }, { zone: "Asia/Tokyo" });
  return dt.setLocale("en").toFormat("LLLL yyyy");
}
function isFutureDay(y, m, day) {
  const start = startOfDayMs(y, m, day);
  return start > startOfTodayMs();
}
function isSelectedDay(y, m, day) {
  if (!selectedDayStartMs) return false;
  return selectedDayStartMs === startOfDayMs(y, m, day);
}
function isTodayCell(y, m, day) {
  const t = luxon.DateTime.now().setZone("Asia/Tokyo");
  return y === t.year && m === (t.month - 1) && day === t.day;
}

function renderCalendar() {
  if (!calGridEl || !calTitleEl) return;

  const now = luxon.DateTime.now().setZone("Asia/Tokyo");
  const isCurrentMonth = calYear === now.year && calMonth === (now.month - 1);
  if (calNextBtn) calNextBtn.disabled = isCurrentMonth;

  calTitleEl.textContent = monthName(calYear, calMonth);
  calGridEl.innerHTML = "";

  const first = luxon.DateTime.fromObject({ year: calYear, month: calMonth + 1, day: 1 }, { zone: "Asia/Tokyo" });
  const startWeekday = first.weekday % 7; // Mon=1..Sun=7
  const daysInMonth = first.daysInMonth;

  for (let i = 0; i < startWeekday; i++) {
    const pad = document.createElement("div");
    pad.className = "calCell calPad";
    calGridEl.appendChild(pad);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "calCell";
    cell.textContent = String(day);

    const disabled = isFutureDay(calYear, calMonth, day);
    if (disabled) {
      cell.disabled = true;
      cell.classList.add("calDisabled");
    }

    if (isTodayCell(calYear, calMonth, day)) cell.classList.add("calToday");
    if (VIEW_MODE === "day" && isSelectedDay(calYear, calMonth, day)) cell.classList.add("calSelected");

    cell.addEventListener("click", () => {
      if (disabled) return;

      VIEW_MODE = "day";
      selectedDayStartMs = startOfDayMs(calYear, calMonth, day);

      LIVE_MODE = false;
      renderGoLiveButton();
      updateChartTitles();

      rangeStartMs = null;
      rangeEndMs = null;
      if (rangeStartEl) rangeStartEl.value = "";
      if (rangeEndEl) rangeEndEl.value = "";
      setMsg("");

      forceWindowToActiveRange();
      renderCalendar();

      subscribeToTodayData();
      updateAIUI();
    });

    calGridEl.appendChild(cell);
  }
}

function setupCalendarNav() {
  if (calPrevBtn) {
    calPrevBtn.addEventListener("click", () => {
      calMonth -= 1;
      if (calMonth < 0) {
        calMonth = 11;
        calYear -= 1;
      }
      renderCalendar();
    });
  }

  if (calNextBtn) {
    calNextBtn.addEventListener("click", () => {
      const now = luxon.DateTime.now().setZone("Asia/Tokyo");
      const curY = now.year;
      const curM = now.month - 1;

      let nextY = calYear;
      let nextM = calMonth + 1;
      if (nextM > 11) {
        nextM = 0;
        nextY += 1;
      }

      if (nextY > curY || (nextY === curY && nextM > curM)) return;

      calYear = nextY;
      calMonth = nextM;
      renderCalendar();
    });
  }
}

/* =======================
   Range (kept)
======================= */
function syncRangeMaxNow() {
  const nowJ = luxon.DateTime.now().setZone("Asia/Tokyo").toMillis();
  const maxStr = toJstDateTimeLocalValueFromMs(nowJ);
  if (rangeStartEl) rangeStartEl.max = maxStr;
  if (rangeEndEl) rangeEndEl.max = maxStr;
}

function validateAndApplyRangeFromInputs() {
  if (!rangeStartEl || !rangeEndEl) return;

  syncRangeMaxNow();

  const nowMs = Date.now();
  const s = parseDateTimeLocalToMs(rangeStartEl.value);
  const e = parseDateTimeLocalToMs(rangeEndEl.value);

  if (!s || !e) { setMsg(""); return; }
  if (s > nowMs || e > nowMs) { setMsg("Future time is not allowed. Please select up to the current time."); return; }
  if (s >= e) { setMsg("Start must be earlier than End."); return; }

  if (e - s > MAX_RANGE_MS) {
    setMsg("Range too large. Please select 48 hours or less.");
    return;
  }

  setMsg("");

  VIEW_MODE = "range";
  selectedDayStartMs = null;
  rangeStartMs = s;
  rangeEndMs = e;

  LIVE_MODE = false;
  renderGoLiveButton();
  updateChartTitles();

  forceWindowToActiveRange();
  renderCalendar();

  subscribeToTodayData();
  updateAIUI();
}

function setupRangeAutoUpdate() {
  if (!rangeStartEl || !rangeEndEl) return;

  syncRangeMaxNow();

  const onInput = () => {
    if (RANGE_INPUT_TIMER) clearTimeout(RANGE_INPUT_TIMER);
    RANGE_INPUT_TIMER = setTimeout(() => validateAndApplyRangeFromInputs(), RANGE_INPUT_DEBOUNCE_MS);
  };

  rangeStartEl.addEventListener("input", onInput);
  rangeEndEl.addEventListener("input", onInput);

  setInterval(syncRangeMaxNow, 60 * 1000);
}

/* =======================
   CSV helpers
======================= */
function msToJst(ms) {
  if (!ms) return "";
  return new Date(ms)
    .toLocaleString("sv-SE", { timeZone: "Asia/Tokyo", hour12: false })
    .replace("T", " ");
}

function safeCsv(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows, deviceId) {
  const header = ["deviceId", "timestamp_jst", "timestamp_ms", "Temperature", "Humidity", "Pressure", "Light"];
  const lines = [header.join(",")];

  for (const r of rows) {
    const ms = tsToMs(r.timestamp);
    const line = [
      deviceId,
      msToJst(ms),
      ms ?? "",
      typeof r.Temperature === "number" ? r.Temperature : "",
      typeof r.Humidity === "number" ? r.Humidity : "",
      typeof r.Pressure === "number" ? r.Pressure : "",
      typeof r.Light === "number" ? r.Light : "",
    ].map(safeCsv).join(",");
    lines.push(line);
  }
  return lines.join("\n");
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function makeCsvFilename(deviceId, tag) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${deviceId}_${tag}_${stamp}.csv`;
}

/* =======================
   CSV actions
======================= */
function downloadCurrentViewCsv() {
  const rows = Array.isArray(CURRENT_VIEW_ROWS) ? CURRENT_VIEW_ROWS : [];
  if (!rows.length) {
    if (csvHintText) csvHintText.textContent = "No rows in current view to export.";
    return;
  }
  const csv = rowsToCsv(rows, currentDeviceId);
  downloadTextFile(makeCsvFilename(currentDeviceId, VIEW_MODE), csv);
  if (csvHintText) csvHintText.textContent = `Exported 1 file (${currentDeviceId}) with ${rows.length} rows.`;
}

async function downloadLastNDocsCsv() {
  const nRaw = parseInt(csvLimitInput?.value || "6500", 10);
  const n = Math.max(100, Math.min(20000, isNaN(nRaw) ? 6500 : nRaw));

  if (csvHintText) csvHintText.textContent = `Preparing CSV (${currentDeviceId}, last ${n} docs)...`;

  const dataCol = collection(db, "public_readings", currentDeviceId, "data");
  const qData = query(dataCol, orderBy("timestamp", "desc"), limit(n));

  try {
    const snap = await getDocs(qData);
    if (snap.empty) {
      if (csvHintText) csvHintText.textContent = "No docs found to export.";
      return;
    }

    const rows = [];
    snap.forEach((doc) => rows.push(doc.data()));
    rows.reverse();

    const csv = rowsToCsv(rows, currentDeviceId);
    downloadTextFile(makeCsvFilename(currentDeviceId, `last${rows.length}`), csv);

    if (csvHintText) csvHintText.textContent = `Exported 1 file (${currentDeviceId}) with ${rows.length} rows.`;
  } catch (e) {
    console.error("CSV export failed:", e);
    if (csvHintText) csvHintText.textContent = "CSV export failed (check console).";
  }
}

async function downloadAllDevicesCurrentViewCsv() {
  if (csvHintText) csvHintText.textContent = "Preparing CSV for all devices (current view)...";

  const win = getActiveWindow();
  const fromDate = new Date(win.from);
  const toDate = new Date(win.to);

  let totalFiles = 0;
  let totalRows = 0;

  for (const dev of DEVICES) {
    try {
      const dataCol = collection(db, "public_readings", dev.id, "data");

      if (VIEW_MODE === "day" || VIEW_MODE === "range") {
        const qWin = query(
          dataCol,
          where("timestamp", ">=", fromDate),
          where("timestamp", "<", toDate),
          orderBy("timestamp", "asc"),
          limit(WINDOW_LIMIT_DOCS)
        );
        const snap = await getDocs(qWin);
        if (snap.empty) continue;

        const rows = [];
        snap.forEach((doc) => rows.push(doc.data()));
        if (!rows.length) continue;

        const csv = rowsToCsv(rows, dev.id);
        downloadTextFile(makeCsvFilename(dev.id, VIEW_MODE), csv);

        totalFiles += 1;
        totalRows += rows.length;
      } else {
        const qLast = query(dataCol, orderBy("timestamp", "desc"), limit(FIRESTORE_LIMIT_DOCS));
        const snap = await getDocs(qLast);
        if (snap.empty) continue;

        const rows = [];
        snap.forEach((doc) => rows.push(doc.data()));
        rows.reverse();

        const rowsView = rows.filter((d) => {
          const ms = tsToMs(d.timestamp);
          return ms && ms >= win.from && ms < win.to;
        });

        const finalRows = rowsView.length === 0 ? rows : rowsView;
        if (!finalRows.length) continue;

        const csv = rowsToCsv(finalRows, dev.id);
        downloadTextFile(makeCsvFilename(dev.id, VIEW_MODE), csv);

        totalFiles += 1;
        totalRows += finalRows.length;
      }
    } catch (e) {
      console.error("All-devices current-view CSV export failed:", dev.id, e);
    }
  }

  if (csvHintText) {
    csvHintText.textContent =
      totalFiles > 0
        ? `Exported ${totalFiles} files (all devices). Total rows: ${totalRows}.`
        : "No data exported (no docs in window).";
  }
}

async function downloadAllDevicesLastNDocsCsv() {
  const nRaw = parseInt(csvLimitInput?.value || "6500", 10);
  const n = Math.max(100, Math.min(20000, isNaN(nRaw) ? 6500 : nRaw));

  if (csvHintText) csvHintText.textContent = `Preparing CSV for all devices (last ${n} docs each)...`;

  let totalFiles = 0;
  let totalRows = 0;

  for (const dev of DEVICES) {
    try {
      const dataCol = collection(db, "public_readings", dev.id, "data");
      const qData = query(dataCol, orderBy("timestamp", "desc"), limit(n));
      const snap = await getDocs(qData);
      if (snap.empty) continue;

      const rows = [];
      snap.forEach((doc) => rows.push(doc.data()));
      rows.reverse();

      const csv = rowsToCsv(rows, dev.id);
      downloadTextFile(makeCsvFilename(dev.id, `last${rows.length}`), csv);

      totalFiles += 1;
      totalRows += rows.length;
    } catch (e) {
      console.error("All-devices lastN CSV export failed:", dev.id, e);
    }
  }

  if (csvHintText) {
    csvHintText.textContent =
      totalFiles > 0
        ? `Exported ${totalFiles} files (all devices). Total rows: ${totalRows}.`
        : "No data exported (no docs).";
  }
}

function setupCsvButtons() {
  if (csvDownloadBtn) csvDownloadBtn.addEventListener("click", downloadCurrentViewCsv);
  if (csvDownloadAllBtn) csvDownloadAllBtn.addEventListener("click", downloadLastNDocsCsv);

  if (csvDownloadAllDevicesBtn) csvDownloadAllDevicesBtn.addEventListener("click", downloadAllDevicesCurrentViewCsv);
  if (csvDownloadAllDevicesLastNBtn) csvDownloadAllDevicesLastNBtn.addEventListener("click", downloadAllDevicesLastNDocsCsv);
}

/* =======================
   Language select
======================= */
function setupLangSelect() {
  if (!langSelect) return;
  langSelect.value = LANG_MODE;
  langSelect.addEventListener("change", () => {
    setLangMode(langSelect.value);
    updateAIUI();
    runGlobalAI();
  });
}

/* =======================
   Boot
======================= */
function boot() {
  initCharts();
  setupDeviceDropdown();
  setupGoLiveButton();
  setupCalendarNav();
  setupRangeAutoUpdate();     // kept
  setupLangSelect();
  setupCsvButtons();

  updateChartTitles();

  const nowJ = luxon.DateTime.now().setZone("Asia/Tokyo");
  calYear = nowJ.year;
  calMonth = nowJ.month - 1;
  renderCalendar();

  subscribeToTodayData();

  // ✅ FIXED GLOBAL MONITORING (polling)
  startGlobalMonitoring();

  startLiveClock();
  startStatusTicker();
  startDayWatcher();

  renderGoLiveButton();
  updateAIUI();
  runGlobalAI();
}

boot();
