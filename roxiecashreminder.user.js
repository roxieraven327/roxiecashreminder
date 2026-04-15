// ==UserScript==
// @name         Torn Cash Reminder + Vault Prefill + Ghost Trade (Accordion UI)
// @namespace    roxie327-torn-reminders
// @version      4.0
// @description  Toast reminder when cash > threshold. Config panel in TM menu with accordion sections. Buttons: Faction Vault / Property Vault / Ghost Trade. Optional vault prefill rules, trade description autofill, desktop notifications, and beep fallback.
// @author       Roxie
// @match        https://www.torn.com/*
// @exclude      https://www.torn.com/loader.php?sid=attack*
// @exclude      https://www.torn.com/pc.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @downloadURL  https://raw.githubusercontent.com/roxieraven327/roxiecashreminder/main/roxiecashreminder.user.js
// @updateURL    https://raw.githubusercontent.com/roxieraven327/roxiecashreminder/main/roxiecashreminder.user.js
// ==/UserScript==

(() => {
  "use strict";

  /********************
   * HELPERS
   ********************/
  const deepClone = (obj) => JSON.parse(JSON.stringify(obj));
  const now = () => Date.now();
  const minutesToMs = (m) => m * 60 * 1000;

  function formatMoney(n) {
    return "$" + Math.floor(n).toLocaleString("en-US");
  }

  function parseMoneyText(text) {
    if (!text) return null;
    const digits = text.replace(/[^\d]/g, "");
    if (!digits) return null;
    const num = Number(digits);
    return Number.isFinite(num) ? num : null;
  }

  /********************
   * DEFAULT CONFIG
   ********************/
  const DEFAULTS = {
    thresholdCash: 0,                 // notify when cash > thresholdCash (0 = any cash)
    pollIntervalMs: 5000,             // how often we check cash
    cooldownMinutes: 30,              // cooldown after acknowledge; re-arms when cash drops <= threshold
    snoozeOptions: [30, 120, 1440],   // 30m, 2h, 1 day
    links: {
      trade: "https://www.torn.com/trade.php",
      factionVault: "https://www.torn.com/factions.php?step=your&type=1#/tab=armoury",
      propertyVault: "https://www.torn.com/properties.php#/p=options&tab=vault",
    },
    ghostIds: [],                     // up to 5 numeric IDs

    vault: {
      mode: "all",        // "all" | "fixed" | "buffer" | "percent"
      fixedAmount: 0,     // for mode "fixed"
      leaveBuffer: 0,     // for mode "buffer"
      percent: 100,       // for mode "percent"
    },

    trade: {
      descMode: "random", // "none" | "fixed" | "random"
      descFixed: "ghost trade 👻",
      descList: "ghost trade 👻\nspooky transfer 🕯️\nboo-ank deposit 💀",
    },

    desktop: {
      enable: false,
      desktopCooldownMinutes: 30,
      idleMinutes: 10, // notify if idle+cash
    },

    beep: {
      enable: false,
      beepOnIdle: true,
      volume: 0.25, // 0–1
    },
  };

  const MAX_GHOSTS = 5;

  /********************
   * STORAGE KEYS
   ********************/
  const KEYS = {
    cfg: "tcr_cfg_v4_0",
    lastAckAt: "tcr_lastAckAt",
    snoozedUntil: "tcr_snoozedUntil",
    armed: "tcr_armed",
    lastCashSeen: "tcr_lastCashSeen",

    // cross-page "pending" actions
    pendingDepositAmount: "tcr_pendingDepositAmount",
    pendingTradeDescription: "tcr_pendingTradeDescription",
    ghostIndex: "tcr_ghostIndex",

    // notifications / beep
    lastDesktopAt: "tcr_lastDesktopAt",
    lastBeepAt: "tcr_lastBeepAt",
  };

  let lastActivityTs = now(); // in-page idle tracking

  /********************
   * CONFIG LOAD/SAVE
   ********************/
  function loadConfig() {
    const saved = GM_getValue(KEYS.cfg, null);
    if (!saved || typeof saved !== "object") {
      return deepClone(DEFAULTS);
    }

    const merged = deepClone(DEFAULTS);

    // top-level primitives
    merged.thresholdCash = Number(saved.thresholdCash ?? merged.thresholdCash);
    merged.pollIntervalMs = Number(saved.pollIntervalMs ?? merged.pollIntervalMs);
    merged.cooldownMinutes = Number(saved.cooldownMinutes ?? merged.cooldownMinutes);

    if (!Number.isFinite(merged.thresholdCash)) merged.thresholdCash = DEFAULTS.thresholdCash;
    if (!Number.isFinite(merged.pollIntervalMs) || merged.pollIntervalMs < 1000) {
      merged.pollIntervalMs = DEFAULTS.pollIntervalMs;
    }
    if (!Number.isFinite(merged.cooldownMinutes) || merged.cooldownMinutes < 0) {
      merged.cooldownMinutes = DEFAULTS.cooldownMinutes;
    }

    // links
    merged.links = Object.assign(deepClone(DEFAULTS.links), saved.links || {});

    // ghost IDs
    let ghostIds = Array.isArray(saved.ghostIds) ? saved.ghostIds : [];
    ghostIds = ghostIds
      .map(String)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
    merged.ghostIds = Array.from(new Set(ghostIds)).slice(0, MAX_GHOSTS);

    // snooze options
    merged.snoozeOptions = Array.isArray(saved.snoozeOptions)
      ? saved.snoozeOptions
      : DEFAULTS.snoozeOptions;

    // vault
    merged.vault = Object.assign(deepClone(DEFAULTS.vault), saved.vault || {});
    merged.vault.fixedAmount = Number(merged.vault.fixedAmount || 0);
    merged.vault.leaveBuffer = Number(merged.vault.leaveBuffer || 0);
    merged.vault.percent = Number(merged.vault.percent || 100);
    if (!["all", "fixed", "buffer", "percent"].includes(merged.vault.mode)) {
      merged.vault.mode = "all";
    }

    // trade
    merged.trade = Object.assign(deepClone(DEFAULTS.trade), saved.trade || {});
    if (!["none", "fixed", "random"].includes(merged.trade.descMode)) {
      merged.trade.descMode = DEFAULTS.trade.descMode;
    }
    if (typeof merged.trade.descFixed !== "string") merged.trade.descFixed = DEFAULTS.trade.descFixed;
    if (typeof merged.trade.descList !== "string") merged.trade.descList = DEFAULTS.trade.descList;

    // desktop
    merged.desktop = Object.assign(deepClone(DEFAULTS.desktop), saved.desktop || {});
    merged.desktop.enable = !!merged.desktop.enable;
    merged.desktop.desktopCooldownMinutes = Number(
      merged.desktop.desktopCooldownMinutes || DEFAULTS.desktop.desktopCooldownMinutes
    );
    merged.desktop.idleMinutes = Number(merged.desktop.idleMinutes || DEFAULTS.desktop.idleMinutes);

    // beep
    merged.beep = Object.assign(deepClone(DEFAULTS.beep), saved.beep || {});
    merged.beep.enable = !!merged.beep.enable;
    merged.beep.beepOnIdle = !!merged.beep.beepOnIdle;
    merged.beep.volume = Number(merged.beep.volume);
    if (!Number.isFinite(merged.beep.volume) || merged.beep.volume < 0 || merged.beep.volume > 1) {
      merged.beep.volume = DEFAULTS.beep.volume;
    }

    return merged;
  }

  function saveConfigRaw(cfg) {
    GM_setValue(KEYS.cfg, cfg);
  }

  let CONFIG = loadConfig();

  /********************
   * STATE HELPERS
   ********************/
  function isSnoozed() {
    const until = GM_getValue(KEYS.snoozedUntil, 0);
    return now() < until;
  }

  function setSnooze(minutes) {
    GM_setValue(KEYS.snoozedUntil, now() + minutesToMs(minutes));
  }

  function clearSnooze() {
    GM_setValue(KEYS.snoozedUntil, 0);
  }

  function canShowAfterAckCooldown() {
    const lastAck = GM_getValue(KEYS.lastAckAt, 0);
    return now() - lastAck > minutesToMs(CONFIG.cooldownMinutes);
  }

  function resetCooldown() {
    GM_setValue(KEYS.lastAckAt, 0);
  }

  function acknowledge() {
    GM_setValue(KEYS.lastAckAt, now());
  }

  function isArmed() {
    const v = GM_getValue(KEYS.armed, null);
    if (v === null) return true;
    return !!v;
  }

  function setArmed(val) {
    GM_setValue(KEYS.armed, !!val);
  }

  function setPendingDeposit(amount) {
    GM_setValue(KEYS.pendingDepositAmount, String(Math.floor(Number(amount) || 0)));
  }

  function getPendingDeposit() {
    const v = String(GM_getValue(KEYS.pendingDepositAmount, "") || "").trim();
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function clearPendingDeposit() {
    GM_setValue(KEYS.pendingDepositAmount, "");
  }

  function setPendingTradeDescription(desc) {
    GM_setValue(KEYS.pendingTradeDescription, String(desc || "").trim());
  }

  function getPendingTradeDescription() {
    return String(GM_getValue(KEYS.pendingTradeDescription, "") || "").trim();
  }

  function clearPendingTradeDescription() {
    GM_setValue(KEYS.pendingTradeDescription, "");
  }

  /********************
   * CASH DETECTION
   ********************/
  function getCashOnHand() {
    const selectors = [
      "#user-money",
      "#userMoney",
      ".user-money",
      ".money",
      ".cash",
      "[data-money]",
      "[data-cash]",
      "span[id*='money']",
      "div[id*='money']",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;

      const dsMoney = el.dataset?.money || el.getAttribute("data-money");
      const dsCash = el.dataset?.cash || el.getAttribute("data-cash");
      const ds = dsMoney || dsCash;
      if (ds && /^\d+$/.test(ds)) return Number(ds);

      const txt = el.textContent?.trim();
      const val = parseMoneyText(txt);
      if (val !== null) return val;
    }

    const candidates = Array.from(document.querySelectorAll("span,div"))
      .slice(0, 650)
      .filter((n) => n.textContent && n.textContent.includes("$"));

    for (const el of candidates) {
      const t = el.textContent.trim();
      if (t.length > 0 && t.length < 30 && /\$\s*[\d,]+/.test(t)) {
        const val = parseMoneyText(t);
        if (val !== null) return val;
      }
    }

    return null;
  }

  /********************
   * GHOST HELPERS
   ********************/
  function pickNextGhostId() {
    const list = (CONFIG.ghostIds || [])
      .map(String)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));

    if (!list.length) return null;

    let idx = Number(GM_getValue(KEYS.ghostIndex, 0));
    if (!Number.isFinite(idx) || idx < 0) idx = 0;

    const chosen = list[idx % list.length];
    GM_setValue(KEYS.ghostIndex, (idx + 1) % list.length);
    return chosen;
  }

  /********************
   * AUDIO (BEEP)
   ********************/
  let audioCtx = null;

  function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function doBeep(volume = 0.25, durationMs = 250) {
    if (!CONFIG.beep.enable) return;

    const lastBeep = GM_getValue(KEYS.lastBeepAt, 0);
    if (now() - lastBeep < 1000) return;

    GM_setValue(KEYS.lastBeepAt, now());

    try {
      const ctx = ensureAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = Math.max(0, Math.min(1, volume));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => osc.stop(), durationMs);
    } catch (e) {
      console.warn("[TCR] Beep failed:", e);
    }
  }

  /********************
   * STYLES
   ********************/
  function injectStyles() {
    if (document.getElementById("tcr_styles")) return;

    const style = document.createElement("style");
    style.id = "tcr_styles";
    style.textContent = `
      .tcr-toast, .tcr-panel { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }

      .tcr-toast {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 999999;
        width: min(420px, calc(100vw - 32px));
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        border: 1px solid rgba(255,255,255,.08);
        background: rgba(20,20,24,.94);
        color: #fff;
        padding: 14px 14px 12px 14px;
        backdrop-filter: blur(6px);
      }
      .tcr-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .tcr-title { font-size:14px; font-weight:700; letter-spacing:.2px; }
      .tcr-body { margin-top:6px; font-size:13px; opacity:.92; line-height:1.35; }
      .tcr-amount { font-weight:800; opacity:1; }
      .tcr-btns { margin-top:10px; display:flex; flex-wrap:wrap; gap:8px; }
      .tcr-btn {
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.06);
        color: #fff;
        border-radius: 12px;
        padding: 8px 10px;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
      }
      .tcr-btn:hover { background: rgba(255,255,255,.10); }
      .tcr-x {
        border:none; background:transparent; color:rgba(255,255,255,.7);
        font-size:18px; cursor:pointer; line-height:1; padding:0;
      }
      .tcr-x:hover { color:#fff; }
      .tcr-note { margin-top:8px; font-size:11px; opacity:.65; }

      .tcr-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 1000000;
        width: min(520px, calc(100vw - 32px));
        max-height: min(550px, calc(100vh - 32px));
        overflow: hidden;
        display:flex;
        flex-direction:column;
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        border: 1px solid rgba(255,255,255,.10);
        background: rgba(20,20,24,.96);
        color: #fff;
        padding: 10px 10px 8px 10px;
        backdrop-filter: blur(6px);
      }
      .tcr-panel-header {
        padding: 4px 4px 4px 4px;
      }
      .tcr-panel-scroll {
        margin-top: 6px;
        padding: 0 4px 4px 4px;
        overflow-y: auto;
        flex: 1 1 auto;
      }
      .tcr-panel-footer {
        margin-top: 6px;
        padding: 4px;
        border-top: 1px solid rgba(255,255,255,.10);
      }
      .tcr-panel h3 { margin: 0; font-size: 14px; font-weight: 800; }
      .tcr-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-top: 8px;
      }
      .tcr-field {
        font-size: 12px;
      }
      .tcr-field label {
        display:block;
        font-size: 11px;
        color: rgba(255,255,255,.86);
        margin-bottom: 4px;
      }
      .tcr-field small {
        display:block;
        font-size:10px;
        color: rgba(255,255,255,.65);
        margin-top: 2px;
      }
      .tcr-field input,
      .tcr-field textarea,
      .tcr-field select {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(255,255,255,.18);
        background: rgba(255,255,255,.06);
        color: #fff;
        border-radius: 10px;
        padding: 7px 9px;
        font-size: 12px;
        outline: none;
      }
      .tcr-field textarea {
        min-height: 60px;
        resize: vertical;
      }
      .tcr-field input[type="checkbox"] {
        width:auto;
        display:inline-block;
      }

      .tcr-actions { display:flex; flex-wrap:wrap; gap:8px; }
      .tcr-actions .tcr-btn { flex: 0 0 auto; }

      .tcr-summary {
        font-size: 11px;
        opacity: .7;
        margin-bottom: 4px;
      }

      .tcr-section {
        border-top: 1px solid rgba(255,255,255,.12);
        margin-top: 6px;
        padding-top: 6px;
      }
      .tcr-section-header {
        display:flex;
        align-items:center;
        justify-content:space-between;
        cursor:pointer;
        font-size:12px;
        font-weight:600;
        color: rgba(255,255,255,.9);
        padding: 4px 2px;
      }
      .tcr-section-header span.tcr-section-title {
        display:flex;
        align-items:center;
        gap:4px;
      }
      .tcr-section-arrow {
        font-size:11px;
        opacity:.8;
        transition: transform .12s ease-out;
      }
      .tcr-section-body {
        margin-top: 4px;
        display:none;
      }
      .tcr-section.tcr-open .tcr-section-body {
        display:block;
      }
      .tcr-section.tcr-open .tcr-section-arrow {
        transform: rotate(90deg);
      }
    `;
    document.head.appendChild(style);
  }

  function removeExistingToast() {
    const existing = document.querySelector(".tcr-toast");
    if (existing) existing.remove();
  }

  function removeConfigPanel() {
    const p = document.querySelector(".tcr-panel");
    if (p) p.remove();
  }

  /********************
   * VAULT & TRADE HELPERS
   ********************/
  function computeVaultDeposit(cashAmount) {
    const c = Math.max(0, Math.floor(Number(cashAmount) || 0));
    const v = CONFIG.vault || DEFAULTS.vault;
    if (c <= 0) return 0;

    switch (v.mode) {
      case "fixed": {
        const amt = Math.floor(Number(v.fixedAmount) || 0);
        return Math.max(0, Math.min(c, amt));
      }
      case "buffer": {
        const buffer = Math.floor(Number(v.leaveBuffer) || 0);
        return Math.max(0, c - buffer);
      }
      case "percent": {
        const pct = Number(v.percent);
        if (!Number.isFinite(pct) || pct <= 0) return 0;
        const amt = Math.floor((pct / 100) * c);
        return Math.max(0, Math.min(c, amt));
      }
      case "all":
      default:
        return c;
    }
  }

  function chooseTradeDescription() {
    const t = CONFIG.trade || DEFAULTS.trade;
    if (t.descMode === "none") return "";

    if (t.descMode === "fixed") return t.descFixed || "";

    const listStr = t.descList || "";
    const entries = listStr
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!entries.length) return t.descFixed || "";
    const idx = Math.floor(Math.random() * entries.length);
    return entries[idx];
  }

  /********************
   * CONFIG PANEL (ACCORDION)
   ********************/
  function openConfigPanel() {
    injectStyles();
    removeConfigPanel();

    const panel = document.createElement("div");
    panel.className = "tcr-panel";

    const header = document.createElement("div");
    header.className = "tcr-panel-header";

    header.innerHTML = `
      <div class="tcr-row">
        <h3>Cash Reminder Settings</h3>
        <button class="tcr-x" title="Close">&times;</button>
      </div>
      <div class="tcr-summary">
        Cash &gt; ${formatMoney(CONFIG.thresholdCash)} • Vault: ${CONFIG.vault.mode.toUpperCase()} • Desktop: ${CONFIG.desktop.enable ? "ON" : "OFF"} • Beep: ${CONFIG.beep.enable ? "ON" : "OFF"}
      </div>
    `;

    header.querySelector(".tcr-x").addEventListener("click", () => panel.remove());

    const scroll = document.createElement("div");
    scroll.className = "tcr-panel-scroll";

    const secCash = document.createElement("div");
    secCash.className = "tcr-section tcr-open";
    secCash.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Cash Trigger</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label>Threshold (notify when cash &gt; this)</label>
            <input id="tcr_threshold" type="number" min="0" step="1" value="${CONFIG.thresholdCash}">
            <small>0 = any cash at all.</small>
          </div>
          <div class="tcr-field">
            <label>Cooldown minutes (after acknowledge)</label>
            <input id="tcr_cooldown" type="number" min="0" step="1" value="${CONFIG.cooldownMinutes}">
            <small>How long before another reminder is allowed.</small>
          </div>
          <div class="tcr-field">
            <label>Check frequency (ms)</label>
            <input id="tcr_poll" type="number" min="1000" step="500" value="${CONFIG.pollIntervalMs}">
            <small>How often the script checks your cash. 5000ms = every 5 seconds.</small>
          </div>
        </div>
      </div>
    `;

    const secVault = document.createElement("div");
    secVault.className = "tcr-section";
    secVault.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Vault Prefill</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label>Vault Prefill Amount</label>
            <select id="tcr_vault_mode">
              <option value="all"${CONFIG.vault.mode === "all" ? " selected" : ""}>Move ALL cash</option>
              <option value="fixed"${CONFIG.vault.mode === "fixed" ? " selected" : ""}>Fixed amount</option>
              <option value="buffer"${CONFIG.vault.mode === "buffer" ? " selected" : ""}>Leave buffer</option>
              <option value="percent"${CONFIG.vault.mode === "percent" ? " selected" : ""}>Percent of cash</option>
            </select>
            <small>This only affects the amount prefilled into vault deposit inputs.</small>
          </div>
          <div class="tcr-field">
            <label>Fixed amount (if FIXED)</label>
            <input id="tcr_vault_fixed" type="number" min="0" step="1" value="${CONFIG.vault.fixedAmount}">
          </div>
          <div class="tcr-field">
            <label>Leave on hand (if BUFFER)</label>
            <input id="tcr_vault_buffer" type="number" min="0" step="1" value="${CONFIG.vault.leaveBuffer}">
          </div>
          <div class="tcr-field">
            <label>Percent (if PERCENT)</label>
            <input id="tcr_vault_percent" type="number" min="0" max="100" step="1" value="${CONFIG.vault.percent}">
          </div>
        </div>
      </div>
    `;

    const secTrade = document.createElement("div");
    secTrade.className = "tcr-section";
    secTrade.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Trade / Ghost Trade</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label>Ghost Trade IDs (comma-separated, up to ${MAX_GHOSTS})</label>
            <textarea id="tcr_ghosts" placeholder="12345,67890,11223">${(CONFIG.ghostIds || []).join(",")}</textarea>
            <small>Used when you click Ghost Trade. Rotates through this list.</small>
          </div>
          <div class="tcr-field">
            <label>Trade description autofill</label>
            <select id="tcr_td_mode">
              <option value="none"${CONFIG.trade.descMode === "none" ? " selected" : ""}>None</option>
              <option value="fixed"${CONFIG.trade.descMode === "fixed" ? " selected" : ""}>Fixed text</option>
              <option value="random"${CONFIG.trade.descMode === "random" ? " selected" : ""}>Random from list</option>
            </select>
            <small>When you click Ghost Trade, fills the trade message box.</small>
          </div>
          <div class="tcr-field">
            <label>Fixed Description (used when mode = Fixed)</label>
            <input id="tcr_td_fixed" type="text" value="${CONFIG.trade.descFixed.replace(/"/g, "&quot;")}">
          </div>
          <div class="tcr-field" style="grid-column:1 / -1;">
            <label>Pun list (one per line, used when mode = Random)</label>
            <textarea id="tcr_td_list">${CONFIG.trade.descList}</textarea>
          </div>
        </div>
      </div>
    `;

    const perm = (typeof Notification !== "undefined" && Notification.permission) || "unsupported";

    const secDesktop = document.createElement("div");
    secDesktop.className = "tcr-section";
    secDesktop.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Desktop Notifications</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label><input id="tcr_dn_enable" type="checkbox"${CONFIG.desktop.enable ? " checked" : ""}> Enable desktop notifications</label>
            <small>Uses your browser/OS notification system.</small>
          </div>
          <div class="tcr-field">
            <label>Desktop cooldown minutes</label>
            <input id="tcr_dn_cooldown" type="number" min="0" step="1" value="${CONFIG.desktop.desktopCooldownMinutes}">
            <small>Minimum time between desktop notifs.</small>
          </div>
          <div class="tcr-field">
            <label>Idle minutes (notify if you're idle &amp; holding cash)</label>
            <input id="tcr_dn_idle" type="number" min="1" step="1" value="${CONFIG.desktop.idleMinutes}">
            <small>Also triggers if the tab is hidden.</small>
          </div>
          <div class="tcr-field">
            <label>Permission</label>
            <input id="tcr_dn_perm" type="text" value="${perm}" readonly>
            <small>Click "Test Desktop Notif" below to request permission if needed.</small>
          </div>
        </div>
      </div>
    `;

    const secBeep = document.createElement("div");
    secBeep.className = "tcr-section";
    secBeep.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Beep Fallback (in-page sound)</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label><input id="tcr_beep_enable" type="checkbox"${CONFIG.beep.enable ? " checked" : ""}> Enable beep fallback</label>
            <small>Simple browser beep when a toast / idle alert fires.</small>
          </div>
          <div class="tcr-field">
            <label><input id="tcr_beep_idle" type="checkbox"${CONFIG.beep.beepOnIdle ? " checked" : ""}> Beep on idle alert</label>
            <small>Plays a quick beep when you're idle+holding cash and an alert fires.</small>
          </div>
          <div class="tcr-field">
            <label>Beep volume (0.0–1.0)</label>
            <input id="tcr_beep_vol" type="number" min="0" max="1" step="0.05" value="${CONFIG.beep.volume}">
          </div>
        </div>
      </div>
    `;

    [secCash, secVault, secTrade, secDesktop, secBeep].forEach((sec) => {
      const headerEl = sec.querySelector(".tcr-section-header");
      headerEl.addEventListener("click", () => {
        sec.classList.toggle("tcr-open");
      });
    });

    scroll.appendChild(secCash);
    scroll.appendChild(secVault);
    scroll.appendChild(secTrade);
    scroll.appendChild(secDesktop);
    scroll.appendChild(secBeep);

    const footer = document.createElement("div");
    footer.className = "tcr-panel-footer";

    footer.innerHTML = `
      <div class="tcr-actions">
        <button class="tcr-btn" id="tcr_save">Save</button>
        <button class="tcr-btn" id="tcr_reset_cd">Reset Cooldown (re-arm)</button>
        <button class="tcr-btn" id="tcr_clear_snooze">Clear Snooze</button>
        <button class="tcr-btn" id="tcr_test_toast">Show Test Toast</button>
        <button class="tcr-btn" id="tcr_test_dn">Test Desktop Notif</button>
        <button class="tcr-btn" id="tcr_test_beep">Test Beep</button>
        <button class="tcr-btn" id="tcr_remove_toast">Remove Toast</button>
      </div>
      <div class="tcr-note">
        Re-arms when cash drops to ≤ threshold, and also after you click a vault deposit or Ghost Trade. If you change "Check frequency", refresh the page to apply.
      </div>
    `;

    footer.querySelector("#tcr_save").addEventListener("click", () => {
      const thresholdCash = Number(scroll.querySelector("#tcr_threshold").value);
      const cooldownMinutes = Number(scroll.querySelector("#tcr_cooldown").value);
      const pollIntervalMs = Number(scroll.querySelector("#tcr_poll").value);

      let ghostIds = scroll
        .querySelector("#tcr_ghosts")
        .value.split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      ghostIds = Array.from(new Set(ghostIds)).slice(0, MAX_GHOSTS);

      const vaultMode = scroll.querySelector("#tcr_vault_mode").value;
      const vaultFixed = Number(scroll.querySelector("#tcr_vault_fixed").value);
      const vaultBuffer = Number(scroll.querySelector("#tcr_vault_buffer").value);
      const vaultPercent = Number(scroll.querySelector("#tcr_vault_percent").value);

      const tdMode = scroll.querySelector("#tcr_td_mode").value;
      const tdFixed = scroll.querySelector("#tcr_td_fixed").value;
      const tdList = scroll.querySelector("#tcr_td_list").value;

      const dnEnable = scroll.querySelector("#tcr_dn_enable").checked;
      const dnCooldown = Number(scroll.querySelector("#tcr_dn_cooldown").value);
      const dnIdle = Number(scroll.querySelector("#tcr_dn_idle").value);

      const beepEnable = scroll.querySelector("#tcr_beep_enable").checked;
      const beepIdle = scroll.querySelector("#tcr_beep_idle").checked;
      const beepVol = Number(scroll.querySelector("#tcr_beep_vol").value);

      CONFIG.thresholdCash = Number.isFinite(thresholdCash) ? thresholdCash : DEFAULTS.thresholdCash;
      CONFIG.cooldownMinutes = Number.isFinite(cooldownMinutes) ? cooldownMinutes : DEFAULTS.cooldownMinutes;
      CONFIG.pollIntervalMs =
        Number.isFinite(pollIntervalMs) && pollIntervalMs >= 1000
          ? pollIntervalMs
          : DEFAULTS.pollIntervalMs;

      CONFIG.ghostIds = ghostIds;

      CONFIG.vault.mode = ["all", "fixed", "buffer", "percent"].includes(vaultMode)
        ? vaultMode
        : "all";
      CONFIG.vault.fixedAmount = Number.isFinite(vaultFixed) ? vaultFixed : 0;
      CONFIG.vault.leaveBuffer = Number.isFinite(vaultBuffer) ? vaultBuffer : 0;
      CONFIG.vault.percent = Number.isFinite(vaultPercent) ? vaultPercent : 100;

      CONFIG.trade.descMode = ["none", "fixed", "random"].includes(tdMode) ? tdMode : "random";
      CONFIG.trade.descFixed = tdFixed;
      CONFIG.trade.descList = tdList;

      CONFIG.desktop.enable = dnEnable;
      CONFIG.desktop.desktopCooldownMinutes = Number.isFinite(dnCooldown)
        ? dnCooldown
        : DEFAULTS.desktop.desktopCooldownMinutes;
      CONFIG.desktop.idleMinutes = Number.isFinite(dnIdle)
        ? dnIdle
        : DEFAULTS.desktop.idleMinutes;

      CONFIG.beep.enable = beepEnable;
      CONFIG.beep.beepOnIdle = beepIdle;
      CONFIG.beep.volume =
        Number.isFinite(beepVol) && beepVol >= 0 && beepVol <= 1 ? beepVol : DEFAULTS.beep.volume;

      saveConfigRaw(CONFIG);

      resetCooldown();
      clearSnooze();
      setArmed(true);

      alert(
        "Saved ✅\n\nCooldown reset + snooze cleared + reminder re-armed.\n(Refresh page if you changed Check frequency.)"
      );
    });

    footer.querySelector("#tcr_reset_cd").addEventListener("click", () => {
      resetCooldown();
      clearSnooze();
      setArmed(true);
      alert("Cooldown reset + re-armed ✅");
    });

    footer.querySelector("#tcr_clear_snooze").addEventListener("click", () => {
      clearSnooze();
      alert("Snooze cleared ✅");
    });

    footer.querySelector("#tcr_test_toast").addEventListener("click", () => {
      const cash = getCashOnHand();
      showToast(Number.isFinite(cash) ? cash : 123456);
    });

    footer.querySelector("#tcr_remove_toast").addEventListener("click", () => {
      removeExistingToast();
    });

    footer.querySelector("#tcr_test_dn").addEventListener("click", async () => {
      await ensureNotificationPermission();
      sendDesktopNotification(123456, "test");
      const permNow =
        (typeof Notification !== "undefined" && Notification.permission) || "unsupported";
      const permInput = scroll.querySelector("#tcr_dn_perm");
      if (permInput) permInput.value = permNow;
    });

    footer.querySelector("#tcr_test_beep").addEventListener("click", () => {
      doBeep(CONFIG.beep.volume || 0.25);
    });

    panel.appendChild(header);
    panel.appendChild(scroll);
    panel.appendChild(footer);

    document.body.appendChild(panel);
  }

  /********************
   * TOAST UI
   ********************/
  function showToast(cashAmount) {
    injectStyles();
    removeExistingToast();

    const toast = document.createElement("div");
    toast.className = "tcr-toast";

    const header = document.createElement("div");
    header.className = "tcr-row";

    const title = document.createElement("div");
    title.className = "tcr-title";
    title.textContent = "Cash Reminder";

    const close = document.createElement("button");
    close.className = "tcr-x";
    close.innerHTML = "&times;";
    close.title = "Dismiss";
    close.addEventListener("click", () => {
      acknowledge();
      toast.remove();
    });

    header.appendChild(title);
    header.appendChild(close);

    const body = document.createElement("div");
    body.className = "tcr-body";
    body.innerHTML = `You're holding <span class="tcr-amount">${formatMoney(
      cashAmount
    )}</span>. Consider moving it.`;

    const btns = document.createElement("div");
    btns.className = "tcr-btns";

    const tradeBtn = document.createElement("button");
    tradeBtn.className = "tcr-btn";
    tradeBtn.textContent = "Trade (Ghost Trade)";
    tradeBtn.addEventListener("click", () => {
      acknowledge();
      const gid = pickNextGhostId();
      const desc = chooseTradeDescription();
      if (desc) setPendingTradeDescription(desc);

      if (gid) {
        window.location.href = `${CONFIG.links.trade}#step=start&userID=${gid}`;
      } else {
        window.location.href = CONFIG.links.trade;
      }
    });
    btns.appendChild(tradeBtn);

    const facBtn = document.createElement("button");
    facBtn.className = "tcr-btn";
    facBtn.textContent = "Faction Vault";
    facBtn.addEventListener("click", () => {
      acknowledge();
      const deposit = computeVaultDeposit(cashAmount);
      setPendingDeposit(deposit);
      window.location.href = CONFIG.links.factionVault;
    });
    btns.appendChild(facBtn);

    const propBtn = document.createElement("button");
    propBtn.className = "tcr-btn";
    propBtn.textContent = "Property Vault";
    propBtn.addEventListener("click", () => {
      acknowledge();
      const deposit = computeVaultDeposit(cashAmount);
      setPendingDeposit(deposit);
      window.location.href = CONFIG.links.propertyVault;
    });
    btns.appendChild(propBtn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "tcr-btn";
    copyBtn.textContent = "Copy Amount";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(Math.floor(cashAmount)));
        copyBtn.textContent = "Copied ✅";
      } catch {
        copyBtn.textContent = "Copy failed ❌";
      }
      setTimeout(() => (copyBtn.textContent = "Copy Amount"), 1500);
    });
    btns.appendChild(copyBtn);

    for (const mins of CONFIG.snoozeOptions) {
      const snoozeBtn = document.createElement("button");
      snoozeBtn.className = "tcr-btn";
      snoozeBtn.textContent =
        mins >= 1440 ? "Snooze 1 day" :
        mins >= 60 ? `Snooze ${Math.floor(mins / 60)}h` :
        `Snooze ${mins}m`;
      snoozeBtn.addEventListener("click", () => {
        setSnooze(mins);
        acknowledge();
        toast.remove();
      });
      btns.appendChild(snoozeBtn);
    }

    const note = document.createElement("div");
    note.className = "tcr-note";
    note.textContent =
      `Threshold: cash > ${formatMoney(CONFIG.thresholdCash)} • ` +
      `Cooldown after ack: ${CONFIG.cooldownMinutes}m • ` +
      `Re-arms when cash ≤ threshold`;

    toast.appendChild(header);
    toast.appendChild(body);
    toast.appendChild(btns);
    toast.appendChild(note);

    document.body.appendChild(toast);

    doBeep(CONFIG.beep.volume || 0.25);
  }

  /********************
   * PAGE CONTEXT HELPERS
   ********************/
  function onFactionVaultTab() {
    return (
      location.pathname.includes("/factions.php") && String(location.hash || "").includes("tab=armoury")
    );
  }

  function onPropertyVaultTab() {
    return (
      location.pathname.includes("/properties.php") &&
      String(location.hash || "").includes("tab=vault")
    );
  }

  function onTradePage() {
    return location.pathname.includes("/trade.php");
  }

  function fillInput(el, value) {
    el.focus();
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function tryPrefillVaultOnce() {
    const amount = getPendingDeposit();
    if (!amount || amount <= 0) return;

    if (onFactionVaultTab()) {
      const input = document.querySelector("#armoury-donate input.input-money");
      if (input) {
        fillInput(input, amount);
        clearPendingDeposit();
        console.log(`[TCR] Prefilled FACTION vault with ${amount}`);
      }
      return;
    }

    if (onPropertyVaultTab()) {
      const selectors = [
        "#property-money input.input-money",
        "input.input-money",
        "input[name='amount']",
        "input#amount",
        "input[name='money']",
        "input#money",
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          fillInput(el, amount);
          clearPendingDeposit();
          console.log(`[TCR] Prefilled PROPERTY vault with ${amount} via selector: ${sel}`);
          break;
        }
      }
    }
  }

  function tryPrefillTradeOnce() {
    const desc = getPendingTradeDescription();
    if (!desc) return;
    if (!onTradePage()) return;

    const selectors = [
      "textarea#description",
      "textarea[name='description']",
      "form textarea#description",
      "form textarea[name='description']",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        fillInput(el, desc);
        clearPendingTradeDescription();
        console.log("[TCR] Prefilled trade description.");
        return;
      }
    }
  }

  function startPrefillObserver() {
    const obs = new MutationObserver(() => {
      tryPrefillVaultOnce();
      if (onTradePage()) tryPrefillTradeOnce();
    });
    obs.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      tryPrefillVaultOnce();
      if (onTradePage()) tryPrefillTradeOnce();
    }, 250);
    setTimeout(() => {
      tryPrefillVaultOnce();
      if (onTradePage()) tryPrefillTradeOnce();
    }, 1000);
  }

  /********************
   * DESKTOP NOTIFICATIONS
   ********************/
  async function ensureNotificationPermission() {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;

    try {
      const res = await Notification.requestPermission();
      return res === "granted";
    } catch {
      return false;
    }
  }

  function sendDesktopNotification(cashAmount, reason) {
    if (!CONFIG.desktop.enable) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    const last = GM_getValue(KEYS.lastDesktopAt, 0);
    const minDelta = minutesToMs(CONFIG.desktop.desktopCooldownMinutes || 0);
    if (now() - last < minDelta) return;

    GM_setValue(KEYS.lastDesktopAt, now());

    const body =
      reason === "idle"
        ? `You've been idle and are still holding ${formatMoney(cashAmount)}.`
        : `You're holding ${formatMoney(cashAmount)}. Consider moving it.`;

    try {
      new Notification("Torn Cash Reminder", {
        body,
        icon: "https://www.torn.com/favicon.ico",
      });
    } catch (e) {
      console.warn("[TCR] Desktop notification failed:", e);
    }
  }

  function checkIdleDesktopAndBeep(cashAmount) {
    if (!CONFIG.desktop.enable) return;
    if (cashAmount <= CONFIG.thresholdCash) return;

    const idleMs = minutesToMs(CONFIG.desktop.idleMinutes || DEFAULTS.desktop.idleMinutes);
    const isIdle = document.hidden || now() - lastActivityTs >= idleMs;

    if (!isIdle) return;

    sendDesktopNotification(cashAmount, "idle");

    if (CONFIG.beep.enable && CONFIG.beep.beepOnIdle) {
      doBeep(CONFIG.beep.volume || 0.25);
    }
  }

  window.addEventListener("beforeunload", () => {
    if (!CONFIG.desktop.enable) return;
    const cash = GM_getValue(KEYS.lastCashSeen, 0);
    if (!cash || cash <= CONFIG.thresholdCash) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    try {
      new Notification("Torn Cash Reminder", {
        body: `You closed Torn while holding ${formatMoney(cash)}.`,
        icon: "https://www.torn.com/favicon.ico",
      });
    } catch (e) {
      console.warn("[TCR] beforeunload notification failed:", e);
    }
  });

  /********************
   * TAMPERMONKEY MENU
   ********************/
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;

    GM_registerMenuCommand("⚙ Open Cash Reminder Settings", () => openConfigPanel());
    GM_registerMenuCommand("⏱ Reset Cooldown (re-arm)", () => {
      resetCooldown();
      clearSnooze();
      setArmed(true);
      alert("Cooldown reset + re-armed ✅");
    });
    GM_registerMenuCommand("🔕 Clear Snooze", () => {
      clearSnooze();
      alert("Snooze cleared ✅");
    });
    GM_registerMenuCommand("🧪 Show Test Toast", () => {
      const cash = getCashOnHand();
      showToast(Number.isFinite(cash) ? cash : 123456);
    });
    GM_registerMenuCommand("🧪 Test Desktop Notif", async () => {
      await ensureNotificationPermission();
      sendDesktopNotification(123456, "test");
      alert("If permission is granted, you should see a desktop notification.");
    });
    GM_registerMenuCommand("🔊 Test Beep", () => {
      doBeep(CONFIG.beep.volume || 0.25);
    });
    GM_registerMenuCommand("🧹 Remove Toast", () => removeExistingToast());
  }

  /********************
   * MAIN LOOP
   ********************/
  function tick() {
    if (isSnoozed()) return;

    const cash = getCashOnHand();
    if (cash === null) return;

    GM_setValue(KEYS.lastCashSeen, cash);

    if (cash <= CONFIG.thresholdCash) {
      setArmed(true);
      return;
    }

    const armed = isArmed();
    const cooldownOk = canShowAfterAckCooldown();

    if (armed || cooldownOk) {
      showToast(cash);
      setArmed(false);
    }

    checkIdleDesktopAndBeep(cash);
  }

  /********************
   * ACTIVITY TRACKING
   ********************/
  function bumpActivity() {
    lastActivityTs = now();
  }

  ["mousemove", "keydown", "click", "scroll"].forEach((evt) => {
    window.addEventListener(evt, bumpActivity, { passive: true });
  });
  document.addEventListener("visibilitychange", bumpActivity);

  /********************
   * STARTUP
   ********************/
  injectStyles();

  if (GM_getValue(KEYS.armed, null) === null) {
    setArmed(true);
  }

  registerMenu();
  startPrefillObserver();

  window.addEventListener("hashchange", () => {
    tryPrefillVaultOnce();
    if (onTradePage()) tryPrefillTradeOnce();
  });

  setInterval(tick, CONFIG.pollIntervalMs);
  setTimeout(tick, 2500);
})();// ==UserScript==
// @name         Torn Cash Reminder + Vault Prefill + Ghost Trade (Accordion UI)
// @namespace    roxie327-torn-reminders
// @version      3.2.1
// @description  Toast reminder when cash > threshold. Config panel in TM menu with accordion sections. Buttons: Faction Vault / Property Vault / Ghost Trade. Optional vault prefill rules, trade description autofill, desktop notifications, and beep fallback.
// @author       Roxie + ChatGPT
// @match        https://www.torn.com/*
// @exclude      https://www.torn.com/loader.php?sid=attack*
// @exclude      https://www.torn.com/pc.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  "use strict";

  /********************
   * HELPERS
   ********************/
  const deepClone = (obj) => JSON.parse(JSON.stringify(obj));
  const now = () => Date.now();
  const minutesToMs = (m) => m * 60 * 1000;

  function formatMoney(n) {
    return "$" + Math.floor(n).toLocaleString("en-US");
  }

  function parseMoneyText(text) {
    if (!text) return null;
    const digits = text.replace(/[^\d]/g, "");
    if (!digits) return null;
    const num = Number(digits);
    return Number.isFinite(num) ? num : null;
  }

  /********************
   * DEFAULT CONFIG
   ********************/
  const DEFAULTS = {
    thresholdCash: 0,                 // notify when cash > thresholdCash (0 = any cash)
    pollIntervalMs: 5000,             // how often we check cash
    cooldownMinutes: 30,              // cooldown after acknowledge; re-arms when cash drops <= threshold
    snoozeOptions: [30, 120, 1440],   // 30m, 2h, 1 day
    links: {
      trade: "https://www.torn.com/trade.php",
      factionVault: "https://www.torn.com/factions.php?step=your&type=1#/tab=armoury",
      propertyVault: "https://www.torn.com/properties.php#/p=options&tab=vault",
    },
    ghostIds: [],                     // up to 5 numeric IDs

    vault: {
      mode: "all",        // "all" | "fixed" | "buffer" | "percent"
      fixedAmount: 0,     // for mode "fixed"
      leaveBuffer: 0,     // for mode "buffer"
      percent: 100,       // for mode "percent"
    },

    trade: {
      descMode: "random", // "none" | "fixed" | "random"
      descFixed: "ghost trade 👻",
      descList: "ghost trade 👻\nspooky transfer 🕯️\nboo-ank deposit 💀",
    },

    desktop: {
      enable: false,
      desktopCooldownMinutes: 30,
      idleMinutes: 10, // notify if idle+cash
    },

    beep: {
      enable: false,
      beepOnIdle: true,
      volume: 0.25, // 0–1
    },
  };

  const MAX_GHOSTS = 5;

  /********************
   * STORAGE KEYS
   ********************/
  const KEYS = {
    cfg: "tcr_cfg_v3_2_1",
    lastAckAt: "tcr_lastAckAt",
    snoozedUntil: "tcr_snoozedUntil",
    armed: "tcr_armed",
    lastCashSeen: "tcr_lastCashSeen",

    // cross-page “pending” actions
    pendingDepositAmount: "tcr_pendingDepositAmount",
    pendingTradeDescription: "tcr_pendingTradeDescription",
    ghostIndex: "tcr_ghostIndex",

    // notifications / beep
    lastDesktopAt: "tcr_lastDesktopAt",
    lastBeepAt: "tcr_lastBeepAt",
  };

  let lastActivityTs = now(); // in-page idle tracking

  /********************
   * CONFIG LOAD/SAVE
   ********************/
  function loadConfig() {
    const saved = GM_getValue(KEYS.cfg, null);
    if (!saved || typeof saved !== "object") {
      return deepClone(DEFAULTS);
    }

    const merged = deepClone(DEFAULTS);

    // top-level primitives
    merged.thresholdCash = Number(saved.thresholdCash ?? merged.thresholdCash);
    merged.pollIntervalMs = Number(saved.pollIntervalMs ?? merged.pollIntervalMs);
    merged.cooldownMinutes = Number(saved.cooldownMinutes ?? merged.cooldownMinutes);

    if (!Number.isFinite(merged.thresholdCash)) merged.thresholdCash = DEFAULTS.thresholdCash;
    if (!Number.isFinite(merged.pollIntervalMs) || merged.pollIntervalMs < 1000) {
      merged.pollIntervalMs = DEFAULTS.pollIntervalMs;
    }
    if (!Number.isFinite(merged.cooldownMinutes) || merged.cooldownMinutes < 0) {
      merged.cooldownMinutes = DEFAULTS.cooldownMinutes;
    }

    // links
    merged.links = Object.assign(deepClone(DEFAULTS.links), saved.links || {});

    // ghost IDs
    let ghostIds = Array.isArray(saved.ghostIds) ? saved.ghostIds : [];
    ghostIds = ghostIds
      .map(String)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
    merged.ghostIds = Array.from(new Set(ghostIds)).slice(0, MAX_GHOSTS);

    // snooze options
    merged.snoozeOptions = Array.isArray(saved.snoozeOptions)
      ? saved.snoozeOptions
      : DEFAULTS.snoozeOptions;

    // vault
    merged.vault = Object.assign(deepClone(DEFAULTS.vault), saved.vault || {});
    merged.vault.fixedAmount = Number(merged.vault.fixedAmount || 0);
    merged.vault.leaveBuffer = Number(merged.vault.leaveBuffer || 0);
    merged.vault.percent = Number(merged.vault.percent || 100);
    if (!["all", "fixed", "buffer", "percent"].includes(merged.vault.mode)) {
      merged.vault.mode = "all";
    }

    // trade
    merged.trade = Object.assign(deepClone(DEFAULTS.trade), saved.trade || {});
    if (!["none", "fixed", "random"].includes(merged.trade.descMode)) {
      merged.trade.descMode = DEFAULTS.trade.descMode;
    }
    if (typeof merged.trade.descFixed !== "string") merged.trade.descFixed = DEFAULTS.trade.descFixed;
    if (typeof merged.trade.descList !== "string") merged.trade.descList = DEFAULTS.trade.descList;

    // desktop
    merged.desktop = Object.assign(deepClone(DEFAULTS.desktop), saved.desktop || {});
    merged.desktop.enable = !!merged.desktop.enable;
    merged.desktop.desktopCooldownMinutes = Number(
      merged.desktop.desktopCooldownMinutes || DEFAULTS.desktop.desktopCooldownMinutes
    );
    merged.desktop.idleMinutes = Number(merged.desktop.idleMinutes || DEFAULTS.desktop.idleMinutes);

    // beep
    merged.beep = Object.assign(deepClone(DEFAULTS.beep), saved.beep || {});
    merged.beep.enable = !!merged.beep.enable;
    merged.beep.beepOnIdle = !!merged.beep.beepOnIdle;
    merged.beep.volume = Number(merged.beep.volume);
    if (!Number.isFinite(merged.beep.volume) || merged.beep.volume < 0 || merged.beep.volume > 1) {
      merged.beep.volume = DEFAULTS.beep.volume;
    }

    return merged;
  }

  function saveConfigRaw(cfg) {
    GM_setValue(KEYS.cfg, cfg);
  }

  let CONFIG = loadConfig();

  /********************
   * STATE HELPERS
   ********************/
  function isSnoozed() {
    const until = GM_getValue(KEYS.snoozedUntil, 0);
    return now() < until;
  }

  function setSnooze(minutes) {
    GM_setValue(KEYS.snoozedUntil, now() + minutesToMs(minutes));
  }

  function clearSnooze() {
    GM_setValue(KEYS.snoozedUntil, 0);
  }

  function canShowAfterAckCooldown() {
    const lastAck = GM_getValue(KEYS.lastAckAt, 0);
    return now() - lastAck > minutesToMs(CONFIG.cooldownMinutes);
  }

  function resetCooldown() {
    GM_setValue(KEYS.lastAckAt, 0);
  }

  function acknowledge() {
    GM_setValue(KEYS.lastAckAt, now());
  }

  function isArmed() {
    const v = GM_getValue(KEYS.armed, null);
    if (v === null) return true;
    return !!v;
  }

  function setArmed(val) {
    GM_setValue(KEYS.armed, !!val);
  }

  function setPendingDeposit(amount) {
    GM_setValue(KEYS.pendingDepositAmount, String(Math.floor(Number(amount) || 0)));
  }

  function getPendingDeposit() {
    const v = String(GM_getValue(KEYS.pendingDepositAmount, "") || "").trim();
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function clearPendingDeposit() {
    GM_setValue(KEYS.pendingDepositAmount, "");
  }

  function setPendingTradeDescription(desc) {
    GM_setValue(KEYS.pendingTradeDescription, String(desc || "").trim());
  }

  function getPendingTradeDescription() {
    return String(GM_getValue(KEYS.pendingTradeDescription, "") || "").trim();
  }

  function clearPendingTradeDescription() {
    GM_setValue(KEYS.pendingTradeDescription, "");
  }

  /********************
   * CASH DETECTION
   ********************/
  function getCashOnHand() {
    const selectors = [
      "#user-money",
      "#userMoney",
      ".user-money",
      ".money",
      ".cash",
      "[data-money]",
      "[data-cash]",
      "span[id*='money']",
      "div[id*='money']",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;

      const dsMoney = el.dataset?.money || el.getAttribute("data-money");
      const dsCash = el.dataset?.cash || el.getAttribute("data-cash");
      const ds = dsMoney || dsCash;
      if (ds && /^\d+$/.test(ds)) return Number(ds);

      const txt = el.textContent?.trim();
      const val = parseMoneyText(txt);
      if (val !== null) return val;
    }

    const candidates = Array.from(document.querySelectorAll("span,div"))
      .slice(0, 650)
      .filter((n) => n.textContent && n.textContent.includes("$"));

    for (const el of candidates) {
      const t = el.textContent.trim();
      if (t.length > 0 && t.length < 30 && /\$\s*[\d,]+/.test(t)) {
        const val = parseMoneyText(t);
        if (val !== null) return val;
      }
    }

    return null;
  }

  /********************
   * GHOST HELPERS
   ********************/
  function pickNextGhostId() {
    const list = (CONFIG.ghostIds || [])
      .map(String)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));

    if (!list.length) return null;

    let idx = Number(GM_getValue(KEYS.ghostIndex, 0));
    if (!Number.isFinite(idx) || idx < 0) idx = 0;

    const chosen = list[idx % list.length];
    GM_setValue(KEYS.ghostIndex, (idx + 1) % list.length);
    return chosen;
  }

  /********************
   * AUDIO (BEEP)
   ********************/
  let audioCtx = null;

  function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function doBeep(volume = 0.25, durationMs = 250) {
    if (!CONFIG.beep.enable) return;

    const lastBeep = GM_getValue(KEYS.lastBeepAt, 0);
    if (now() - lastBeep < 1000) return;

    GM_setValue(KEYS.lastBeepAt, now());

    try {
      const ctx = ensureAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = Math.max(0, Math.min(1, volume));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => osc.stop(), durationMs);
    } catch (e) {
      console.warn("[TCR] Beep failed:", e);
    }
  }

  /********************
   * STYLES
   ********************/
  function injectStyles() {
    if (document.getElementById("tcr_styles")) return;

    const style = document.createElement("style");
    style.id = "tcr_styles";
    style.textContent = `
      .tcr-toast, .tcr-panel { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }

      .tcr-toast {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 999999;
        width: min(420px, calc(100vw - 32px));
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        border: 1px solid rgba(255,255,255,.08);
        background: rgba(20,20,24,.94);
        color: #fff;
        padding: 14px 14px 12px 14px;
        backdrop-filter: blur(6px);
      }
      .tcr-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .tcr-title { font-size:14px; font-weight:700; letter-spacing:.2px; }
      .tcr-body { margin-top:6px; font-size:13px; opacity:.92; line-height:1.35; }
      .tcr-amount { font-weight:800; opacity:1; }
      .tcr-btns { margin-top:10px; display:flex; flex-wrap:wrap; gap:8px; }
      .tcr-btn {
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.06);
        color: #fff;
        border-radius: 12px;
        padding: 8px 10px;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
      }
      .tcr-btn:hover { background: rgba(255,255,255,.10); }
      .tcr-x {
        border:none; background:transparent; color:rgba(255,255,255,.7);
        font-size:18px; cursor:pointer; line-height:1; padding:0;
      }
      .tcr-x:hover { color:#fff; }
      .tcr-note { margin-top:8px; font-size:11px; opacity:.65; }

      .tcr-panel {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 1000000;
        width: min(520px, calc(100vw - 32px));
        max-height: min(550px, calc(100vh - 32px));
        overflow: hidden;
        display:flex;
        flex-direction:column;
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.35);
        border: 1px solid rgba(255,255,255,.10);
        background: rgba(20,20,24,.96);
        color: #fff;
        padding: 10px 10px 8px 10px;
        backdrop-filter: blur(6px);
      }
      .tcr-panel-header {
        padding: 4px 4px 4px 4px;
      }
      .tcr-panel-scroll {
        margin-top: 6px;
        padding: 0 4px 4px 4px;
        overflow-y: auto;
        flex: 1 1 auto;
      }
      .tcr-panel-footer {
        margin-top: 6px;
        padding: 4px;
        border-top: 1px solid rgba(255,255,255,.10);
      }
      .tcr-panel h3 { margin: 0; font-size: 14px; font-weight: 800; }
      .tcr-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-top: 8px;
      }
      .tcr-field {
        font-size: 12px;
      }
      .tcr-field label {
        display:block;
        font-size: 11px;
        color: rgba(255,255,255,.86);
        margin-bottom: 4px;
      }
      .tcr-field small {
        display:block;
        font-size:10px;
        color: rgba(255,255,255,.65);
        margin-top: 2px;
      }
      .tcr-field input,
      .tcr-field textarea,
      .tcr-field select {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid rgba(255,255,255,.18);
        background: rgba(255,255,255,.06);
        color: #fff;
        border-radius: 10px;
        padding: 7px 9px;
        font-size: 12px;
        outline: none;
      }
      .tcr-field textarea {
        min-height: 60px;
        resize: vertical;
      }
      .tcr-field input[type="checkbox"] {
        width:auto;
        display:inline-block;
      }

      .tcr-actions { display:flex; flex-wrap:wrap; gap:8px; }
      .tcr-actions .tcr-btn { flex: 0 0 auto; }

      .tcr-summary {
        font-size: 11px;
        opacity: .7;
        margin-bottom: 4px;
      }

      .tcr-section {
        border-top: 1px solid rgba(255,255,255,.12);
        margin-top: 6px;
        padding-top: 6px;
      }
      .tcr-section-header {
        display:flex;
        align-items:center;
        justify-content:space-between;
        cursor:pointer;
        font-size:12px;
        font-weight:600;
        color: rgba(255,255,255,.9);
        padding: 4px 2px;
      }
      .tcr-section-header span.tcr-section-title {
        display:flex;
        align-items:center;
        gap:4px;
      }
      .tcr-section-arrow {
        font-size:11px;
        opacity:.8;
        transition: transform .12s ease-out;
      }
      .tcr-section-body {
        margin-top: 4px;
        display:none;
      }
      .tcr-section.tcr-open .tcr-section-body {
        display:block;
      }
      .tcr-section.tcr-open .tcr-section-arrow {
        transform: rotate(90deg);
      }
    `;
    document.head.appendChild(style);
  }

  function removeExistingToast() {
    const existing = document.querySelector(".tcr-toast");
    if (existing) existing.remove();
  }

  function removeConfigPanel() {
    const p = document.querySelector(".tcr-panel");
    if (p) p.remove();
  }

  /********************
   * VAULT & TRADE HELPERS
   ********************/
  function computeVaultDeposit(cashAmount) {
    const c = Math.max(0, Math.floor(Number(cashAmount) || 0));
    const v = CONFIG.vault || DEFAULTS.vault;
    if (c <= 0) return 0;

    switch (v.mode) {
      case "fixed": {
        const amt = Math.floor(Number(v.fixedAmount) || 0);
        return Math.max(0, Math.min(c, amt));
      }
      case "buffer": {
        const buffer = Math.floor(Number(v.leaveBuffer) || 0);
        return Math.max(0, c - buffer);
      }
      case "percent": {
        const pct = Number(v.percent);
        if (!Number.isFinite(pct) || pct <= 0) return 0;
        const amt = Math.floor((pct / 100) * c);
        return Math.max(0, Math.min(c, amt));
      }
      case "all":
      default:
        return c;
    }
  }

  function chooseTradeDescription() {
    const t = CONFIG.trade || DEFAULTS.trade;
    if (t.descMode === "none") return "";

    if (t.descMode === "fixed") return t.descFixed || "";

    const listStr = t.descList || "";
    const entries = listStr
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!entries.length) return t.descFixed || "";
    const idx = Math.floor(Math.random() * entries.length);
    return entries[idx];
  }

  /********************
   * CONFIG PANEL (ACCORDION)
   ********************/
  function openConfigPanel() {
    injectStyles();
    removeConfigPanel();

    const panel = document.createElement("div");
    panel.className = "tcr-panel";

    const header = document.createElement("div");
    header.className = "tcr-panel-header";

    header.innerHTML = `
      <div class="tcr-row">
        <h3>Cash Reminder Settings</h3>
        <button class="tcr-x" title="Close">&times;</button>
      </div>
      <div class="tcr-summary">
        Cash &gt; ${formatMoney(CONFIG.thresholdCash)} • Vault: ${CONFIG.vault.mode.toUpperCase()} • Desktop: ${CONFIG.desktop.enable ? "ON" : "OFF"} • Beep: ${CONFIG.beep.enable ? "ON" : "OFF"}
      </div>
    `;

    header.querySelector(".tcr-x").addEventListener("click", () => panel.remove());

    const scroll = document.createElement("div");
    scroll.className = "tcr-panel-scroll";

    // --- CASH SECTION (open by default) ---
    const secCash = document.createElement("div");
    secCash.className = "tcr-section tcr-open";
    secCash.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Cash Trigger</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label>Threshold (notify when cash &gt; this)</label>
            <input id="tcr_threshold" type="number" min="0" step="1" value="${CONFIG.thresholdCash}">
            <small>0 = any cash at all.</small>
          </div>
          <div class="tcr-field">
            <label>Cooldown minutes (after acknowledge)</label>
            <input id="tcr_cooldown" type="number" min="0" step="1" value="${CONFIG.cooldownMinutes}">
            <small>How long before another reminder is allowed.</small>
          </div>
          <div class="tcr-field">
            <label>Check frequency (ms)</label>
            <input id="tcr_poll" type="number" min="1000" step="500" value="${CONFIG.pollIntervalMs}">
            <small>How often the script checks your cash. 5000ms = every 5 seconds.</small>
          </div>
        </div>
      </div>
    `;

    // --- VAULT SECTION ---
    const secVault = document.createElement("div");
    secVault.className = "tcr-section";
    secVault.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Vault Prefill</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label>Vault Prefill Amount</label>
            <select id="tcr_vault_mode">
              <option value="all"${CONFIG.vault.mode === "all" ? " selected" : ""}>Move ALL cash</option>
              <option value="fixed"${CONFIG.vault.mode === "fixed" ? " selected" : ""}>Fixed amount</option>
              <option value="buffer"${CONFIG.vault.mode === "buffer" ? " selected" : ""}>Leave buffer</option>
              <option value="percent"${CONFIG.vault.mode === "percent" ? " selected" : ""}>Percent of cash</option>
            </select>
            <small>This only affects the amount prefilled into vault deposit inputs.</small>
          </div>
          <div class="tcr-field">
            <label>Fixed amount (if FIXED)</label>
            <input id="tcr_vault_fixed" type="number" min="0" step="1" value="${CONFIG.vault.fixedAmount}">
          </div>
          <div class="tcr-field">
            <label>Leave on hand (if BUFFER)</label>
            <input id="tcr_vault_buffer" type="number" min="0" step="1" value="${CONFIG.vault.leaveBuffer}">
          </div>
          <div class="tcr-field">
            <label>Percent (if PERCENT)</label>
            <input id="tcr_vault_percent" type="number" min="0" max="100" step="1" value="${CONFIG.vault.percent}">
          </div>
        </div>
      </div>
    `;

    // --- TRADE SECTION (now holds Ghost IDs) ---
    const secTrade = document.createElement("div");
    secTrade.className = "tcr-section";
    secTrade.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Trade / Ghost Trade</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label>Ghost Trade IDs (comma-separated, up to ${MAX_GHOSTS})</label>
            <textarea id="tcr_ghosts" placeholder="12345,67890,11223">${(CONFIG.ghostIds || []).join(",")}</textarea>
            <small>Used when you click Ghost Trade. Rotates through this list.</small>
          </div>
          <div class="tcr-field">
            <label>Trade description autofill</label>
            <select id="tcr_td_mode">
              <option value="none"${CONFIG.trade.descMode === "none" ? " selected" : ""}>None</option>
              <option value="fixed"${CONFIG.trade.descMode === "fixed" ? " selected" : ""}>Fixed text</option>
              <option value="random"${CONFIG.trade.descMode === "random" ? " selected" : ""}>Random from list</option>
            </select>
            <small>When you click Ghost Trade, fills the trade message box.</small>
          </div>
          <div class="tcr-field">
            <label>Fixed Description (used when mode = Fixed)</label>
            <input id="tcr_td_fixed" type="text" value="${CONFIG.trade.descFixed.replace(/"/g, "&quot;")}">
          </div>
          <div class="tcr-field" style="grid-column:1 / -1;">
            <label>Pun list (one per line, used when mode = Random)</label>
            <textarea id="tcr_td_list">${CONFIG.trade.descList}</textarea>
          </div>
        </div>
      </div>
    `;

    // --- DESKTOP NOTIFICATION SECTION ---
    const perm = (typeof Notification !== "undefined" && Notification.permission) || "unsupported";

    const secDesktop = document.createElement("div");
    secDesktop.className = "tcr-section";
    secDesktop.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Desktop Notifications</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label><input id="tcr_dn_enable" type="checkbox"${CONFIG.desktop.enable ? " checked" : ""}> Enable desktop notifications</label>
            <small>Uses your browser/OS notification system.</small>
          </div>
          <div class="tcr-field">
            <label>Desktop cooldown minutes</label>
            <input id="tcr_dn_cooldown" type="number" min="0" step="1" value="${CONFIG.desktop.desktopCooldownMinutes}">
            <small>Minimum time between desktop notifs.</small>
          </div>
          <div class="tcr-field">
            <label>Idle minutes (notify if you're idle &amp; holding cash)</label>
            <input id="tcr_dn_idle" type="number" min="1" step="1" value="${CONFIG.desktop.idleMinutes}">
            <small>Also triggers if the tab is hidden.</small>
          </div>
          <div class="tcr-field">
            <label>Permission</label>
            <input id="tcr_dn_perm" type="text" value="${perm}" readonly>
            <small>Click "Test Desktop Notif" below to request permission if needed.</small>
          </div>
        </div>
      </div>
    `;

    // --- BEEP SECTION ---
    const secBeep = document.createElement("div");
    secBeep.className = "tcr-section";
    secBeep.innerHTML = `
      <div class="tcr-section-header">
        <span class="tcr-section-title">Beep Fallback (in-page sound)</span>
        <span class="tcr-section-arrow">▶</span>
      </div>
      <div class="tcr-section-body">
        <div class="tcr-grid">
          <div class="tcr-field">
            <label><input id="tcr_beep_enable" type="checkbox"${CONFIG.beep.enable ? " checked" : ""}> Enable beep fallback</label>
            <small>Simple browser beep when a toast / idle alert fires.</small>
          </div>
          <div class="tcr-field">
            <label><input id="tcr_beep_idle" type="checkbox"${CONFIG.beep.beepOnIdle ? " checked" : ""}> Beep on idle alert</label>
            <small>Plays a quick beep when you're idle+holding cash and an alert fires.</small>
          </div>
          <div class="tcr-field">
            <label>Beep volume (0.0–1.0)</label>
            <input id="tcr_beep_vol" type="number" min="0" max="1" step="0.05" value="${CONFIG.beep.volume}">
          </div>
        </div>
      </div>
    `;

    // accordion toggles
    [secCash, secVault, secTrade, secDesktop, secBeep].forEach((sec) => {
      const headerEl = sec.querySelector(".tcr-section-header");
      headerEl.addEventListener("click", () => {
        sec.classList.toggle("tcr-open");
      });
    });

    scroll.appendChild(secCash);
    scroll.appendChild(secVault);
    scroll.appendChild(secTrade);
    scroll.appendChild(secDesktop);
    scroll.appendChild(secBeep);

    const footer = document.createElement("div");
    footer.className = "tcr-panel-footer";

    footer.innerHTML = `
      <div class="tcr-actions">
        <button class="tcr-btn" id="tcr_save">Save</button>
        <button class="tcr-btn" id="tcr_reset_cd">Reset Cooldown (re-arm)</button>
        <button class="tcr-btn" id="tcr_clear_snooze">Clear Snooze</button>
        <button class="tcr-btn" id="tcr_test_toast">Show Test Toast</button>
        <button class="tcr-btn" id="tcr_test_dn">Test Desktop Notif</button>
        <button class="tcr-btn" id="tcr_test_beep">Test Beep</button>
        <button class="tcr-btn" id="tcr_remove_toast">Remove Toast</button>
      </div>
      <div class="tcr-note">
        Re-arms when cash drops to ≤ threshold, and also after you click a vault deposit or Ghost Trade. If you change "Check frequency", refresh the page to apply.
      </div>
    `;

    // --- footer actions ---
    footer.querySelector("#tcr_save").addEventListener("click", () => {
      const thresholdCash = Number(scroll.querySelector("#tcr_threshold").value);
      const cooldownMinutes = Number(scroll.querySelector("#tcr_cooldown").value);
      const pollIntervalMs = Number(scroll.querySelector("#tcr_poll").value);

      let ghostIds = scroll
        .querySelector("#tcr_ghosts")
        .value.split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s));
      ghostIds = Array.from(new Set(ghostIds)).slice(0, MAX_GHOSTS);

      // vault
      const vaultMode = scroll.querySelector("#tcr_vault_mode").value;
      const vaultFixed = Number(scroll.querySelector("#tcr_vault_fixed").value);
      const vaultBuffer = Number(scroll.querySelector("#tcr_vault_buffer").value);
      const vaultPercent = Number(scroll.querySelector("#tcr_vault_percent").value);

      // trade
      const tdMode = scroll.querySelector("#tcr_td_mode").value;
      const tdFixed = scroll.querySelector("#tcr_td_fixed").value;
      const tdList = scroll.querySelector("#tcr_td_list").value;

      // desktop
      const dnEnable = scroll.querySelector("#tcr_dn_enable").checked;
      const dnCooldown = Number(scroll.querySelector("#tcr_dn_cooldown").value);
      const dnIdle = Number(scroll.querySelector("#tcr_dn_idle").value);

      // beep
      const beepEnable = scroll.querySelector("#tcr_beep_enable").checked;
      const beepIdle = scroll.querySelector("#tcr_beep_idle").checked;
      const beepVol = Number(scroll.querySelector("#tcr_beep_vol").value);

      CONFIG.thresholdCash = Number.isFinite(thresholdCash) ? thresholdCash : DEFAULTS.thresholdCash;
      CONFIG.cooldownMinutes = Number.isFinite(cooldownMinutes) ? cooldownMinutes : DEFAULTS.cooldownMinutes;
      CONFIG.pollIntervalMs =
        Number.isFinite(pollIntervalMs) && pollIntervalMs >= 1000
          ? pollIntervalMs
          : DEFAULTS.pollIntervalMs;

      CONFIG.ghostIds = ghostIds;

      CONFIG.vault.mode = ["all", "fixed", "buffer", "percent"].includes(vaultMode)
        ? vaultMode
        : "all";
      CONFIG.vault.fixedAmount = Number.isFinite(vaultFixed) ? vaultFixed : 0;
      CONFIG.vault.leaveBuffer = Number.isFinite(vaultBuffer) ? vaultBuffer : 0;
      CONFIG.vault.percent = Number.isFinite(vaultPercent) ? vaultPercent : 100;

      CONFIG.trade.descMode = ["none", "fixed", "random"].includes(tdMode) ? tdMode : "random";
      CONFIG.trade.descFixed = tdFixed;
      CONFIG.trade.descList = tdList;

      CONFIG.desktop.enable = dnEnable;
      CONFIG.desktop.desktopCooldownMinutes = Number.isFinite(dnCooldown)
        ? dnCooldown
        : DEFAULTS.desktop.desktopCooldownMinutes;
      CONFIG.desktop.idleMinutes = Number.isFinite(dnIdle)
        ? dnIdle
        : DEFAULTS.desktop.desktopIdleMinutes || DEFAULTS.desktop.idleMinutes;

      CONFIG.beep.enable = beepEnable;
      CONFIG.beep.beepOnIdle = beepIdle;
      CONFIG.beep.volume =
        Number.isFinite(beepVol) && beepVol >= 0 && beepVol <= 1 ? beepVol : DEFAULTS.beep.volume;

      saveConfigRaw(CONFIG);

      resetCooldown();
      clearSnooze();
      setArmed(true);

      alert(
        "Saved ✅\n\nCooldown reset + snooze cleared + reminder re-armed.\n(Refresh page if you changed Check frequency.)"
      );
    });

    footer.querySelector("#tcr_reset_cd").addEventListener("click", () => {
      resetCooldown();
      clearSnooze();
      setArmed(true);
      alert("Cooldown reset + re-armed ✅");
    });

    footer.querySelector("#tcr_clear_snooze").addEventListener("click", () => {
      clearSnooze();
      alert("Snooze cleared ✅");
    });

    footer.querySelector("#tcr_test_toast").addEventListener("click", () => {
      const cash = getCashOnHand();
      showToast(Number.isFinite(cash) ? cash : 123456);
    });

    footer.querySelector("#tcr_remove_toast").addEventListener("click", () => {
      removeExistingToast();
    });

    footer.querySelector("#tcr_test_dn").addEventListener("click", async () => {
      await ensureNotificationPermission();
      sendDesktopNotification(123456, "test");
      const permNow =
        (typeof Notification !== "undefined" && Notification.permission) || "unsupported";
      const permInput = scroll.querySelector("#tcr_dn_perm");
      if (permInput) permInput.value = permNow;
    });

    footer.querySelector("#tcr_test_beep").addEventListener("click", () => {
      doBeep(CONFIG.beep.volume || 0.25);
    });

    panel.appendChild(header);
    panel.appendChild(scroll);
    panel.appendChild(footer);

    document.body.appendChild(panel);
  }

  /********************
   * TOAST UI
   ********************/
  function showToast(cashAmount) {
    injectStyles();
    removeExistingToast();

    const toast = document.createElement("div");
    toast.className = "tcr-toast";

    const header = document.createElement("div");
    header.className = "tcr-row";

    const title = document.createElement("div");
    title.className = "tcr-title";
    title.textContent = "Cash Reminder";

    const close = document.createElement("button");
    close.className = "tcr-x";
    close.innerHTML = "&times;";
    close.title = "Dismiss";
    close.addEventListener("click", () => {
      acknowledge();
      toast.remove();
    });

    header.appendChild(title);
    header.appendChild(close);

    const body = document.createElement("div");
    body.className = "tcr-body";
    body.innerHTML = `You're holding <span class="tcr-amount">${formatMoney(
      cashAmount
    )}</span>. Consider moving it.`;

    const btns = document.createElement("div");
    btns.className = "tcr-btns";

    // Trade (Ghost Trade)
    const tradeBtn = document.createElement("button");
    tradeBtn.className = "tcr-btn";
    tradeBtn.textContent = "Trade (Ghost Trade)";
    tradeBtn.addEventListener("click", () => {
      acknowledge();
      const gid = pickNextGhostId();
      const desc = chooseTradeDescription();
      if (desc) setPendingTradeDescription(desc);

      if (gid) {
        window.location.href = `${CONFIG.links.trade}#step=start&userID=${gid}`;
      } else {
        window.location.href = CONFIG.links.trade;
      }
    });
    btns.appendChild(tradeBtn);

    // Faction Vault
    const facBtn = document.createElement("button");
    facBtn.className = "tcr-btn";
    facBtn.textContent = "Faction Vault";
    facBtn.addEventListener("click", () => {
      acknowledge();
      const deposit = computeVaultDeposit(cashAmount);
      setPendingDeposit(deposit);
      window.location.href = CONFIG.links.factionVault;
    });
    btns.appendChild(facBtn);

    // Property Vault
    const propBtn = document.createElement("button");
    propBtn.className = "tcr-btn";
    propBtn.textContent = "Property Vault";
    propBtn.addEventListener("click", () => {
      acknowledge();
      const deposit = computeVaultDeposit(cashAmount);
      setPendingDeposit(deposit);
      window.location.href = CONFIG.links.propertyVault;
    });
    btns.appendChild(propBtn);

    // Copy Amount
    const copyBtn = document.createElement("button");
    copyBtn.className = "tcr-btn";
    copyBtn.textContent = "Copy Amount";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(Math.floor(cashAmount)));
        copyBtn.textContent = "Copied ✅";
      } catch {
        copyBtn.textContent = "Copy failed ❌";
      }
      setTimeout(() => (copyBtn.textContent = "Copy Amount"), 1500);
    });
    btns.appendChild(copyBtn);

    // Snooze buttons
    for (const mins of CONFIG.snoozeOptions) {
      const snoozeBtn = document.createElement("button");
      snoozeBtn.className = "tcr-btn";
      snoozeBtn.textContent =
        mins >= 1440 ? "Snooze 1 day" :
        mins >= 60 ? `Snooze ${Math.floor(mins / 60)}h` :
        `Snooze ${mins}m`;
      snoozeBtn.addEventListener("click", () => {
        setSnooze(mins);
        acknowledge();
        toast.remove();
      });
      btns.appendChild(snoozeBtn);
    }

    const note = document.createElement("div");
    note.className = "tcr-note";
    note.textContent =
      `Threshold: cash > ${formatMoney(CONFIG.thresholdCash)} • ` +
      `Cooldown after ack: ${CONFIG.cooldownMinutes}m • ` +
      `Re-arms when cash ≤ threshold`;

    toast.appendChild(header);
    toast.appendChild(body);
    toast.appendChild(btns);
    toast.appendChild(note);

    document.body.appendChild(toast);

    doBeep(CONFIG.beep.volume || 0.25);
  }

  /********************
   * PAGE CONTEXT HELPERS
   ********************/
  function onFactionVaultTab() {
    return (
      location.pathname.includes("/factions.php") && String(location.hash || "").includes("tab=armoury")
    );
  }

  function onPropertyVaultTab() {
    return (
      location.pathname.includes("/properties.php") &&
      String(location.hash || "").includes("tab=vault")
    );
  }

  function onTradePage() {
    return location.pathname.includes("/trade.php");
  }

  function fillInput(el, value) {
    el.focus();
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function tryPrefillVaultOnce() {
    const amount = getPendingDeposit();
    if (!amount || amount <= 0) return;

    if (onFactionVaultTab()) {
      const input = document.querySelector("#armoury-donate input.input-money");
      if (input) {
        fillInput(input, amount);
        clearPendingDeposit();
        console.log(`[TCR] Prefilled FACTION vault with ${amount}`);
      }
      return;
    }

    if (onPropertyVaultTab()) {
      const selectors = [
        "#property-money input.input-money",
        "input.input-money",
        "input[name='amount']",
        "input#amount",
        "input[name='money']",
        "input#money",
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          fillInput(el, amount);
          clearPendingDeposit();
          console.log(`[TCR] Prefilled PROPERTY vault with ${amount} via selector: ${sel}`);
          break;
        }
      }
    }
  }

  function tryPrefillTradeOnce() {
    const desc = getPendingTradeDescription();
    if (!desc || !onTradePage()) return;

    const selectors = [
      "textarea[name='message']",
      ".new-trade textarea",
      "textarea",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        fillInput(el, desc);
        clearPendingTradeDescription();
        console.log("[TCR] Prefilled trade description.");
        break;
      }
    }
  }

  function startPrefillObserver() {
    const obs = new MutationObserver(() => {
      tryPrefillVaultOnce();
      tryPrefillTradeOnce();
    });
    obs.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      tryPrefillVaultOnce();
      tryPrefillTradeOnce();
    }, 250);
    setTimeout(() => {
      tryPrefillVaultOnce();
      tryPrefillTradeOnce();
    }, 1000);
  }

  /********************
   * DESKTOP NOTIFICATIONS
   ********************/
  async function ensureNotificationPermission() {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;

    try {
      const res = await Notification.requestPermission();
      return res === "granted";
    } catch {
      return false;
    }
  }

  function sendDesktopNotification(cashAmount, reason) {
    if (!CONFIG.desktop.enable) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    const last = GM_getValue(KEYS.lastDesktopAt, 0);
    const minDelta = minutesToMs(CONFIG.desktop.desktopCooldownMinutes || 0);
    if (now() - last < minDelta) return;

    GM_setValue(KEYS.lastDesktopAt, now());

    const body =
      reason === "idle"
        ? `You've been idle and are still holding ${formatMoney(cashAmount)}.`
        : `You're holding ${formatMoney(cashAmount)}. Consider moving it.`;

    try {
      new Notification("Torn Cash Reminder", {
        body,
        icon: "https://www.torn.com/favicon.ico",
      });
    } catch (e) {
      console.warn("[TCR] Desktop notification failed:", e);
    }
  }

  function checkIdleDesktopAndBeep(cashAmount) {
    if (!CONFIG.desktop.enable) return;
    if (cashAmount <= CONFIG.thresholdCash) return;

    const idleMs = minutesToMs(CONFIG.desktop.idleMinutes || DEFAULTS.desktop.idleMinutes);
    const isIdle = document.hidden || now() - lastActivityTs >= idleMs;

    if (!isIdle) return;

    sendDesktopNotification(cashAmount, "idle");

    if (CONFIG.beep.enable && CONFIG.beep.beepOnIdle) {
      doBeep(CONFIG.beep.volume || 0.25);
    }
  }

  window.addEventListener("beforeunload", () => {
    if (!CONFIG.desktop.enable) return;
    const cash = GM_getValue(KEYS.lastCashSeen, 0);
    if (!cash || cash <= CONFIG.thresholdCash) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;

    try {
      new Notification("Torn Cash Reminder", {
        body: `You closed Torn while holding ${formatMoney(cash)}.`,
        icon: "https://www.torn.com/favicon.ico",
      });
    } catch (e) {
      console.warn("[TCR] beforeunload notification failed:", e);
    }
  });

  /********************
   * TAMPERMONKEY MENU
   ********************/
  function registerMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;

    GM_registerMenuCommand("⚙ Open Cash Reminder Settings", () => openConfigPanel());
    GM_registerMenuCommand("⏱ Reset Cooldown (re-arm)", () => {
      resetCooldown();
      clearSnooze();
      setArmed(true);
      alert("Cooldown reset + re-armed ✅");
    });
    GM_registerMenuCommand("🔕 Clear Snooze", () => {
      clearSnooze();
      alert("Snooze cleared ✅");
    });
    GM_registerMenuCommand("🧪 Show Test Toast", () => {
      const cash = getCashOnHand();
      showToast(Number.isFinite(cash) ? cash : 123456);
    });
    GM_registerMenuCommand("🧪 Test Desktop Notif", async () => {
      await ensureNotificationPermission();
      sendDesktopNotification(123456, "test");
      alert("If permission is granted, you should see a desktop notification.");
    });
    GM_registerMenuCommand("🔊 Test Beep", () => {
      doBeep(CONFIG.beep.volume || 0.25);
    });
    GM_registerMenuCommand("🧹 Remove Toast", () => removeExistingToast());
  }

  /********************
   * MAIN LOOP
   ********************/
  function tick() {
    if (isSnoozed()) return;

    const cash = getCashOnHand();
    if (cash === null) return;

    GM_setValue(KEYS.lastCashSeen, cash);

    if (cash <= CONFIG.thresholdCash) {
      setArmed(true);
      return;
    }

    const armed = isArmed();
    const cooldownOk = canShowAfterAckCooldown();

    if (armed || cooldownOk) {
      showToast(cash);
      setArmed(false);
    }

    checkIdleDesktopAndBeep(cash);
  }

  /********************
   * ACTIVITY TRACKING
   ********************/
  function bumpActivity() {
    lastActivityTs = now();
  }

  ["mousemove", "keydown", "click", "scroll"].forEach((evt) => {
    window.addEventListener(evt, bumpActivity, { passive: true });
  });
  document.addEventListener("visibilitychange", bumpActivity);

  /********************
   * STARTUP
   ********************/
  injectStyles();

  if (GM_getValue(KEYS.armed, null) === null) {
    setArmed(true);
  }

  registerMenu();
  startPrefillObserver();

  window.addEventListener("hashchange", () => {
    tryPrefillVaultOnce();
    tryPrefillTradeOnce();
  });

  setInterval(tick, CONFIG.pollIntervalMs);
  setTimeout(tick, 2500);
})();
