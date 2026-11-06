// ==UserScript==
// @name         Torn Flight Watch
// @namespace    mcc.torn.ukwatch
// @version      1.3.0
// @description  Watches the factions you're at war with, shows which countries are safe or risky, and alerts when enemies fly to, land in, or leave the country you're in or heading to.
// @author       Ripcorder [4252513]
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      discord.com
// @connect      discordapp.com
// @run-at       document-idle
// @homepageURL  https://github.com/mat-mcc-uk/torn-flight-watch
// @updateURL    https://raw.githubusercontent.com/mat-mcc-uk/torn-flight-watch/main/torn-flight-watch.user.js
// @downloadURL  https://raw.githubusercontent.com/mat-mcc-uk/torn-flight-watch/main/torn-flight-watch.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Countries ----------
  // Flight times in minutes: [standard, airstrip, private (WLT), business].
  // The API's plane_image_type gives the plane: light_aircraft = airstrip,
  // private_jet = private, airliner = standard OR business class.
  // adj = the word Torn uses for that country's hospital ("In a Japanese hospital").
  const DESTS = {
    'Mexico':         { code: 'MEX', adj: ['Mexican'],                 t: [26, 18, 13, 8] },
    'Cayman Islands': { code: 'CAY', adj: ['Caymanian'],               t: [35, 25, 18, 11] },
    'Canada':         { code: 'CAN', adj: ['Canadian'],                t: [41, 29, 20, 12] },
    'Hawaii':         { code: 'HAW', adj: ['Hawaiian'],                t: [134, 94, 67, 40] },
    'United Kingdom': { code: 'UK',  adj: ['British'],                 t: [159, 111, 80, 48] },
    'Argentina':      { code: 'ARG', adj: ['Argentinian', 'Argentine'], t: [167, 117, 83, 50] },
    'Switzerland':    { code: 'SWI', adj: ['Swiss'],                   t: [175, 123, 88, 53] },
    'Japan':          { code: 'JPN', adj: ['Japanese'],                t: [225, 158, 113, 68] },
    'China':          { code: 'CHN', adj: ['Chinese'],                 t: [242, 169, 121, 72] },
    'UAE':            { code: 'UAE', adj: ['Emirati', 'UAE'],          t: [271, 190, 135, 81] },
    'South Africa':   { code: 'SA',  adj: ['South African'],           t: [297, 208, 149, 89] },
  };
  const COUNTRIES = Object.keys(DESTS);
  const PLANE_INDEX = { airliner: 0, light_aircraft: 1, private_jet: 2 };
  const flightMin = (dest, plane) => (DESTS[dest] && plane in PLANE_INDEX ? DESTS[dest].t[PLANE_INDEX[plane]] : null);
  const businessMin = (dest) => (DESTS[dest] ? DESTS[dest].t[3] : null);

  const DEFAULTS = {
    apiKey: '',
    enemyMode: 'auto',         // 'auto' = factions you're at war with, 'manual' = fixed IDs
    factionId: '',             // manual mode: one or more faction IDs, comma separated
    includeMinorWars: true,    // auto mode: include raids and territory wars as well as ranked
    pollSec: 30,
    warnMin: 5,
    webhook: '',
    alertDepart: true,
    alertWarn: true,
    alertLanded: true,
    alertLeave: false,
    alertArrive: true,         // summary of a country's risk when you start heading there
  };

  const TAB_ID = Math.random().toString(36).slice(2);
  const LEADER_TTL = 20;   // seconds before another tab takes over polling
  const WAR_CHECK = 300;   // seconds between war lookups in auto enemy mode

  const now = () => Math.floor(Date.now() / 1000);
  const getCfg = () => Object.assign({}, DEFAULTS, GM_getValue('ukw_cfg', {}));
  const setCfg = (c) => GM_setValue('ukw_cfg', c);
  const getState = () => GM_getValue('fw_state', {});
  const setState = (s) => GM_setValue('fw_state', s);
  const getMeta = () => Object.assign({ myDest: null, myLoc: '', enemies: [], warNote: '' }, GM_getValue('fw_meta', {}));
  const setMeta = (m) => GM_setValue('fw_meta', m);

  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (secs) => {
    if (secs <= 0) return 'due now';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h ? `${h}h ${m}m` : `${m}m ${String(s).padStart(2, '0')}s`;
  };
  const planeLabel = (p) => ({ light_aircraft: 'Airstrip', private_jet: 'Private (WLT)', airliner: 'Standard/Business' }[p] || 'Unknown plane');

  // Turn a status into a location: { kind: 'out' | 'there' | 'back' | 'torn', country, hosp }
  function parseLoc(s) {
    const desc = (s && s.description) || '';
    for (const c of COUNTRIES) {
      if (s.state === 'Traveling' && desc.includes(`Traveling to ${c}`)) return { kind: 'out', country: c };
      if (s.state === 'Traveling' && desc.includes(`Returning to Torn from ${c}`)) return { kind: 'back', country: c };
      if (s.state === 'Abroad' && desc.includes(`In ${c}`)) return { kind: 'there', country: c };
      if (s.state === 'Hospital' && DESTS[c].adj.some((a) => desc.includes(`${a} hospital`))) return { kind: 'there', country: c, hosp: true };
    }
    return { kind: 'torn', country: null };
  }

  // Count enemies per country from the stored state.
  function countryBoard(state, t) {
    const board = {};
    for (const c of COUNTRIES) board[c] = { there: [], hosp: [], inbound: [] };
    for (const [id, r] of Object.entries(state)) {
      if (id === '_init' || !r.country || !board[r.country]) continue;
      if (r.kind === 'there') board[r.country][r.hosp ? 'hosp' : 'there'].push([id, r]);
      if (r.kind === 'out') board[r.country].inbound.push([id, r]);
    }
    for (const c of COUNTRIES) {
      const b = board[c];
      b.inbound.sort((a, z) => (a[1].eta || 9e9) - (z[1].eta || 9e9));
      b.next = b.inbound.length && b.inbound[0][1].eta ? b.inbound[0][1].eta - t : null;
      b.risky = b.there.length + b.hosp.length + b.inbound.length > 0;
    }
    return board;
  }
  const boardLine = (b) => {
    const parts = [];
    if (b.there.length) parts.push(`${b.there.length} there`);
    if (b.hosp.length) parts.push(`${b.hosp.length} in hosp`);
    if (b.inbound.length) parts.push(`${b.inbound.length} inbound${b.next !== null ? ` (next ~${fmt(b.next)})` : ''}`);
    return parts.join(', ') || 'No enemies';
  };

  // ---------- Alerts ----------
  function alertOut(title, text, url) {
    const cfg = getCfg();
    try {
      GM_notification({ title, text, timeout: 15000, onclick: () => url && window.open(url, '_blank') });
    } catch (e) {
      if (window.Notification && Notification.permission === 'granted') new Notification(title, { body: text });
    }
    if (cfg.webhook) {
      GM_xmlhttpRequest({
        method: 'POST',
        url: cfg.webhook,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ content: `**${title}**\n${text}${url ? `\n<${url}>` : ''}` }),
      });
    }
    toast(`${title}: ${text}`);
  }

  // ---------- Leader election so only one tab polls ----------
  function amLeader() {
    const l = GM_getValue('ukw_leader', null);
    const t = now();
    if (!l || l.tab === TAB_ID || t - l.ts > LEADER_TTL) {
      GM_setValue('ukw_leader', { tab: TAB_ID, ts: t });
      return true;
    }
    return false;
  }

  // ---------- API ----------
  const api = (path, key) =>
    fetch(`https://api.torn.com/v2/${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j && j.error) throw new Error(`API error ${j.error.code}: ${j.error.error}`);
        return j;
      });

  // Find the factions your faction is at war with. Stores [{ id, name, type, start }] in meta.
  let lastWarCheck = 0;
  async function refreshWars(cfg, force) {
    const t = now();
    if (!force && t - lastWarCheck < WAR_CHECK) return;
    lastWarCheck = t;

    const [basic, wars] = await Promise.all([api('faction/basic', cfg.apiKey), api('faction/wars', cfg.apiKey)]);
    const ownId = basic && basic.basic ? basic.basic.id : null;
    if (!ownId) {
      setMeta(Object.assign(getMeta(), { enemies: [], warNote: "You're not in a faction" }));
      return;
    }

    const w = (wars && wars.wars) || {};
    const live = (war) => !war.end || war.end > t;
    const found = new Map();
    const add = (war, type) => {
      for (const f of war.factions || []) {
        if (f.id !== ownId && !found.has(f.id)) found.set(f.id, { id: f.id, name: f.name, type, start: war.start });
      }
    };

    if (w.ranked && live(w.ranked) && !w.ranked.winner) add(w.ranked, 'ranked');
    if (cfg.includeMinorWars) {
      (w.raids || []).filter(live).forEach((r) => add(r, 'raid'));
      (w.territory || []).filter(live).forEach((r) => add(r, 'territory'));
    }

    const enemies = [...found.values()];
    setMeta(Object.assign(getMeta(), { enemies, warNote: enemies.length ? '' : 'Not at war right now' }));
  }

  // ---------- Poll ----------
  let lastPoll = 0;
  let lastError = '';
  let forceWarCheck = true;

  async function poll() {
    const cfg = getCfg();
    if (!cfg.apiKey) return;
    if (cfg.enemyMode === 'manual' && !cfg.factionId) return;
    const t = now();
    if (t - lastPoll < cfg.pollSec) return;
    lastPoll = t;

    try {
      // Which factions to watch.
      let enemies;
      if (cfg.enemyMode === 'auto') {
        await refreshWars(cfg, forceWarCheck);
        forceWarCheck = false;
        enemies = getMeta().enemies;
      } else {
        enemies = cfg.factionId.split(',').map((s) => s.trim()).filter(Boolean).map((id) => ({ id, name: `Faction ${id}`, type: 'manual' }));
        setMeta(Object.assign(getMeta(), { enemies, warNote: '' }));
      }

      const [me, ...lists] = await Promise.all([
        api('user/basic?striptags=true', cfg.apiKey),
        ...enemies.map((e) => api(`faction/${encodeURIComponent(e.id)}/members?striptags=true`, cfg.apiKey)),
      ]);
      lastError = '';

      // Where am I? Alerts only fire for the country I'm in or flying to.
      const myStatus = (me && me.profile && me.profile.status) || {};
      const mine = parseLoc(myStatus);
      const myDest = mine.kind === 'out' || mine.kind === 'there' ? mine.country : null;
      const myLoc =
        mine.kind === 'out' ? `You're flying to ${mine.country}`
        : mine.kind === 'there' ? `You're in ${mine.country}`
        : mine.kind === 'back' ? `You're flying back to Torn`
        : `You're in Torn`;

      const meta = getMeta();
      const prevDest = meta.myDest;
      const state = getState();
      const firstRun = !state._init;
      const seen = new Set();

      lists.forEach((data, i) => {
        const fac = enemies[i];
        for (const m of (data && data.members) || []) {
          const id = String(m.id);
          seen.add(id);
          const s = m.status || {};
          const loc = parseLoc(s);
          const key = `${loc.kind}:${loc.country || ''}`;

          const prev = state[id] ? { key: state[id].key, kind: state[id].kind, country: state[id].country, seenAt: state[id].seenAt } : null;
          const rec = state[id] || { key, departAt: null, warned: false };
          rec.name = m.name;
          rec.level = m.level;
          rec.faction = fac.name;
          rec.plane = s.plane_image_type || (loc.kind === 'out' ? rec.plane : null) || null;
          rec.kind = loc.kind;
          rec.country = loc.country;
          rec.hosp = !!loc.hosp;
          rec.hospUntil = loc.hosp ? s.until || null : null;

          const profile = `https://www.torn.com/profiles.php?XID=${id}`;
          const who = `${m.name} [${id}] (${fac.name})`;
          const mineToo = myDest && loc.country === myDest;
          const code = loc.country && DESTS[loc.country] ? DESTS[loc.country].code : '';

          if (prev && prev.key !== key) {
            if (loc.kind === 'out') {
              // Took off since the last poll. Split the difference between polls.
              rec.departAt = t - Math.round(Math.min(t - (prev.seenAt || t), cfg.pollSec * 2) / 2);
              rec.warned = false;
              if (mineToo && cfg.alertDepart) {
                const mins = flightMin(loc.country, rec.plane);
                const extra = rec.plane === 'airliner' ? ` (or ~${businessMin(loc.country)}m if business class)` : '';
                alertOut(`Enemy flying to ${code}`, `${who} lvl ${m.level} took off for ${loc.country}. ${planeLabel(rec.plane)}${mins ? `, lands in ~${fmt(mins * 60)}${extra}` : ''}`, profile);
              }
            } else if (loc.kind === 'there' && prev.kind === 'out' && mineToo && cfg.alertLanded) {
              alertOut(`Enemy landed in ${code}`, `${who} lvl ${m.level} is now in ${loc.country}`, profile);
            } else if (loc.kind === 'back' && prev.kind === 'there' && prev.country === myDest && cfg.alertLeave) {
              alertOut(`Enemy leaving ${code}`, `${who} lvl ${m.level} is flying back to Torn from ${loc.country}`, profile);
            }
          }

          if (loc.kind === 'out') {
            // Exact arrival if the API ever gives one, otherwise estimate from takeoff.
            const mins = flightMin(loc.country, rec.plane);
            if (s.until && s.until > t) rec.eta = s.until;
            else if (rec.departAt && mins) rec.eta = rec.departAt + mins * 60;
            else rec.eta = null;
            rec.bizEta = rec.plane === 'airliner' && rec.departAt ? rec.departAt + businessMin(loc.country) * 60 : null;

            if (mineToo && rec.eta && !rec.warned && t >= rec.eta - cfg.warnMin * 60) {
              rec.warned = true;
              if (cfg.alertWarn && !firstRun) alertOut(`Enemy landing in ${code} soon`, `${who} lvl ${m.level} lands in ${loc.country} in ~${fmt(rec.eta - t)}`, profile);
            }
          } else {
            rec.departAt = null;
            rec.eta = null;
            rec.bizEta = null;
            rec.warned = false;
          }

          rec.key = key;
          rec.seenAt = t;
          state[id] = rec;
        }
      });

      // Drop anyone who left the faction, or whose faction we no longer watch.
      for (const id of Object.keys(state)) {
        if (id !== '_init' && !seen.has(id)) delete state[id];
      }
      state._init = true;
      setState(state);

      // You just started heading to (or landed in) a new country: say how risky it is.
      if (myDest && myDest !== prevDest && cfg.alertArrive && !firstRun) {
        const b = countryBoard(state, t)[myDest];
        alertOut(`${myDest}: ${b.risky ? 'RISKY' : 'safe'}`, boardLine(b));
      }
      setMeta(Object.assign(getMeta(), { myDest, myLoc }));
    } catch (e) {
      lastError = e && e.message ? e.message : 'Network error';
    }
  }

  // ---------- UI ----------
  const css = `
    #ukw-btn{position:fixed;left:8px;bottom:70px;z-index:99999;background:#1d3b5c;color:#fff;border:1px solid #4a7fb5;border-radius:6px;padding:6px 9px;font:bold 12px Arial;cursor:pointer}
    #ukw-btn.risky{background:#7a1f1f;border-color:#c0392b}
    #ukw-btn.safe{background:#1e5a2e;border-color:#2ecc71}
    #ukw-btn .n{background:#c0392b;border-radius:8px;padding:0 5px;margin-left:4px}
    #ukw-panel{position:fixed;left:8px;bottom:105px;z-index:99999;width:330px;max-height:70vh;overflow:auto;background:#222;color:#ddd;border:1px solid #555;border-radius:6px;font:12px Arial;padding:8px;display:none}
    #ukw-panel h4{margin:8px 0 4px;color:#fff;font-size:13px}
    #ukw-panel table{width:100%;border-collapse:collapse}
    #ukw-panel td{padding:3px 2px;border-bottom:1px solid #333;vertical-align:top}
    #ukw-panel a{color:#6fb3ff}
    #ukw-panel input[type=text],#ukw-panel input[type=number],#ukw-panel select{width:100%;box-sizing:border-box;background:#111;color:#ddd;border:1px solid #555;padding:3px;margin:2px 0 5px}
    #ukw-panel .row{display:flex;gap:6px}
    #ukw-panel .row>div{flex:1}
    #ukw-panel button{background:#1d3b5c;color:#fff;border:1px solid #4a7fb5;border-radius:4px;padding:4px 8px;cursor:pointer;margin-top:4px}
    #ukw-panel .err{color:#e74c3c}
    #ukw-panel .muted{color:#888}
    #ukw-panel .tag{display:inline-block;border-radius:4px;padding:1px 6px;font-weight:bold;font-size:11px}
    #ukw-panel .tag.safe{background:#1e5a2e;color:#b8f5c8}
    #ukw-panel .tag.risky{background:#7a1f1f;color:#ffc9c9}
    #ukw-panel tr.c{cursor:pointer}
    #ukw-panel tr.me td{background:#2b3440}
    #ukw-panel .detail td{background:#1a1a1a;padding-left:10px}
    #ukw-toast{position:fixed;left:50%;top:60px;transform:translateX(-50%);z-index:100000;background:#1d3b5c;color:#fff;padding:8px 12px;border-radius:6px;font:13px Arial;display:none;max-width:90vw}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const btn = document.createElement('div');
  btn.id = 'ukw-btn';
  const panel = document.createElement('div');
  panel.id = 'ukw-panel';
  const toastEl = document.createElement('div');
  toastEl.id = 'ukw-toast';
  document.body.append(btn, panel, toastEl);

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = 'none'), 8000);
  }

  let showSettings = false;
  const expanded = new Set(); // countries opened in the board
  btn.onclick = () => {
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    render();
  };

  function renderSettings() {
    const c = getCfg();
    const chk = (k, label) => `<label><input type="checkbox" data-k="${k}" ${c[k] ? 'checked' : ''}> ${label}</label><br>`;
    return `
      <h4>Settings</h4>
      Public API key<input type="text" data-k="apiKey" value="${esc(c.apiKey)}">
      Enemy
      <select data-k="enemyMode">
        <option value="auto" ${c.enemyMode === 'auto' ? 'selected' : ''}>Whoever we're at war with</option>
        <option value="manual" ${c.enemyMode === 'manual' ? 'selected' : ''}>Fixed faction ID(s)</option>
      </select>
      ${chk('includeMinorWars', 'Auto: include raids and territory wars')}
      Faction ID(s) for fixed mode, comma separated<input type="text" data-k="factionId" value="${esc(c.factionId)}">
      <div class="row">
        <div>Poll every (sec)<input type="number" min="15" data-k="pollSec" value="${c.pollSec}"></div>
        <div>Warn before landing (min)<input type="number" min="1" data-k="warnMin" value="${c.warnMin}"></div>
      </div>
      Discord webhook (optional)<input type="text" data-k="webhook" value="${esc(c.webhook)}">
      <div class="muted" style="margin:4px 0">Alerts cover the country you're in or flying to:</div>
      ${chk('alertArrive', 'Safe/risky summary when you head somewhere')}
      ${chk('alertDepart', 'Enemy takes off for your country')}
      ${chk('alertWarn', 'Enemy about to land')}
      ${chk('alertLanded', 'Enemy landed')}
      ${chk('alertLeave', 'Enemy leaves your country')}
      <button id="ukw-save">Save</button> <button id="ukw-test">Test alert</button>`;
  }

  function memberRow(id, r, t, multi) {
    const link = `<a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank">${esc(r.name)}</a> <span class="muted">${r.level}${multi && r.faction ? ` · ${esc(r.faction)}` : ''}</span>`;
    if (r.kind === 'out') {
      const eta = r.eta ? fmt(r.eta - t) : '<span class="muted">ETA unknown</span>';
      const biz = r.bizEta ? `<br><span class="muted">business: ${fmt(r.bizEta - t)}</span>` : '';
      return `<tr class="detail"><td>${link}<br><span class="muted">${planeLabel(r.plane)}</span></td><td style="text-align:right">${eta}${biz}</td></tr>`;
    }
    const note = r.hosp ? `in hosp${r.hospUntil && r.hospUntil > t ? ` ${fmt(r.hospUntil - t)}` : ''}` : 'landed';
    return `<tr class="detail"><td>${link}</td><td style="text-align:right" class="muted">${note}</td></tr>`;
  }

  function render() {
    if (panel.style.display !== 'block') return;
    const state = getState();
    const meta = getMeta();
    const cfg = getCfg();
    const t = now();
    const multi = (meta.enemies || []).length > 1;

    let html = `<div style="display:flex;justify-content:space-between"><b>Flight Watch</b><a href="#" id="ukw-gear">${showSettings ? 'Close settings' : 'Settings'}</a></div>`;
    if (meta.enemies && meta.enemies.length) {
      const list = meta.enemies.map((e) => {
        const when = e.start && e.start > t ? `, starts in ${fmt(e.start - t)}` : '';
        return `<a href="https://www.torn.com/factions.php?step=profile&ID=${esc(e.id)}" target="_blank">${esc(e.name)}</a>${e.type !== 'manual' ? ` <span class="muted">(${e.type}${when})</span>` : ''}`;
      }).join(', ');
      html += `<div>Watching: ${list}</div>`;
    } else if (meta.warNote && cfg.enemyMode === 'auto') {
      html += `<div class="muted">${esc(meta.warNote)}</div>`;
    }
    if (meta.myLoc) html += `<div class="muted">${esc(meta.myLoc)}</div>`;
    if (!cfg.apiKey) html += `<p class="err">Add an API key in Settings.</p>`;
    else if (cfg.enemyMode === 'manual' && !cfg.factionId) html += `<p class="err">Add a faction ID in Settings, or switch Enemy to auto.</p>`;
    if (lastError) html += `<p class="err">${esc(lastError)}</p>`;

    if (showSettings) {
      html += renderSettings();
    } else {
      const board = countryBoard(state, t);
      html += `<h4>Countries <span class="muted" style="font-weight:normal">(tap a risky one for names)</span></h4><table>`;
      for (const c of COUNTRIES) {
        const b = board[c];
        const me = meta.myDest === c ? ' me' : '';
        html += `<tr class="c${me}" data-c="${esc(c)}"><td><b>${esc(c)}</b>${me ? ' <span class="muted">(you)</span>' : ''}<br><span class="muted">${esc(boardLine(b))}</span></td>`;
        html += `<td style="text-align:right"><span class="tag ${b.risky ? 'risky' : 'safe'}">${b.risky ? 'RISKY' : 'SAFE'}</span></td></tr>`;
        if (b.risky && (expanded.has(c) || meta.myDest === c)) {
          [...b.there, ...b.hosp, ...b.inbound].forEach(([id, r]) => (html += memberRow(id, r, t, multi)));
        }
      }
      html += `</table>`;
    }
    panel.innerHTML = html;

    panel.querySelector('#ukw-gear').onclick = (e) => {
      e.preventDefault();
      showSettings = !showSettings;
      render();
    };
    panel.querySelectorAll('tr.c').forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('a')) return;
        const c = tr.dataset.c;
        expanded.has(c) ? expanded.delete(c) : expanded.add(c);
        render();
      };
    });
    const save = panel.querySelector('#ukw-save');
    if (save) {
      save.onclick = () => {
        const c = getCfg();
        panel.querySelectorAll('[data-k]').forEach((el) => {
          const k = el.dataset.k;
          if (el.type === 'checkbox') c[k] = el.checked;
          else if (el.type === 'number') c[k] = Math.max(Number(el.min) || 1, Number(el.value) || DEFAULTS[k]);
          else c[k] = el.value.trim();
        });
        setCfg(c);
        lastPoll = 0;
        forceWarCheck = true;
        showSettings = false;
        render();
      };
      panel.querySelector('#ukw-test').onclick = () => alertOut('Flight Watch test', 'Alerts are working');
    }
  }

  // Button shows your country and its risk; in Torn it shows how many countries are risky.
  function updateBadge() {
    const state = getState();
    const meta = getMeta();
    const board = countryBoard(state, now());
    btn.classList.remove('risky', 'safe');
    if (meta.myDest && board[meta.myDest]) {
      const b = board[meta.myDest];
      const n = b.there.length + b.hosp.length + b.inbound.length;
      btn.classList.add(b.risky ? 'risky' : 'safe');
      btn.innerHTML = `${esc(DESTS[meta.myDest].code)}${n ? `<span class="n">${n}</span>` : ''}`;
    } else {
      const risky = COUNTRIES.filter((c) => board[c].risky).length;
      btn.innerHTML = `Fly${risky ? `<span class="n">${risky}</span>` : ''}`;
    }
  }

  // ---------- Main loop ----------
  setInterval(() => {
    if (amLeader()) poll();
    updateBadge();
    if (!showSettings) render();
  }, 1000);

  if (window.Notification && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) {}
  }
  updateBadge();
})();
