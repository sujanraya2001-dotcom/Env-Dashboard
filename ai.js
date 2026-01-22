// ai.js (FULL - OLD FEATURES KEPT + NEW THRESHOLD-BASED GLOBAL ANOMALY)
// Upgraded AI module:
// 1) Selected-device feed: AI.update({...}) -> ONE sentence, strict EN/JP, includes numbers + exact time window.
// 2) Global monitoring: AI.evaluateGlobal({...}) -> watches ALL devices, returns toast/modal/critical escalation.
// Pure logic only (NO DOM, NO Firestore, NO Chart.js).
//
// ✅ YOUR NEW REQUIREMENT (IMPLEMENTED):
// - Upload interval = 10 sec.
// - Global anomalies MUST be based on REAL thresholds (not sensitive z-score).
// - Two types of detection:
//   A) Sudden spike (10 sec step): if |last - prev| >= spike threshold => MODAL immediately.
//   B) Slow trend: compare now vs 5 min ago and/or 10 min ago.
//      If |delta| >= slow threshold => MODAL (or CRITICAL if persists long).
//
// ✅ Offline "popup/modal" threshold is controlled by dashboard.js via alertMs.
// - buildOfflineEvent() uses alertMs (no hardcoded 120000ms).

export function createAI() {
  /* =========================
     Internal state
  ========================= */
  let cycle = 0; // message rotation for selected feed

  // Global event state: eventKey -> state
  // state = { firstSeenMs, lastSeenMs, lastFiredStage, lastToastMs, lastModalMs, lastCriticalMs, lastAckMs }
  const EVENTS = new Map();

  /* =========================
     Language
  ========================= */
  const TEXT = {
    en: {
      TITLE_LIVE: "AI Live Feed",
      TITLE_DAY: "AI Day Summary",
      TITLE_RANGE: "AI Range Summary",

      OK: "OK",
      WARN: "WARNING",
      ALERT: "ALERT",

      NO_DATA: "No data in this view yet.",
      NOT_ENOUGH: "Not enough data yet to analyze.",

      // Selected feed (trend-style with numbers + time window)
      STABLE: () => "Environment looks stable.",
      VOLATILE: (what) => `${what} is fluctuating — environment is changing.`,

      TEMP_UP: (d, from, to, hint) =>
        `Temperature increased by about ${d.toFixed(1)}°C from ${from} to ${to}.${hint ? " " + hint : ""}`,
      TEMP_DOWN: (d, from, to, hint) =>
        `Temperature decreased by about ${Math.abs(d).toFixed(1)}°C from ${from} to ${to}.${hint ? " " + hint : ""}`,

      HUM_UP: (d, from, to, hint) =>
        `Humidity increased by about ${d.toFixed(1)}% from ${from} to ${to}.${hint ? " " + hint : ""}`,
      HUM_DOWN: (d, from, to, hint) =>
        `Humidity decreased by about ${Math.abs(d).toFixed(1)}% from ${from} to ${to}.${hint ? " " + hint : ""}`,

      PRESS_UP: (d, from, to, hint) =>
        `Pressure rose by about ${d.toFixed(1)} hPa from ${from} to ${to}.${hint ? " " + hint : ""}`,
      PRESS_DOWN: (d, from, to, hint) =>
        `Pressure dropped by about ${Math.abs(d).toFixed(1)} hPa from ${from} to ${to}.${hint ? " " + hint : ""}`,

      LIGHT_UP: (d, from, to, hint) =>
        `Light increased by about ${d.toFixed(0)} lux from ${from} to ${to}.${hint ? " " + hint : ""}`,
      LIGHT_DOWN: (d, from, to, hint) =>
        `Light decreased by about ${Math.abs(d).toFixed(0)} lux from ${from} to ${to}.${hint ? " " + hint : ""}`,

      // Custom range/day one-liners
      RANGE_SUMMARY: (fromDT, toDT, focus) => `From ${fromDT} to ${toDT}, ${focus}.`,
      PEAK: (what, v, at) => `Highest ${what} was ${v} at ${at}.`,
      LOW: (what, v, at) => `Lowest ${what} was ${v} at ${at}.`,

      // Assumption hints (optional; still single sentence overall)
      HINT_HEATER: "A room heater may be on.",
      HINT_AC: "Air conditioner or ventilation may be affecting it.",
      HINT_SENSOR_HEAT: "Sensor may be exposed to heat (or a heat source nearby).",
      HINT_HUMIDIFIER: "Humidifier, shower, or cooking may be adding moisture.",
      HINT_DEHUM: "Dehumidifier or AC may be reducing moisture.",
      HINT_WEATHER: "Outdoor weather may be changing.",
      HINT_LIGHTS_ON: "Lights or sunlight likely increased.",
      HINT_LIGHTS_OFF: "Lights turned off or sunlight reduced.",

      // Device prefix
      PREFIX: (name) => `${name || "Device"}: `,

      // Global monitoring texts
      TOAST_TEMP_SPIKE: (name, d, win) => `${name}: Temperature change (${d}) ${win}.`,
      TOAST_HUM_SPIKE: (name, d, win) => `${name}: Humidity change (${d}) ${win}.`,
      TOAST_PRESS_SPIKE: (name, d, win) => `${name}: Pressure change (${d}) ${win}.`,
      TOAST_LIGHT_SPIKE: (name, d, win) => `${name}: Light change (${d}) ${win}.`,

      OFFLINE_WARN: (name, sec) => `${name}: No data for ${sec}s — device may be offline.`,
      OFFLINE_ALERT: (name, m, s) =>
        `${name}: No data for ${m}m ${s}s — upload likely failing / device offline.`,

      MODAL_REPEAT: (name, what) =>
        `${name} has shown repeated ${what} anomalies in a short period. Please be aware.`,
      MODAL_PERSIST: (name, what, mins) =>
        `${name} ${what} has remained abnormal for over ${mins} minutes. This may indicate an environmental issue or sensor exposure. Please check when possible.`,

      WHAT_TEMP: "temperature",
      WHAT_HUM: "humidity",
      WHAT_PRESS: "pressure",
      WHAT_LIGHT: "light",
    },

    jp: {
      TITLE_LIVE: "AIライブフィード",
      TITLE_DAY: "AI 1日まとめ",
      TITLE_RANGE: "AI 範囲まとめ",

      OK: "正常",
      WARN: "注意",
      ALERT: "警告",

      NO_DATA: "この表示範囲にデータがまだありません。",
      NOT_ENOUGH: "解析に十分なデータがまだありません。",

      STABLE: () => "状態は安定しています。",
      VOLATILE: (what) => `${what}に変動があります。環境の変化が起きています。`,

      TEMP_UP: (d, from, to, hint) =>
        `${from}〜${to}で温度が約${d.toFixed(1)}℃上昇しました。${hint || ""}`.trim(),
      TEMP_DOWN: (d, from, to, hint) =>
        `${from}〜${to}で温度が約${Math.abs(d).toFixed(1)}℃低下しました。${hint || ""}`.trim(),

      HUM_UP: (d, from, to, hint) =>
        `${from}〜${to}で湿度が約${d.toFixed(1)}%上昇しました。${hint || ""}`.trim(),
      HUM_DOWN: (d, from, to, hint) =>
        `${from}〜${to}で湿度が約${Math.abs(d).toFixed(1)}%低下しました。${hint || ""}`.trim(),

      PRESS_UP: (d, from, to, hint) =>
        `${from}〜${to}で気圧が約${d.toFixed(1)}hPa上昇しました。${hint || ""}`.trim(),
      PRESS_DOWN: (d, from, to, hint) =>
        `${from}〜${to}で気圧が約${Math.abs(d).toFixed(1)}hPa低下しました。${hint || ""}`.trim(),

      LIGHT_UP: (d, from, to, hint) =>
        `${from}〜${to}で照度が約${d.toFixed(0)}lux上昇しました。${hint || ""}`.trim(),
      LIGHT_DOWN: (d, from, to, hint) =>
        `${from}〜${to}で照度が約${Math.abs(d).toFixed(0)}lux低下しました。${hint || ""}`.trim(),

      RANGE_SUMMARY: (fromDT, toDT, focus) => `${fromDT}〜${toDT}で、${focus}。`,
      PEAK: (what, v, at) => `最高${what}は${at}に${v}でした。`,
      LOW: (what, v, at) => `最低${what}は${at}に${v}でした。`,

      HINT_HEATER: "暖房が入っている可能性があります。",
      HINT_AC: "空調や換気の影響の可能性があります。",
      HINT_SENSOR_HEAT: "センサーが熱源に近い／熱にさらされている可能性があります。",
      HINT_HUMIDIFIER: "加湿器・入浴・調理などで湿気が増えた可能性があります。",
      HINT_DEHUM: "除湿機やエアコンで湿度が下がった可能性があります。",
      HINT_WEATHER: "屋外の天候変化の影響かもしれません。",
      HINT_LIGHTS_ON: "照明または日光が増えた可能性があります。",
      HINT_LIGHTS_OFF: "照明OFFまたは日光が減った可能性があります。",

      PREFIX: (name) => `${name || "デバイス"}：`,

      TOAST_TEMP_SPIKE: (name, d, win) => `${name}：温度の変化（${d}）${win}。`,
      TOAST_HUM_SPIKE: (name, d, win) => `${name}：湿度の変化（${d}）${win}。`,
      TOAST_PRESS_SPIKE: (name, d, win) => `${name}：気圧の変化（${d}）${win}。`,
      TOAST_LIGHT_SPIKE: (name, d, win) => `${name}：照度の変化（${d}）${win}。`,

      OFFLINE_WARN: (name, sec) => `${name}：${sec}秒データなし（オフラインの可能性）。`,
      OFFLINE_ALERT: (name, m, s) =>
        `${name}：${m}分${s}秒データなし（送信失敗／オフラインの可能性が高い）。`,

      MODAL_REPEAT: (name, what) =>
        `${name}で短時間に${what}の異常が繰り返し検出されています。ご注意ください。`,
      MODAL_PERSIST: (name, what, mins) =>
        `${name}の${what}が${mins}分以上異常状態です。環境変化またはセンサー露出の可能性があります。可能なら確認してください。`,

      WHAT_TEMP: "温度",
      WHAT_HUM: "湿度",
      WHAT_PRESS: "気圧",
      WHAT_LIGHT: "照度",
    },
  };

  function detectLang(langMode) {
    if (langMode === "en" || langMode === "jp") return langMode;
    const b = (navigator.language || "").toLowerCase();
    return b.startsWith("ja") ? "jp" : "en";
  }

  /* =========================
     Helpers (time + math)
  ========================= */
  function tsToMs(ts) {
    if (!ts) return null;
    if (ts.toDate) return ts.toDate().getTime();
    if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ts);
    const ms = d.getTime();
    return isNaN(ms) ? null : ms;
  }

  function clampNum(x) {
    return typeof x === "number" && isFinite(x) ? x : null;
  }

  function fmtHM(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function fmtYMDHM(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}/${mo}/${da} ${hh}:${mm}`;
  }

  function mean(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const v = mean(arr.map((x) => (x - m) * (x - m)));
    return Math.sqrt(v);
  }

  function series(rows, key) {
    const out = [];
    for (const r of rows) {
      const v = clampNum(r?.[key]);
      const ms = tsToMs(r?.timestamp);
      if (v !== null && ms) out.push({ ms, v });
    }
    return out;
  }

  function lastN(arr, n) {
    if (arr.length <= n) return arr;
    return arr.slice(arr.length - n);
  }

  function deltaOverWindow(points, fromMs, toMs) {
    const within = points.filter((p) => p.ms >= fromMs && p.ms <= toMs);
    if (within.length < 2) return null;
    const first = within[0];
    const last = within[within.length - 1];
    return {
      d: last.v - first.v,
      fromMs: first.ms,
      toMs: last.ms,
      first: first.v,
      last: last.v,
    };
  }

  // Used ONLY for selected-device feed (optional insight)
  function zAnomaly(points, zTh = 2.8) {
    const vals = points.map((p) => p.v);
    if (vals.length < 12) return false;
    const m = mean(vals);
    const sd = std(vals);
    if (!sd || sd <= 1e-9) return false;
    const z = Math.abs((vals[vals.length - 1] - m) / sd);
    return z > zTh;
  }

  function getTitle(viewMode, L) {
    if (viewMode === "day") return TEXT[L].TITLE_DAY;
    if (viewMode === "range") return TEXT[L].TITLE_RANGE;
    return TEXT[L].TITLE_LIVE;
  }

  /* =========================
     Selected device feed (AI.update)
     (kept as before)
  ========================= */
  function sliceLive10Min(rows, nowMs) {
    const from = nowMs - 10 * 60 * 1000;
    const sliced = rows.filter((r) => {
      const ms = tsToMs(r.timestamp);
      return ms && ms >= from && ms <= nowMs;
    });
    return sliced.length >= 8 ? sliced : rows; // fallback
  }

  function buildSelectedMessage({
    rows,
    viewMode,
    nowMs,
    L,
    deviceName,
    rangeStartMs,
    rangeEndMs,
  }) {
    const prefix = TEXT[L].PREFIX(deviceName);

    if (!rows || rows.length === 0) {
      return { badgeLevel: "WARN", message: prefix + TEXT[L].NO_DATA };
    }
    if (rows.length < 5) {
      return { badgeLevel: "WARN", message: prefix + TEXT[L].NOT_ENOUGH };
    }

    let winFrom = null;
    let winTo = null;

    if (viewMode === "live") {
      winTo = nowMs;
      winFrom = nowMs - 10 * 60 * 1000;
    } else if (viewMode === "day") {
      const firstMs = tsToMs(rows[0]?.timestamp);
      const lastMs = tsToMs(rows[rows.length - 1]?.timestamp);
      winFrom = firstMs;
      winTo = lastMs;
    } else {
      const firstMs = tsToMs(rows[0]?.timestamp);
      const lastMs = tsToMs(rows[rows.length - 1]?.timestamp);
      winFrom = typeof rangeStartMs === "number" ? rangeStartMs : firstMs;
      winTo = typeof rangeEndMs === "number" ? Math.min(rangeEndMs, nowMs) : lastMs;
    }

    const T = series(rows, "Temperature");
    const H = series(rows, "Humidity");
    const P = series(rows, "Pressure");
    const Li = series(rows, "Light");

    // Selected feed can keep light z-score hints (does NOT trigger global modal)
    const aT = zAnomaly(lastN(T, 30));
    const aH = zAnomaly(lastN(H, 30));
    const aP = zAnomaly(lastN(P, 30));
    const aL = zAnomaly(lastN(Li, 30));

    let badgeLevel = "OK";
    if (aT || aH || aP || aL) badgeLevel = "WARN";

    cycle += 1;
    const mode = cycle % 5;

    function tempHint(deltaC, minutes) {
      const rate = Math.abs(deltaC) / Math.max(minutes, 0.1);
      if (rate >= 2.0) return TEXT[L].HINT_SENSOR_HEAT;
      if (deltaC > 0.8) return TEXT[L].HINT_HEATER;
      if (deltaC < -0.8) return TEXT[L].HINT_AC;
      return "";
    }
    function humHint(deltaPct, minutes) {
      const rate = Math.abs(deltaPct) / Math.max(minutes, 0.1);
      if (deltaPct > 4 && rate > 1.5) return TEXT[L].HINT_HUMIDIFIER;
      if (deltaPct < -4 && rate > 1.5) return TEXT[L].HINT_DEHUM;
      return "";
    }
    function pressHint(delta, minutes) {
      const rate = Math.abs(delta) / Math.max(minutes, 0.1);
      if (rate >= 0.6) return TEXT[L].HINT_WEATHER;
      return "";
    }
    function lightHint(delta) {
      if (delta > 200) return TEXT[L].HINT_LIGHTS_ON;
      if (delta < -200) return TEXT[L].HINT_LIGHTS_OFF;
      return "";
    }

    // Day / Range mode
    if (viewMode === "day" || viewMode === "range") {
      const fromDT = fmtYMDHM(winFrom || tsToMs(rows[0].timestamp));
      const toDT = fmtYMDHM(winTo || tsToMs(rows[rows.length - 1].timestamp));

      const peak = (pts) => {
        if (!pts.length) return null;
        let best = pts[0];
        for (const p of pts) if (p.v > best.v) best = p;
        return best;
      };
      const low = (pts) => {
        if (!pts.length) return null;
        let best = pts[0];
        for (const p of pts) if (p.v < best.v) best = p;
        return best;
      };

      const dT = T.length ? T[T.length - 1].v - T[0].v : null;
      const dH = H.length ? H[H.length - 1].v - H[0].v : null;
      const dP = P.length ? P[P.length - 1].v - P[0].v : null;
      const dL = Li.length ? Li[Li.length - 1].v - Li[0].v : null;

      if (mode === 0) {
        const picks = [];
        if (dT !== null && Math.abs(dT) >= 1.0)
          picks.push(L === "jp" ? `温度が約${dT.toFixed(1)}℃変化` : `temperature changed ~${dT.toFixed(1)}°C`);
        if (dH !== null && Math.abs(dH) >= 5.0)
          picks.push(L === "jp" ? `湿度が約${dH.toFixed(1)}%変化` : `humidity changed ~${dH.toFixed(1)}%`);
        if (dP !== null && Math.abs(dP) >= 1.0)
          picks.push(L === "jp" ? `気圧が約${dP.toFixed(1)}hPa変化` : `pressure changed ~${dP.toFixed(1)} hPa`);
        if (dL !== null && Math.abs(dL) >= 200)
          picks.push(L === "jp" ? `照度が約${dL.toFixed(0)}lux変化` : `light changed ~${dL.toFixed(0)} lux`);
        const focus = picks.length
          ? picks.slice(0, 2).join(L === "jp" ? "、" : ", ")
          : L === "jp"
          ? "大きな変化は少なめです"
          : "no major changes were observed";
        return { badgeLevel, message: prefix + TEXT[L].RANGE_SUMMARY(fromDT, toDT, focus) };
      }

      if (mode === 1) {
        const pkT = peak(T);
        if (pkT) {
          const v = `${pkT.v.toFixed(1)}°C`;
          const at = fmtYMDHM(pkT.ms);
          return { badgeLevel, message: prefix + TEXT[L].PEAK(L === "jp" ? "温度" : "temperature", v, at) };
        }
      }

      if (mode === 2) {
        const loH = low(H);
        if (loH) {
          const v = `${loH.v.toFixed(1)}%`;
          const at = fmtYMDHM(loH.ms);
          return { badgeLevel, message: prefix + TEXT[L].LOW(L === "jp" ? "湿度" : "humidity", v, at) };
        }
      }

      if (mode === 3) {
        if (T.length >= 2) {
          const d = T[T.length - 1].v - T[0].v;
          const from = fmtYMDHM(T[0].ms);
          const to = fmtYMDHM(T[T.length - 1].ms);
          const minutes = Math.max(1, Math.round((T[T.length - 1].ms - T[0].ms) / 60000));
          const hint = tempHint(d, minutes);
          const msg = d >= 0 ? TEXT[L].TEMP_UP(d, from, to, hint) : TEXT[L].TEMP_DOWN(d, from, to, hint);
          return { badgeLevel, message: prefix + msg };
        }
      }

      const volParts = [];
      if (T.length >= 10 && std(T.map((p) => p.v)) >= 0.8) volParts.push(L === "jp" ? "温度" : "Temperature");
      if (H.length >= 10 && std(H.map((p) => p.v)) >= 4.0) volParts.push(L === "jp" ? "湿度" : "Humidity");
      if (P.length >= 10 && std(P.map((p) => p.v)) >= 0.9) volParts.push(L === "jp" ? "気圧" : "Pressure");
      if (Li.length >= 10 && std(Li.map((p) => p.v)) >= 220) volParts.push(L === "jp" ? "照度" : "Light");
      if (volParts.length) {
        badgeLevel = "WARN";
        return { badgeLevel, message: prefix + TEXT[L].VOLATILE(volParts.join(L === "jp" ? "・" : ", ")) };
      }
      return { badgeLevel, message: prefix + TEXT[L].STABLE() };
    }

    // LIVE mode (selected feed)
    const dT = deltaOverWindow(T, winFrom, winTo);
    const dH = deltaOverWindow(H, winFrom, winTo);
    const dP = deltaOverWindow(P, winFrom, winTo);
    const dL = deltaOverWindow(Li, winFrom, winTo);

    function winStr(dObj) {
      if (!dObj) return null;
      return { from: fmtHM(dObj.fromMs), to: fmtHM(dObj.toMs) };
    }

    if (mode === 0 && dT) {
      const w = winStr(dT);
      const minutes = Math.max(1, Math.round((dT.toMs - dT.fromMs) / 60000));
      const hint = tempHint(dT.d, minutes);
      const msg = dT.d >= 0 ? TEXT[L].TEMP_UP(dT.d, w.from, w.to, hint) : TEXT[L].TEMP_DOWN(dT.d, w.from, w.to, hint);
      return { badgeLevel, message: prefix + msg };
    }

    if (mode === 1 && dH) {
      const w = winStr(dH);
      const minutes = Math.max(1, Math.round((dH.toMs - dH.fromMs) / 60000));
      const hint = humHint(dH.d, minutes);
      const msg = dH.d >= 0 ? TEXT[L].HUM_UP(dH.d, w.from, w.to, hint) : TEXT[L].HUM_DOWN(dH.d, w.from, w.to, hint);
      return { badgeLevel, message: prefix + msg };
    }

    if (mode === 2 && dP) {
      const w = winStr(dP);
      const minutes = Math.max(1, Math.round((dP.toMs - dP.fromMs) / 60000));
      const hint = pressHint(dP.d, minutes);
      const msg = dP.d >= 0 ? TEXT[L].PRESS_UP(dP.d, w.from, w.to, hint) : TEXT[L].PRESS_DOWN(dP.d, w.from, w.to, hint);
      return { badgeLevel, message: prefix + msg };
    }

    if (mode === 3 && dL) {
      const w = winStr(dL);
      const hint = lightHint(dL.d);
      const msg = dL.d >= 0 ? TEXT[L].LIGHT_UP(dL.d, w.from, w.to, hint) : TEXT[L].LIGHT_DOWN(dL.d, w.from, w.to, hint);
      return { badgeLevel, message: prefix + msg };
    }

    const volParts = [];
    const vT = std(lastN(T, 30).map((p) => p.v));
    const vH = std(lastN(H, 30).map((p) => p.v));
    const vP = std(lastN(P, 30).map((p) => p.v));
    const vLi = std(lastN(Li, 30).map((p) => p.v));

    if (T.length >= 10 && vT >= 0.8) volParts.push(L === "jp" ? "温度" : "Temperature");
    if (H.length >= 10 && vH >= 4.0) volParts.push(L === "jp" ? "湿度" : "Humidity");
    if (P.length >= 10 && vP >= 0.9) volParts.push(L === "jp" ? "気圧" : "Pressure");
    if (Li.length >= 10 && vLi >= 220) volParts.push(L === "jp" ? "照度" : "Light");

    if (volParts.length) {
      badgeLevel = "WARN";
      return { badgeLevel, message: prefix + TEXT[L].VOLATILE(volParts.join(L === "jp" ? "・" : ", ")) };
    }

    return { badgeLevel, message: prefix + TEXT[L].STABLE() };
  }

  /* =========================
     Global monitoring (AI.evaluateGlobal)
     ✅ UPDATED to threshold-based spike + slow trend
  ========================= */

  function getOrInitEvent(eventKey) {
    if (!EVENTS.has(eventKey)) {
      EVENTS.set(eventKey, {
        firstSeenMs: null,
        lastSeenMs: null,
        lastFiredStage: 0,
        lastToastMs: null,
        lastModalMs: null,
        lastCriticalMs: null,
        lastAckMs: null,
      });
    }
    return EVENTS.get(eventKey);
  }

  function acknowledgeEvent(eventKey, nowMs) {
    if (!eventKey) return;
    const st = getOrInitEvent(eventKey);
    st.lastAckMs = nowMs;
  }

  function isSnoozed(st, nowMs, snoozeMs) {
    if (!st.lastAckMs) return false;
    return nowMs - st.lastAckMs < snoozeMs;
  }

  // ✅ UPDATED: uses alertMs from input
  function buildOfflineEvent(deviceName, ageMs, alertMs, L) {
    const sec = Math.floor(ageMs / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;

    if (ageMs >= alertMs) {
      return { level: "alert", text: TEXT[L].OFFLINE_ALERT(deviceName, m, s), what: "offline" };
    }
    return { level: "warn", text: TEXT[L].OFFLINE_WARN(deviceName, sec), what: "offline" };
  }

  function formatSpikeDelta(metric, d) {
    if (metric === "Temperature") return `${d.d >= 0 ? "+" : ""}${d.d.toFixed(1)}°C`;
    if (metric === "Humidity") return `${d.d >= 0 ? "+" : ""}${d.d.toFixed(1)}%`;
    if (metric === "Pressure") return `${d.d >= 0 ? "+" : ""}${d.d.toFixed(1)} hPa`;
    if (metric === "Light") return `${d.d >= 0 ? "+" : ""}${d.d.toFixed(0)} lux`;
    return `${d.d >= 0 ? "+" : ""}${d.d.toFixed(2)}`;
  }

  function formatWin(d, L) {
    const from = fmtHM(d.fromMs);
    const to = fmtHM(d.toMs);
    return L === "jp" ? `${from}〜${to}` : `(${from}–${to})`;
  }

  function metricWhat(L, metric) {
    if (metric === "Temperature") return TEXT[L].WHAT_TEMP;
    if (metric === "Humidity") return TEXT[L].WHAT_HUM;
    if (metric === "Pressure") return TEXT[L].WHAT_PRESS;
    if (metric === "Light") return TEXT[L].WHAT_LIGHT;
    return metric;
  }

  function makeSpikeText(L, deviceName, metric, d) {
    const deltaStr = formatSpikeDelta(metric, d);
    const win = formatWin(d, L);
    if (metric === "Temperature") return TEXT[L].TOAST_TEMP_SPIKE(deviceName, deltaStr, win);
    if (metric === "Humidity") return TEXT[L].TOAST_HUM_SPIKE(deviceName, deltaStr, win);
    if (metric === "Pressure") return TEXT[L].TOAST_PRESS_SPIKE(deviceName, deltaStr, win);
    if (metric === "Light") return TEXT[L].TOAST_LIGHT_SPIKE(deviceName, deltaStr, win);
    return `${deviceName}: Sudden ${metric} change (${deltaStr}) ${win}.`;
  }

  function deltaFromWindow(points, windowMs) {
    if (points.length < 2) return null;
    const nowMs = points[points.length - 1].ms;
    const fromMs = nowMs - windowMs;
    return deltaOverWindow(points, fromMs, nowMs);
  }

  function lastStepDelta(points) {
    if (points.length < 2) return null;
    const a = points[points.length - 2];
    const b = points[points.length - 1];
    return { d: b.v - a.v, fromMs: a.ms, toMs: b.ms, first: a.v, last: b.v };
  }

  function evaluateGlobal(input) {
    const {
      devices = [],
      nowMs = Date.now(),
      langMode = "auto",
      warnMs = 45000,
      alertMs = 5 * 60 * 1000,
      repeatWindowMs = 10 * 60 * 1000,
      persistWindowMs = 30 * 60 * 1000,
      modalSnoozeMs = 5 * 60 * 1000,
      ackEventKey = null,
    } = input || {};

    const L = detectLang(langMode);

    // Apply ack first
    if (ackEventKey) acknowledgeEvent(ackEventKey, nowMs);

    // ✅ Your sampling/window model (10s upload)
    const WIN_5M = 5 * 60 * 1000;
    const WIN_10M = 10 * 60 * 1000;

    // ✅ HARD thresholds (EDIT HERE)
    // spike = single-step (about 10s)
    // slow5m = total change over last ~5 minutes
    // slow10m = total change over last ~10 minutes
    const TH = {
      Temperature: { spike: 3.0, slow5m: 3.0, slow10m: 4.0 }, // °C
      Humidity: { spike: 12.0, slow5m: 10.0, slow10m: 15.0 }, // %
      Pressure: { spike: 2.0, slow5m: 2.0, slow10m: 3.0 }, // hPa
      Light: { spike: 1500, slow5m: 1200, slow10m: 2000 }, // lux
    };

    const candidates = [];

    for (const dev of devices) {
      const deviceId = dev?.deviceId || "";
      const deviceName = dev?.deviceName || deviceId || "Device";
      const rows = Array.isArray(dev?.rows) ? dev.rows : [];
      const lastDataMs = typeof dev?.lastDataMs === "number" ? dev.lastDataMs : null;

      /* ---------- Offline detection ---------- */
      if (!lastDataMs) {
        const eventKey = `${deviceId}:offline`;
        const st = getOrInitEvent(eventKey);
        st.lastSeenMs = nowMs;
        if (!st.firstSeenMs) st.firstSeenMs = nowMs;

        if (!isSnoozed(st, nowMs, modalSnoozeMs)) {
          const ev = buildOfflineEvent(deviceName, alertMs + 1, alertMs, L);
          candidates.push({
            stage: 2,
            level: "modal",
            eventKey,
            text: ev.text,
            deviceName,
            metric: "offline",
            seenSinceMs: st.firstSeenMs,
          });
        }
        continue;
      }

      const age = nowMs - lastDataMs;

      if (age >= warnMs) {
        const eventKey = `${deviceId}:offline`;
        const st = getOrInitEvent(eventKey);
        st.lastSeenMs = nowMs;
        if (!st.firstSeenMs) st.firstSeenMs = nowMs;

        if (!isSnoozed(st, nowMs, modalSnoozeMs)) {
          const ev = buildOfflineEvent(deviceName, age, alertMs, L);

          if (age >= alertMs) {
            candidates.push({
              stage: 2,
              level: "modal",
              eventKey,
              text: ev.text,
              deviceName,
              metric: "offline",
              seenSinceMs: st.firstSeenMs,
            });
          } else {
            candidates.push({
              stage: 1,
              level: "warn",
              eventKey,
              text: ev.text,
              deviceName,
              metric: "offline",
              seenSinceMs: st.firstSeenMs,
            });
          }
        }
      } else {
        const eventKey = `${deviceId}:offline`;
        if (EVENTS.has(eventKey)) {
          const st = EVENTS.get(eventKey);
          st.firstSeenMs = null;
          st.lastSeenMs = null;
          st.lastFiredStage = 0;
        }
      }

      /* ---------- Threshold-based anomaly detection ---------- */
      const T = series(rows, "Temperature");
      const H = series(rows, "Humidity");
      const P = series(rows, "Pressure");
      const Li = series(rows, "Light");

      const metrics = [
        { key: "Temperature", pts: T },
        { key: "Humidity", pts: H },
        { key: "Pressure", pts: P },
        { key: "Light", pts: Li },
      ];

      for (const m of metrics) {
        const pts = m.pts;
        const th = TH[m.key];
        if (!th) continue;

        // Need enough data to evaluate 5m/10m windows properly
        if (pts.length < 3) continue;

        const step = lastStepDelta(pts); // ~10s step
        const d5 = pts.length >= 10 ? deltaFromWindow(pts, WIN_5M) : null;
        const d10 = pts.length >= 10 ? deltaFromWindow(pts, WIN_10M) : null;

        const spikeHit = !!(step && Math.abs(step.d) >= th.spike);
        const slow5Hit = !!(d5 && Math.abs(d5.d) >= th.slow5m);
        const slow10Hit = !!(d10 && Math.abs(d10.d) >= th.slow10m);

        const active = spikeHit || slow5Hit || slow10Hit;

        // Clear event if not active long enough
        const eventKey = `${deviceId}:${m.key}:anomaly`;
        if (!active) {
          if (EVENTS.has(eventKey)) {
            const st = EVENTS.get(eventKey);
            const quietFor = st.lastSeenMs ? nowMs - st.lastSeenMs : 0;
            if (quietFor > repeatWindowMs) {
              st.firstSeenMs = null;
              st.lastSeenMs = null;
              st.lastFiredStage = 0;
            }
          }
          continue;
        }

        // Active -> state update
        const st = getOrInitEvent(eventKey);
        st.lastSeenMs = nowMs;
        if (!st.firstSeenMs) st.firstSeenMs = nowMs;

        if (isSnoozed(st, nowMs, modalSnoozeMs)) continue;

        // Pick the delta to report (priority: spike > slow5 > slow10)
        let dUse = null;
        if (spikeHit) dUse = step;
        else if (slow5Hit) dUse = d5;
        else dUse = d10 || step;

        const text = makeSpikeText(L, deviceName, m.key, dUse);

        const seenFor = nowMs - (st.firstSeenMs || nowMs);

        // ✅ STAGING that matches your requirement:
        // - Spike: modal immediately
        // - Slow (5m/10m): modal when threshold is reached
        // - Critical only if it persists beyond persistWindowMs
        let stage = 2;
        let level = "modal";

        if (seenFor >= persistWindowMs) {
          stage = 3;
          level = "critical";
        }

        if (stage > st.lastFiredStage) st.lastFiredStage = stage;

        if (stage === 3) {
          const what = metricWhat(L, m.key);
          const mins = Math.floor(seenFor / 60000);
          candidates.push({
            stage,
            level,
            eventKey,
            text: TEXT[L].MODAL_PERSIST(deviceName, what, Math.max(30, mins)),
            deviceName,
            metric: m.key,
            seenSinceMs: st.firstSeenMs,
          });
        } else {
          // stage 2 modal (spike or slow threshold reached)
          candidates.push({
            stage,
            level,
            eventKey,
            text, // direct delta message with window
            deviceName,
            metric: m.key,
            seenSinceMs: st.firstSeenMs,
          });
        }
      }
    }

    if (!candidates.length) return { toast: null, modal: null, lang: L };

    candidates.sort((a, b) => {
      if (b.stage !== a.stage) return b.stage - a.stage;
      return (b.seenSinceMs || 0) - (a.seenSinceMs || 0);
    });

    const top = candidates[0];

    if (top.stage === 3) {
      return {
        modal: { level: "critical", text: top.text, eventKey: top.eventKey },
        toast: null,
        lang: L,
      };
    }

    // stage 2 => modal
    return {
      modal: { level: "modal", text: top.text, eventKey: top.eventKey },
      toast: null,
      lang: L,
    };
  }

  /* =========================
     Public API
  ========================= */
  return {
    update(input) {
      const {
        viewMode = "live",
        rows = [],
        nowMs = Date.now(),
        langMode = "auto",
        deviceName = "",
        rangeStartMs = null,
        rangeEndMs = null,
      } = input || {};

      const L = detectLang(langMode);

      let workingRows = rows;
      if (viewMode === "live") workingRows = sliceLive10Min(rows, nowMs);

      const { badgeLevel, message } = buildSelectedMessage({
        rows: workingRows,
        viewMode,
        nowMs,
        L,
        deviceName,
        rangeStartMs,
        rangeEndMs,
      });

      return {
        title: getTitle(viewMode, L),
        badgeLevel, // OK | WARN | ALERT (we mainly use OK/WARN here)
        message, // ONE sentence (already includes device name)
        lang: L,
      };
    },

    evaluateGlobal,
  };
}
