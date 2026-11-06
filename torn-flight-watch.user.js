// ==UserScript==
// @name         Torn Flight Watch
// @namespace    mcc.torn.ukwatch
// @version      1.11.0
// @description  Watches the factions you're at war with, shows which countries are safe or risky, and alerts when enemies fly to, land in, or leave the country you're in or heading to.
// @author       Ripcorder [4252513]
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      discord.com
// @connect      discordapp.com
// @connect      supabase.co
// @connect      lwqcyivwyebhnqwubhuy.supabase.co
// @connect      ffscouter.com
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
    'Mexico':         { code: 'MEX', city: 'Ciudad Juarez', adj: ['Mexican'],                 t: [26, 18, 13, 8] },
    'Cayman Islands': { code: 'CAY', city: 'George Town', adj: ['Caymanian'],               t: [35, 25, 18, 11] },
    'Canada':         { code: 'CAN', city: 'Toronto', adj: ['Canadian'],                t: [41, 29, 20, 12] },
    'Hawaii':         { code: 'HAW', city: 'Honolulu', adj: ['Hawaiian'],                t: [134, 94, 67, 40] },
    'United Kingdom': { code: 'UK', city: 'London',  adj: ['British'],                 t: [159, 111, 80, 48] },
    'Argentina':      { code: 'ARG', city: 'Buenos Aires', adj: ['Argentinian', 'Argentine'], t: [167, 117, 83, 50] },
    'Switzerland':    { code: 'SWI', city: 'Zurich', adj: ['Swiss'],                   t: [175, 123, 88, 53] },
    'Japan':          { code: 'JPN', city: 'Tokyo', adj: ['Japanese'],                t: [225, 158, 113, 68] },
    'China':          { code: 'CHN', city: 'Beijing', adj: ['Chinese'],                 t: [242, 169, 121, 72] },
    'UAE':            { code: 'UAE', city: 'Dubai', adj: ['Emirati', 'UAE'],          t: [271, 190, 135, 81] },
    'South Africa':   { code: 'SA', city: 'Johannesburg',  adj: ['South African'],           t: [297, 208, 149, 89] },
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
    showMates: true,
    ffKey: '',                 // FFScouter key for battle stat estimates; blank = use the Torn API key
    showStats: true,           // list faction mates flying into danger, with a Warn button
    serverToken: '',           // leave blank to use the built-in token; paste a new one here after a rotation
  };

  // The server polls the enemy 24/7 and records takeoff times, so flights that left while
  // nobody had Torn open still get an ETA. Reads go through a database function that
  // allows one fresh read per IP every 10 seconds.
  const SERVER_URL = 'https://lwqcyivwyebhnqwubhuy.supabase.co/rest/v1/rpc/flight_watch_read';
  const SERVER_KEY = 'sb_publishable_TZNmF4f4b2bWSC5zuUCqLQ_f5c3EYQf'; // publishable, safe to ship
  const SERVER_TOKEN = '6d975e385dde1a96370823b2';

  const VERSION = '1.11.0'; // keep in step with @version so the panel shows what's actually running
  const TAB_ID = Math.random().toString(36).slice(2);
  const LEADER_TTL = 20;   // seconds before another tab takes over polling
  const WAR_CHECK = 300;   // seconds between war lookups in auto enemy mode

  // ---------- Storage ----------
  // Tampermonkey: GM storage. Torn PDA: its GM functions are missing or behave differently,
  // so fall back to the page's localStorage, which every browser and PDA support.
  const IS_PDA = typeof window.flutter_inappwebview !== 'undefined';
  const useGM = (() => {
    if (IS_PDA || typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return false;
    try {
      const probe = GM_getValue('fw_probe', null);
      return !(probe && typeof probe.then === 'function');
    } catch (e) {
      return false;
    }
  })();
  // If a save fails (torn.com's localStorage is shared with Torn and every other script, and can
  // fill up), keep the value in memory so this tab still works, and report it in Raw statuses.
  // Before this, a failed save was silent and the board kept showing the last copy that fit.
  const mem = {};
  let storeError = '';

  // Torn PDA 3.15+ gives each script its own on-disk store (PDA_storage, 10 MB by default) that
  // doesn't share the ~5 MB browser space and survives clearing the browser cache. It's async, so
  // the script loads it once at start (see boot below), works from this in-memory copy, and writes
  // changes back in small batches. The leader key stays in localStorage: it's tiny, and it has to
  // be readable at once by every tab.
  let native = null;
  const LOCAL_ONLY = new Set(['ukw_leader']);
  let nativePending = {};
  let nativeTimer = null;
  const flushNative = () => {
    nativeTimer = null;
    const batch = nativePending;
    nativePending = {};
    Promise.resolve(PDA_storage.setMany(batch))
      .then(() => {
        if (storeError.startsWith('PDA storage')) storeError = '';
      })
      .catch((e) => {
        storeError = `PDA storage: ${(e && (e.code || e.message)) || 'save failed'}`;
      });
  };

  const flushNow = () => {
    if (nativeTimer) clearTimeout(nativeTimer);
    if (Object.keys(nativePending).length) flushNative();
  };

  const store = {
    get(k, d) {
      if (native && !LOCAL_ONLY.has(k)) return k in native ? native[k] : d;
      if (k in mem) return mem[k];
      if (useGM) return GM_getValue(k, d);
      try {
        const v = localStorage.getItem(`fw:${k}`);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      if (native && !LOCAL_ONLY.has(k)) {
        native[k] = v;
        nativePending[k] = v;
        if (!nativeTimer) nativeTimer = setTimeout(flushNative, 500);
        return;
      }
      const ok = () => {
        delete mem[k];
        if (storeError.startsWith(`${k}:`)) storeError = '';
      };
      try {
        if (useGM) GM_setValue(k, v);
        else localStorage.setItem(`fw:${k}`, JSON.stringify(v));
        ok();
      } catch (e) {
        // Storage full: the old value still counts against the limit while it's being replaced, so
        // remove it (and our own spare server copy) and try once more before giving up.
        if (!useGM) {
          try {
            localStorage.removeItem(`fw:${k}`);
            if (k !== 'fw_srv') localStorage.removeItem('fw:fw_srv');
            localStorage.setItem(`fw:${k}`, JSON.stringify(v));
            ok();
            return;
          } catch (e2) {}
        }
        mem[k] = v;
        storeError = `${k}: ${(e && e.name) || 'save failed'}`;
      }
    },
  };

  // Torn PDA swaps this placeholder for the user's own key when it injects the script.
  const PDA_KEY = '###PDA-APIKEY###';
  const pdaKey = PDA_KEY.startsWith('#') ? '' : PDA_KEY;

  const now = () => Math.floor(Date.now() / 1000);
  const getCfg = () => {
    const c = Object.assign({}, DEFAULTS, store.get('ukw_cfg', {}));
    if (!c.apiKey && pdaKey) c.apiKey = pdaKey;
    return c;
  };
  const setCfg = (c) => store.set('ukw_cfg', c);
  const getState = () => {
    const s = store.get('fw_state', {});
    return s && typeof s === 'object' ? s : {};
  };
  const setState = (s) => store.set('fw_state', s);
  const getMeta = () => Object.assign({ myDest: null, myLoc: '', enemies: [], warNote: '' }, store.get('fw_meta', {}));
  const setMeta = (m) => store.set('fw_meta', m);

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
  // Matching is loose on purpose: any case, "Traveling" or "Travelling", and alternate country names.
  const NAMES = {
    'Cayman Islands': ['cayman'],
    'UAE': ['uae', 'united arab emirates', 'dubai'],
    'United Kingdom': ['united kingdom', 'london'],
    'South Africa': ['south africa', 'johannesburg'],
  };
  const namesFor = (c) => NAMES[c] || [c.toLowerCase()];
  const findCountry = (str) => COUNTRIES.find((c) => namesFor(c).some((n) => str.includes(n))) || null;
  function parseLoc(s) {
    const state = String((s && s.state) || '').toLowerCase();
    const desc = String((s && s.description) || '').toLowerCase();
    const details = String((s && s.details) || '').toLowerCase();
    const text = `${desc} ${details}`;

    if (state === 'traveling' || state === 'travelling') {
      // Current format: "Traveling from Torn to China" / "Traveling from Switzerland to Torn".
      const ft = desc.match(/from\s+(.+?)\s+to\s+(.+?)\s*$/);
      if (ft) {
        const [, from, to] = ft;
        if (/\btorn\b/.test(to)) {
          const c = findCountry(from);
          return c ? { kind: 'back', country: c } : { kind: 'torn', country: null };
        }
        const c = findCountry(to);
        return c ? { kind: 'out', country: c } : { kind: 'torn', country: null };
      }
      // Older formats: "Traveling to China" / "Returning to Torn from China".
      const c = findCountry(text);
      if (!c) return { kind: 'torn', country: null };
      return /return/.test(desc) ? { kind: 'back', country: c } : { kind: 'out', country: c };
    }

    for (const c of COUNTRIES) {
      const hit = namesFor(c).some((n) => text.includes(n));
      if (state === 'abroad' && hit) return { kind: 'there', country: c };
      if (state === 'hospital' && DESTS[c].adj.some((a) => text.includes(`${a.toLowerCase()} hospital`))) {
        return { kind: 'there', country: c, hosp: true };
      }
    }
    return { kind: 'torn', country: null };
  }

  // Count enemies per country from the stored state.
  function countryBoard(state, t) {
    const board = {};
    for (const c of COUNTRIES) board[c] = { there: [], hosp: [], inbound: [] };
    for (const [id, r] of Object.entries(state)) {
      if (id.startsWith('_') || !r || !r.country || !board[r.country]) continue;
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
      if (typeof GM_notification === 'function' && !IS_PDA) {
        GM_notification({ title, text, timeout: 15000, onclick: () => url && window.open(url, '_blank') });
      } else if (window.Notification && Notification.permission === 'granted') {
        new Notification(title, { body: text });
      }
    } catch (e) {}
    if (cfg.webhook) {
      const body = JSON.stringify({ content: `**${title}**\n${text}${url ? `\n<${url}>` : ''}` });
      try {
        if (typeof GM_xmlhttpRequest === 'function' && !IS_PDA) {
          GM_xmlhttpRequest({ method: 'POST', url: cfg.webhook, headers: { 'Content-Type': 'application/json' }, data: body });
        } else {
          fetch(cfg.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
        }
      } catch (e) {}
    }
    toast(`${title}: ${text}`);
  }

  // ---------- Leader election so only one tab polls ----------
  // Compare "1.6.3" style versions; older copies wrote no version at all.
  const newer = (a, b) => {
    const pa = String(a || '0').split('.').map(Number);
    const pb = String(b || '0').split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };
  function amLeader() {
    const l = store.get('ukw_leader', null);
    const t = now();
    // A newer copy takes over from an older one straight away, so a leftover duplicate install
    // can't keep writing stale data over the top.
    if (!l || l.tab === TAB_ID || t - l.ts > LEADER_TTL || newer(VERSION, l.v)) {
      store.set('ukw_leader', { tab: TAB_ID, ts: t, v: VERSION });
      return true;
    }
    return false;
  }

  // ---------- Cross-site POST ----------
  // A plain fetch() to Supabase from torn.com fails ("Failed to fetch"), most likely because of
  // the page's content security policy. GM_xmlhttpRequest (Tampermonkey) and PDA_httpPost
  // (Torn PDA) run outside the page, so the policy doesn't apply.
  // Torn PDA's documented route is window.flutter_inappwebview.callHandler('PDA_httpPost', url,
  // headers, body), which returns { status, statusText, responseText, responseHeaders }.
  // A global PDA_httpPost only exists when a GM shim script is loaded, so it's the fallback.
  function pdaPoster() {
    const bridge = window.flutter_inappwebview;
    if (bridge && typeof bridge.callHandler === 'function') {
      return { fn: (u, h, b) => bridge.callHandler('PDA_httpPost', u, h, b), via: 'PDA bridge' };
    }
    if (typeof PDA_httpPost === 'function') return { fn: PDA_httpPost, via: 'PDA_httpPost' };
    return null;
  }
  let lastTransport = '';

  function postJSON(url, headers, body) {
    const data = JSON.stringify(body);
    const parse = (status, text) => {
      if (text && typeof text === 'object') return { status, json: text };
      let j = null;
      try { j = JSON.parse(text); } catch (e) {}
      return { status, json: j };
    };
    const tag = (via) => (e) => {
      throw new Error(`${(e && e.message) || 'Request failed'} [via ${via}]`);
    };
    if (!IS_PDA && typeof GM_xmlhttpRequest === 'function') {
      lastTransport = 'GM_xmlhttpRequest';
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST', url, headers, data, timeout: REQ_TIMEOUT,
          onload: (r) => resolve(parse(r.status, r.responseText)),
          onerror: () => reject(new Error('GM request failed')),
          ontimeout: () => reject(new Error('GM request timed out')),
        });
      });
    }
    const pda = IS_PDA ? pdaPoster() : null;
    if (pda) {
      lastTransport = pda.via;
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), REQ_TIMEOUT));
      return Promise.race([Promise.resolve(pda.fn(url, headers, data)), timeout])
        .then((r) => {
          if (typeof r === 'string') {
            try { r = JSON.parse(r); } catch (e) { return parse(200, r); }
          }
          return parse(Number((r && r.status) || 0), r && (r.responseText !== undefined ? r.responseText : r.data));
        })
        .catch(tag(pda.via));
    }
    lastTransport = 'fetch';
    return timedFetch(url, { method: 'POST', headers, body: data })
      .then((r) => r.text().then((txt) => parse(r.status, txt)))
      .catch(tag('fetch'));
  }

  // ---------- API ----------
  const REQ_TIMEOUT = 10000; // ms before a request counts as failed
  const timedFetch = (url, opts = {}) => {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), REQ_TIMEOUT) : null;
    return fetch(url, Object.assign({}, opts, ctl ? { signal: ctl.signal } : {}))
      .catch((e) => {
        throw new Error(e && e.name === 'AbortError' ? 'Request timed out' : (e && e.message) || 'Network error');
      })
      .finally(() => timer && clearTimeout(timer));
  };
  // Cache-busting: some webviews (Torn PDA on iOS) serve repeat GETs from their HTTP cache, which
  // froze the member list. no-store plus the API's own timestamp parameter forces a fresh copy.
  // In Torn PDA the web view's own fetch returned every enemy as "Okay" even with cache-busting,
  // so PDA sends Torn calls through its native PDA_httpGet handler instead.
  function pdaGetter() {
    const bridge = window.flutter_inappwebview;
    if (bridge && typeof bridge.callHandler === 'function') return (u, h) => bridge.callHandler('PDA_httpGet', u, h);
    if (typeof PDA_httpGet === 'function') return PDA_httpGet;
    return null;
  }
  const api = (path, key) => {
    const url = `https://api.torn.com/v2/${path}${path.includes('?') ? '&' : '?'}timestamp=${Date.now()}&key=${encodeURIComponent(key)}`;
    const get = IS_PDA ? pdaGetter() : null;
    const req = get
      ? Promise.race([
          Promise.resolve(get(url, {})),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), REQ_TIMEOUT)),
        ]).then((r) => {
          if (typeof r === 'string') {
            try { r = JSON.parse(r); } catch (e) {}
          }
          const body = r && r.responseText !== undefined ? r.responseText : r;
          return typeof body === 'string' ? JSON.parse(body) : body;
        })
      : timedFetch(url, { cache: 'no-store' }).then((r) => r.json());
    return req.then((j) => {
      if (j && j.error) throw new Error(`API error ${j.error.code}: ${j.error.error}`);
      return j;
    });
  };

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

  // ---------- FFScouter battle stat estimates ----------
  // https://ffscouter.com/api/v1/get-stats?key=KEY&targets=1,2,3 returns, per player,
  // bs_estimate_human (e.g. "2.99b") and fair_fight. The key is a Torn API key registered at
  // ffscouter.com. Estimates change slowly, so each player is looked up at most every 6 hours,
  // and only enemies who are away from Torn are looked up at all.
  const FF_TTL = 6 * 3600;
  const FF_RETRY = 600; // don't retry a failed lookup for 10 minutes
  const ffTried = {};
  let ffError = '';
  function getJSON(url) {
    const parse = (status, text) => {
      if (text && typeof text === 'object') return { status, json: text };
      let j = null;
      try { j = JSON.parse(text); } catch (e) {}
      return { status, json: j };
    };
    if (!IS_PDA && typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: REQ_TIMEOUT,
          onload: (r) => resolve(parse(r.status, r.responseText)),
          onerror: () => reject(new Error('request failed')),
          ontimeout: () => reject(new Error('timed out')),
        });
      });
    }
    const get = IS_PDA ? pdaGetter() : null;
    if (get) return Promise.resolve(get(url, {})).then((r) => parse(Number((r && r.status) || 0), r && r.responseText));
    return timedFetch(url).then((r) => r.text().then((txt) => parse(r.status, txt)));
  }
  const ffCache = () => store.get('fw_ffs', {}) || {};
  const ffFor = (id) => ffCache()[String(id)] || null;
  async function refreshFF(cfg, ids) {
    const key = cfg.ffKey || cfg.apiKey;
    if (!cfg.showStats || !key || !ids.length) return;
    const t = now();
    const cache = ffCache();
    const need = ids.map(String).filter((id) => {
      const c = cache[id];
      return (!c || t - c.at > FF_TTL) && !(ffTried[id] && t - ffTried[id] < FF_RETRY);
    });
    if (!need.length) return;
    need.forEach((id) => (ffTried[id] = t));
    try {
      for (let i = 0; i < need.length; i += 50) {
        const batch = need.slice(i, i + 50);
        const { status, json } = await getJSON(`https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(key)}&targets=${batch.join(',')}`);
        if (!Array.isArray(json)) {
          const msg = (json && (json.error || json.message)) || `HTTP ${status}`;
          ffError = json && json.code === 6 ? 'key not registered at ffscouter.com' : String(msg);
          return;
        }
        for (const r of json) {
          if (r && r.player_id != null) {
            cache[String(r.player_id)] = { h: r.bs_estimate_human || null, ff: r.fair_fight != null ? r.fair_fight : null, at: t };
          }
        }
      }
      // Keep the cache small: drop entries older than a day.
      for (const id of Object.keys(cache)) if (t - cache[id].at > 86400) delete cache[id];
      store.set('fw_ffs', cache);
      ffError = '';
    } catch (e) {
      ffError = (e && e.message) || 'lookup failed';
    }
  }
  const statsLabel = (id) => {
    const c = ffFor(id);
    return c && c.h ? `~${c.h}` : '';
  };

  // ---------- Poll ----------
  let lastPoll = 0;
  let lastError = '';
  let forceWarCheck = true;
  let polling = false; // stops a slow poll overlapping the next one and overwriting newer data

  const SERVER_FRESH = 120; // seconds; older server data counts as stale and the script polls Torn itself

  function readServer(cfg) {
    const token = cfg.serverToken || SERVER_TOKEN;
    if (!token) return Promise.resolve(null);
    return postJSON(SERVER_URL, { apikey: SERVER_KEY, 'Content-Type': 'application/json' }, { p_token: token })
      .then(({ status, json: j }) => (status >= 200 && status < 300 && j ? j : { error: (j && (j.message || j.error)) || `HTTP ${status}` }))
      .then((j) => {
        // Throttled (another device on the same connection read it a moment ago): reuse the last good copy.
        if (j && j.throttled) {
          const cached = store.get('fw_srv', null);
          return cached ? Object.assign({}, cached, { fromCache: true }) : j;
        }
        if (j && !j.error) store.set('fw_srv', j);
        return j;
      })
      .catch((e) => ({ error: e && e.message ? e.message : 'unreachable' }))
      .then((j) => (j && j.error && !/\[via /.test(j.error) ? Object.assign({}, j, { error: `${j.error} [via ${lastTransport}]` }) : j));
  }

  async function poll() {
    if (polling) return;
    const cfg = getCfg();
    if (!cfg.apiKey) return;
    if (cfg.enemyMode === 'manual' && !cfg.factionId) return;
    const t = now();
    if (t - lastPoll < cfg.pollSec) return;
    lastPoll = t;
    polling = true;

    try {
      const [me, srv] = await Promise.all([api('user/basic?striptags=true', cfg.apiKey), readServer(cfg)]);

      // Server health.
      let server = null;
      let serverUsable = false;
      if (srv) {
        if (srv.error) {
          server = { ok: false, error: srv.error };
        } else if (srv.throttled) {
          server = { ok: true, error: '', lastPoll: 0, at: t, note: 'throttled, no cached copy yet' };
        } else {
          const m = srv.meta || {};
          const age = t - (m.last_poll || 0);
          server = {
            ok: !m.last_error, error: m.last_error || '', lastPoll: m.last_poll || 0, at: t, cached: !!srv.fromCache,
            away: (srv.members || []).length, enemies: (m.enemies || []).length,
          };
          // The server only tracks the war opponents, so fixed-faction mode always polls Torn directly.
          serverUsable = server.ok && age <= SERVER_FRESH && cfg.enemyMode === 'auto';
        }
      }

      // Build one list of observations, from the server when it's fresh, otherwise from Torn.
      // obs: { id, name, level, faction, loc, plane, until, rawState, rawDesc, srvDepart }
      const obs = [];
      const debug = { at: t, factions: [], source: serverUsable ? 'server' : 'torn' };
      let enemies;

      if (serverUsable) {
        enemies = ((srv.meta && srv.meta.enemies) || []).filter((e) => cfg.includeMinorWars || e.type === 'ranked');
        const watched = new Set(enemies.map((e) => String(e.id)));
        setMeta(Object.assign(getMeta(), { enemies, warNote: enemies.length ? '' : 'Not at war right now' }));
        // The server returns everyone who isn't sitting in Torn; anyone missing is in Torn.
        for (const r of srv.members || []) {
          if (!watched.has(String(r.faction_id))) continue;
          obs.push({
            id: String(r.player_id),
            name: r.name,
            level: r.level,
            faction: r.faction_name,
            loc: { kind: r.kind, country: r.country, hosp: !!r.hosp },
            plane: r.plane || null,
            until: r.hosp ? r.hosp_until : null,
            rawState: r.kind === 'there' ? (r.hosp ? 'Hospital' : 'Abroad') : 'Traveling',
            rawDesc: `${r.kind} ${r.country || ''} (from server)`,
            srvDepart: r.kind === 'out' ? r.depart_at || null : null,
          });
        }
        enemies.forEach((e) => debug.factions.push({ id: e.id, name: e.name, count: obs.filter((o) => o.faction === e.name).length, away: true }));
      } else {
        if (cfg.enemyMode === 'auto') {
          await refreshWars(cfg, forceWarCheck);
          forceWarCheck = false;
          enemies = getMeta().enemies;
        } else {
          enemies = cfg.factionId.split(',').map((x) => x.trim()).filter(Boolean).map((id) => ({ id, name: `Faction ${id}`, type: 'manual' }));
          setMeta(Object.assign(getMeta(), { enemies, warNote: '' }));
        }
        // Server takeoff times still help when its data is stale but present.
        const srvDepart = new Map();
        if (srv && !srv.error && !srv.throttled) {
          (srv.members || []).forEach((r) => r.kind === 'out' && r.depart_at && srvDepart.set(String(r.player_id), r));
        }
        const lists = await Promise.all(enemies.map((e) => api(`faction/${encodeURIComponent(e.id)}/members?striptags=true`, cfg.apiKey)));
        lists.forEach((data, i) => {
          const fac = enemies[i];
          // v2 returns an array; accept an id-keyed object too in case that ever changes.
          const raw = (data && data.members) || [];
          const members = Array.isArray(raw) ? raw : Object.entries(raw).map(([mid, mm]) => Object.assign({ id: Number(mid) }, mm));
          debug.factions.push({ id: fac.id, name: fac.name, count: members.length });
          for (const m of members) {
            const st = m.status || {};
            const loc = parseLoc(st);
            const sv = srvDepart.get(String(m.id));
            obs.push({
              id: String(m.id),
              name: m.name,
              level: m.level,
              faction: fac.name,
              loc,
              plane: st.plane_image_type || null,
              until: st.until || null,
              rawState: st.state || '',
              rawDesc: st.description || '',
              srvDepart: sv && sv.country === loc.country && loc.kind === 'out' ? sv.depart_at : null,
            });
          }
        });
      }
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
      // Only people away from Torn are kept (that keeps the saved state small), so a missing record
      // means "was in Torn at the last poll". That only holds if the last poll used the same source.
      const prevSource = state._source;
      const prevPollAt = state._lastPoll || 0;
      state._source = debug.source;
      state._lastPoll = t;
      const seen = new Set();

      for (const o of obs) {
        const { id, loc } = o;
        seen.add(id);
        const key = `${loc.kind}:${loc.country || ''}`;
        const old = state[id];
        const prev = old
          ? { key: old.key, kind: old.kind, country: old.country, seenAt: old.seenAt }
          : !firstRun && prevSource === debug.source
            ? { key: 'torn:', kind: 'torn', country: null, seenAt: prevPollAt || t - cfg.pollSec }
            : null;
        const rec = old || { key, departAt: null, warned: false };
        rec.name = o.name;
        rec.level = o.level;
        rec.faction = o.faction;
        rec.plane = o.plane || (loc.kind === 'out' ? rec.plane : null) || null;
        rec.kind = loc.kind;
        rec.country = loc.country;
        rec.hosp = !!loc.hosp;
        rec.hospUntil = loc.hosp ? o.until || null : null;
        rec.rawState = o.rawState;
        rec.rawDesc = o.rawDesc;

        const profile = `https://www.torn.com/profiles.php?XID=${id}`;
        const who = `${o.name} [${id}] (${o.faction})`;
        const mineToo = myDest && loc.country === myDest;
        const code = loc.country && DESTS[loc.country] ? DESTS[loc.country].code : '';

        if (prev && prev.key !== key) {
          if (loc.kind === 'out') {
            // Took off since the last poll. If that poll was recent, split the difference.
            // After a long gap (tab closed, PC asleep) we can't tell when they left, so leave it
            // unknown rather than guess "just now"; the server's time fills it in if it has one.
            const gap = t - (prev.seenAt || 0);
            rec.departAt = gap <= cfg.pollSec * 3 ? t - Math.round(gap / 2) : null;
            rec.warned = false;
            if (mineToo && cfg.alertDepart) {
              const mins = flightMin(loc.country, rec.plane);
              const extra = rec.plane === 'airliner' ? ` (or ~${businessMin(loc.country)}m if business class)` : '';
              alertOut(`Enemy flying to ${code}`, `${who} lvl ${o.level} took off for ${loc.country}. ${planeLabel(rec.plane)}${mins ? `, lands in ~${fmt(mins * 60)}${extra}` : ''}`, profile);
            }
          } else if (loc.kind === 'there' && prev.kind === 'out' && mineToo && cfg.alertLanded) {
            alertOut(`Enemy landed in ${code}`, `${who} lvl ${o.level} is now in ${loc.country}`, profile);
          } else if (loc.kind === 'back' && prev.kind === 'there' && prev.country === myDest && cfg.alertLeave) {
            alertOut(`Enemy leaving ${code}`, `${who} lvl ${o.level} is flying back to Torn from ${loc.country}`, profile);
          }
        }

        if (loc.kind === 'out') {
          // Prefer the server's takeoff time: it saw the flight even if no tab was open.
          if (o.srvDepart) {
            rec.departAt = o.srvDepart;
            rec.fromServer = true;
          } else {
            rec.fromServer = false;
          }
          // Exact arrival if the API ever gives one, otherwise estimate from takeoff.
          const mins = flightMin(loc.country, rec.plane);
          if (!o.srvDepart && o.until && o.until > t) rec.eta = o.until;
          else if (rec.departAt && mins) rec.eta = rec.departAt + mins * 60;
          else rec.eta = null;
          rec.bizEta = rec.plane === 'airliner' && rec.departAt ? rec.departAt + businessMin(loc.country) * 60 : null;

          if (mineToo && rec.eta && !rec.warned && t >= rec.eta - cfg.warnMin * 60) {
            rec.warned = true;
            if (cfg.alertWarn && !firstRun) alertOut(`Enemy landing in ${code} soon`, `${who} lvl ${o.level} lands in ${loc.country} in ~${fmt(rec.eta - t)}`, profile);
          }
        } else {
          rec.departAt = null;
          rec.eta = null;
          rec.bizEta = null;
          rec.warned = false;
        }

        rec.key = key;
        rec.seenAt = t;
        if (loc.kind === 'torn') delete state[id];
        else state[id] = rec;
      }

      // Drop anyone not reported this time: left the faction, faction no longer watched, or (server
      // mode) back in Torn. A record that drops out while flying home just ends; alerts only care
      // about flights towards you.
      for (const id of Object.keys(state)) {
        if (id.startsWith('_')) continue;
        if (!seen.has(id) || state[id].kind === 'torn') delete state[id];
      }
      state._init = true;
      setState(state);
      // Battle stat estimates for enemies who are away (not awaited, so the poll stays quick).
      refreshFF(cfg, Object.keys(state).filter((id) => !id.startsWith('_')));

      // You just started heading to (or landed in) a new country: say how risky it is.
      if (myDest && myDest !== prevDest && cfg.alertArrive && !firstRun) {
        const b = countryBoard(state, t)[myDest];
        alertOut(`${myDest}: ${b.risky ? 'RISKY' : 'safe'}`, boardLine(b));
      }
      const friends = srv && !srv.error && !srv.throttled && Array.isArray(srv.friends) ? srv.friends : null;
      const myId = me && me.profile ? me.profile.id : null;
      setMeta(Object.assign(getMeta(), { myDest, myKind: mine.kind, myLoc, myRaw: `${myStatus.state || ''}: ${myStatus.description || ''}`, debug, server, friends, myId }));
    } catch (e) {
      lastError = e && e.message ? e.message : 'Network error';
    } finally {
      polling = false;
    }
  }

  // ---------- Flags ----------
  // Small inline SVG flags (simplified). Emoji flags don't render on Windows, and Torn's page
  // policy can block images from other sites, so these are drawn here.
  const ujack = (x, y, w, h) =>
    `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 60 30" preserveAspectRatio="none">` +
    '<rect width="60" height="30" fill="#012169"/>' +
    '<path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/>' +
    '<path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" stroke-width="2.5"/>' +
    '<path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/>' +
    '<path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></svg>';
  const star = (cx, cy, r) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.4 : r;
      pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
    }
    return `<polygon points="${pts.join(' ')}" fill="#ffde00"/>`;
  };
  const stripes = (cols) => cols.map((c, i) => `<rect y="${(i * 12) / cols.length}" width="18" height="${12 / cols.length + 0.05}" fill="${c}"/>`).join('');
  const FLAG_ART = {
    'Mexico': '<rect width="6" height="12" fill="#006847"/><rect x="6" width="6" height="12" fill="#fff"/><rect x="12" width="6" height="12" fill="#ce1126"/><circle cx="9" cy="6" r="1.6" fill="#8c5a2b"/>',
    'Cayman Islands': `<rect width="18" height="12" fill="#012169"/>${ujack(0, 0, 9, 6)}<circle cx="13" cy="6.5" r="2.4" fill="#fff" stroke="#c8102e" stroke-width=".5"/>`,
    'Canada': '<rect width="18" height="12" fill="#d52b1e"/><rect x="4.5" width="9" height="12" fill="#fff"/><polygon points="9,2.4 9.9,4.4 11.6,3.9 10.9,6 12.1,6.6 9.6,8.1 9.7,9.6 8.3,9.6 8.4,8.1 5.9,6.6 7.1,6 6.4,3.9 8.1,4.4" fill="#d52b1e"/>',
    'Hawaii': `${stripes(['#fff', '#c8102e', '#012169', '#fff', '#c8102e', '#012169', '#fff', '#c8102e'])}${ujack(0, 0, 9, 6)}`,
    'United Kingdom': ujack(0, 0, 18, 12),
    'Argentina': `${stripes(['#74acdf', '#fff', '#74acdf'])}<circle cx="9" cy="6" r="1.4" fill="#f6b40e"/>`,
    'Switzerland': '<rect width="18" height="12" fill="#d52b1e"/><rect x="8" y="2.6" width="2" height="6.8" fill="#fff"/><rect x="5.6" y="5" width="6.8" height="2" fill="#fff"/>',
    'Japan': '<rect width="18" height="12" fill="#fff"/><circle cx="9" cy="6" r="3.6" fill="#bc002d"/>',
    'China': `<rect width="18" height="12" fill="#de2910"/>${star(3.4, 3.2, 2)}${star(6.6, 1.4, 0.6)}${star(7.6, 2.9, 0.6)}${star(7.6, 4.8, 0.6)}${star(6.6, 6.2, 0.6)}`,
    'UAE': '<rect width="18" height="4" fill="#009739"/><rect y="4" width="18" height="4" fill="#fff"/><rect y="8" width="18" height="4" fill="#000"/><rect width="4.5" height="12" fill="#ef3340"/>',
    'South Africa': '<rect width="18" height="6" fill="#e03c31"/><rect y="6" width="18" height="6" fill="#001489"/><polygon points="0,0 3,0 9,4.4 18,4.4 18,7.6 9,7.6 3,12 0,12" fill="#fff"/><polygon points="0,1.3 1.7,0 8.5,5.1 18,5.1 18,6.9 8.5,6.9 1.7,12 0,10.7" fill="#007749"/><polygon points="0,2.4 4.9,6 0,9.6" fill="#ffb81c"/><polygon points="0,3.3 3.7,6 0,8.7" fill="#000"/>',
  };
  const flag = (c, size = 18) =>
    FLAG_ART[c]
      ? `<svg class="fw-flag" width="${size}" height="${(size * 2) / 3}" viewBox="0 0 18 12" aria-label="${esc(c)}"><title>${esc(c)}</title>${FLAG_ART[c]}<rect width="18" height="12" fill="none" stroke="rgba(255,255,255,.25)" stroke-width=".6"/></svg>`
      : '';

  // ---------- UI ----------
  const css = `
    #ukw-btn{position:fixed;left:8px;bottom:70px;z-index:99999;background:#1d3b5c;color:#fff;border:1px solid #4a7fb5;border-radius:6px;padding:6px 9px;font:bold 12px Arial;cursor:pointer;display:flex;align-items:center;gap:5px}
    #ukw-btn.risky{background:#7a1f1f;border-color:#c0392b}
    #ukw-btn.safe{background:#1e5a2e;border-color:#2ecc71}
    #ukw-btn .n{background:#c0392b;border-radius:8px;padding:0 5px}
    #ukw-btn .w{background:#e67e22;border-radius:8px;padding:0 5px}
    #ukw-panel{position:fixed;left:8px;bottom:105px;z-index:99999;width:340px;max-width:calc(100vw - 16px);max-height:72vh;overflow:auto;background:#1b1d21;color:#d7d9dd;border:1px solid #3a3f47;border-radius:8px;font:12px/1.35 Arial,sans-serif;display:none;box-shadow:0 6px 24px rgba(0,0,0,.5)}
    #ukw-panel .hd{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#23262c;border-bottom:1px solid #31353c;position:sticky;top:0;z-index:1}
    #ukw-panel .hd b{color:#fff;font-size:13px}
    #ukw-panel .sub{padding:6px 10px 2px;color:#9aa0a8}
    #ukw-panel .sec{padding:6px 10px}
    #ukw-panel h4{margin:6px 0 4px;color:#fff;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
    #ukw-panel table{width:100%;border-collapse:collapse;font:inherit;color:inherit}
    #ukw-panel td{font:inherit;color:inherit}
    #ukw-panel td{padding:3px 2px;border-bottom:1px solid #2c3036;vertical-align:top}
    #ukw-panel a{color:#6fb3ff;text-decoration:none}
    #ukw-panel input[type=text],#ukw-panel input[type=number],#ukw-panel select{width:100%;box-sizing:border-box;background:#111;color:#ddd;border:1px solid #555;padding:3px;margin:2px 0 5px}
    #ukw-panel .row{display:flex;gap:6px}
    #ukw-panel .row>div{flex:1}
    #ukw-panel button{background:#1d3b5c;color:#fff;border:1px solid #4a7fb5;border-radius:4px;padding:4px 8px;cursor:pointer;margin-top:4px;font-size:11px}
    #ukw-panel .err{color:#ff7b6b}
    #ukw-panel .muted{color:#8a9099}
    #ukw-panel .fw-flag{vertical-align:-1px;border-radius:2px;flex:none}
    #ukw-panel .card{border:1px solid #3a2a2a;border-left:3px solid #c0392b;background:#241b1b;border-radius:6px;margin:0 0 6px;overflow:hidden}
    #ukw-panel .card.me{border-color:#4a7fb5;border-left-color:#6fb3ff;background:#1c2430}
    #ukw-panel .card .top{display:flex;align-items:center;gap:7px;padding:6px 8px;cursor:pointer}
    #ukw-panel .card .name{font-weight:bold;color:#fff;flex:1}
    #ukw-panel .chips{display:flex;flex-wrap:wrap;gap:4px;padding:0 8px 6px}
    #ukw-panel .chip{border-radius:10px;padding:1px 7px;font-size:11px;background:#33373e;color:#e2e4e8;white-space:nowrap}
    #ukw-panel .chip.there{background:#7a1f1f;color:#ffd6d0}
    #ukw-panel .chip.in{background:#6b4a12;color:#ffe3b0}
    #ukw-panel .chip.hosp{background:#3d3550;color:#d9ccff}
    #ukw-panel .people{border-top:1px solid #3a2a2a;background:#1d1818;padding:2px 8px}
    #ukw-panel .people td{border-bottom:1px solid #2a2222}
    #ukw-panel .safe{display:flex;flex-wrap:wrap;gap:6px}
    #ukw-panel .safe span{display:inline-flex;align-items:center;gap:4px;background:#1e2a22;border:1px solid #2c4a35;border-radius:12px;padding:2px 7px;color:#b8e6c4;font-size:11px}
    #ukw-panel .safe span.me{border-color:#6fb3ff}
    #ukw-panel .safe span.go{cursor:pointer}
    #ukw-panel .safe span.go:hover{background:#26402e;border-color:#3f7a52}
    #ukw-panel .mate{display:flex;align-items:center;gap:7px;padding:5px 0;border-bottom:1px solid #2c3036}
    #ukw-panel .mate .info{flex:1;min-width:0}
    #ukw-panel .mate button{margin:0;background:#8a4b0f;border-color:#e67e22}
    #ukw-panel .ft{display:flex;justify-content:space-between;padding:8px 10px;border-top:1px solid #31353c}
    #ukw-toast{position:fixed;left:50%;top:60px;transform:translateX(-50%);z-index:100000;background:#1d3b5c;color:#fff;padding:8px 12px;border-radius:6px;font:13px Arial;display:none;max-width:90vw}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // Another copy of this script already drew its button on this page: Torn PDA can end up with
  // the script installed more than once, and the copies overwrite each other's data.
  const dupeOnPage = !!document.getElementById('ukw-btn');
  const btn = document.createElement('div');
  btn.id = 'ukw-btn';
  const panel = document.createElement('div');
  panel.id = 'ukw-panel';
  const toastEl = document.createElement('div');
  toastEl.id = 'ukw-toast';
  (document.body || document.documentElement).append(btn, panel, toastEl);

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = 'none'), 8000);
  }

  let showSettings = false;
  let showDebug = false;
  const expanded = new Set(); // countries opened in the board
  btn.onclick = () => {
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    render();
  };

  function renderSettings() {
    const c = getCfg();
    const chk = (k, label) => `<label><input type="checkbox" data-k="${k}" ${c[k] ? 'checked' : ''}> ${label}</label><br>`;
    return `<div class="sec">
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
      FFScouter key (blank = your Torn key; it must be registered at ffscouter.com)<input type="text" data-k="ffKey" value="${esc(c.ffKey)}">
      Server token override (leave blank to use the built-in one)<input type="text" data-k="serverToken" value="${esc(c.serverToken)}">
      <div class="muted" style="margin:4px 0">Alerts cover the country you're in or flying to:</div>
      ${chk('alertArrive', 'Safe/risky summary when you head somewhere')}
      ${chk('alertDepart', 'Enemy takes off for your country')}
      ${chk('alertWarn', 'Enemy about to land')}
      ${chk('alertLanded', 'Enemy landed')}
      ${chk('alertLeave', 'Enemy leaves your country')}
      ${chk('showMates', 'Show faction mates in danger')}
      ${chk('showStats', 'Show FFScouter battle stat estimates')}
      <button id="ukw-save">Save</button> <button id="ukw-test">Test alert</button></div>`;
  }

  function memberRow(id, r, t, multi) {
    const est = statsLabel(id);
    const link = `<a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank">${esc(r.name)}</a> <span class="muted">${r.level}${est ? ` · <span title="FFScouter battle stat estimate">${esc(est)}</span>` : ''}${multi && r.faction ? ` · ${esc(r.faction)}` : ''}</span>`;
    if (r.kind === 'out') {
      const eta = r.eta ? `${fmt(r.eta - t)}${r.fromServer ? ' <span class="muted" title="Takeoff time from the server">(srv)</span>' : ''}` : '<span class="muted">ETA unknown</span>';
      const biz = r.bizEta ? `<br><span class="muted">business: ${fmt(r.bizEta - t)}</span>` : '';
      return `<tr><td>${link}<br><span class="muted">${planeLabel(r.plane)}</span></td><td style="text-align:right">${eta}${biz}</td></tr>`;
    }
    const note = r.hosp ? `in hosp${r.hospUntil && r.hospUntil > t ? ` ${fmt(r.hospUntil - t)}` : ''}` : 'landed';
    return `<tr><td>${link}</td><td style="text-align:right" class="muted">${note}</td></tr>`;
  }

  // Shows exactly what the API returned for each enemy and how the script read it.
  function renderDebug(state, meta, t) {
    const d = meta.debug || {};
    let h = `<div class="sec"><h4>Raw statuses</h4>`;
    h += `<div class="muted">Storage: ${native ? 'PDA native storage' : useGM ? 'Tampermonkey' : 'localStorage'}${IS_PDA && !native ? ' (PDA)' : ''}. Last poll: ${d.at ? `${t - d.at}s ago` : 'never'}</div>`;
    if (storeError) h += `<div class="err">Saving failed (${esc(storeError)}). Working from memory in this tab.</div>`;
    h += `<div class="muted">You: ${esc(meta.myRaw || 'unknown')}</div>`;
    const sv = meta.server;
    h += `<div class="muted">Server: ${!sv ? 'no reply yet' : !sv.ok ? `<span class="err">${esc(sv.error)}</span>` : sv.note ? esc(sv.note) : `OK, last enemy poll ${Math.max(0, sv.at - sv.lastPoll)}s before your last check`}</div>`;
    if (sv && sv.ok && !sv.note) {
      h += `<div class="muted">Server data: ${sv.away || 0} enemies away, ${sv.enemies || 0} faction(s), ${(meta.friends || []).length} faction mates away, ${Math.max(0, sv.at - sv.lastPoll)}s old${sv.cached ? ' (saved copy)' : ''}</div>`;
    }
    h += `<div class="muted">FFScouter: ${!getCfg().showStats ? 'off' : ffError ? `<span class="err">${esc(ffError)}</span>` : `${Object.keys(ffCache()).length} estimate(s) cached`}</div>`;
    h += `<div class="muted">Enemy data from: ${d.source === 'server' ? 'server (your key only checks your own status)' : 'Torn API directly'}</div>`;
    (d.factions || []).forEach((f) => (h += `<div class="muted">${esc(f.name)} [${esc(f.id)}]: ${f.count} ${f.away ? 'away from Torn' : 'members fetched'}</div>`));
    const rows = Object.entries(state).filter(([id, r]) => !id.startsWith('_') && String(r.rawState).toLowerCase() !== 'okay');
    h += `<table>`;
    h += rows.length
      ? rows.map(([id, r]) => `<tr><td>${flag(r.country, 14)} <a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank">${esc(r.name)}</a><br><span class="muted">${esc(r.rawState)}: ${esc(r.rawDesc)}</span></td><td style="text-align:right">${esc(r.kind)}${r.country ? `<br>${esc(r.country)}` : ''}</td></tr>`).join('')
      : `<tr><td class="muted">Every watched enemy is Okay in Torn</td></tr>`;
    h += `</table></div>`;
    return h;
  }

  // Faction mates in, or flying to, a country with enemies in it or on the way. Needs the server.
  function matesInDanger(meta, board, t) {
    const out = [];
    for (const f of meta.friends || []) {
      if (String(f.player_id) === String(meta.myId)) continue;
      if (f.kind !== 'out' && f.kind !== 'there') continue;
      const b = board[f.country];
      if (!b || !b.risky) continue;
      out.push({ f, b });
    }
    // Most urgent first: already there, then by landing time.
    out.sort((a, z) => (a.f.kind === 'there' ? 0 : a.f.eta || 9e9) - (z.f.kind === 'there' ? 0 : z.f.eta || 9e9));
    return out;
  }
  function warningText(f, b, t) {
    const when =
      f.kind === 'there' ? `You're in ${f.country} now`
      : f.eta ? `You land in ${f.country} in about ${fmt(f.eta - t)}`
      : `You're flying to ${f.country}`;
    // Name each enemy with its FFScouter estimate; cap the list so the message stays readable.
    const who = ([id, r]) => {
      const est = statsLabel(id);
      return `${r.name}${est ? ` (${est})` : ''}`;
    };
    const lines = [];
    const there = [...b.there, ...b.hosp];
    if (there.length) {
      lines.push(`In ${f.country} now: ${there.slice(0, 6).map(([id, r]) => `${who([id, r])}${r.hosp ? ' in hospital' : ''}`).join(', ')}${there.length > 6 ? ` and ${there.length - 6} more` : ''}.`);
    }
    if (b.inbound.length) {
      lines.push(`On the way: ${b.inbound.slice(0, 6).map(([id, r]) => `${who([id, r])}${r.eta ? `, lands in about ${fmt(r.eta - t)}` : ''}`).join('; ')}${b.inbound.length > 6 ? `; and ${b.inbound.length - 6} more` : ''}.`);
    }
    return `Heads up from Flight Watch: ${f.country} is risky. ${lines.join(' ')} ${when}. Stay safe!`;
  }
  // Copy the warning, then open Torn's message composer for that player. The human presses send:
  // Torn's rules don't allow scripts to send messages on their own.
  function copyText(text) {
    const bridge = window.flutter_inappwebview;
    if (IS_PDA && bridge && typeof bridge.callHandler === 'function') return Promise.resolve(bridge.callHandler('copyToClipboard', text));
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function render() {
    if (panel.style.display !== 'block') return;
    const state = getState();
    const meta = getMeta();
    const cfg = getCfg();
    const t = now();
    const multi = (meta.enemies || []).length > 1;

    let html = `<div class="hd"><b>Flight Watch <span class="muted" style="font-weight:normal;font-size:11px">v${VERSION}</span></b><a href="#" id="ukw-gear">${showSettings ? 'Close' : 'Settings'}</a></div>`;
    html += `<div class="sub">`;
    if (meta.enemies && meta.enemies.length) {
      const list = meta.enemies.map((e) => {
        const when = e.start && e.start > t ? `, starts in ${fmt(e.start - t)}` : '';
        return `<a href="https://www.torn.com/factions.php?step=profile&ID=${esc(e.id)}" target="_blank">${esc(e.name)}</a>${e.type !== 'manual' ? ` (${e.type}${when})` : ''}`;
      }).join(', ');
      html += `Watching ${list}`;
    } else if (meta.warNote && cfg.enemyMode === 'auto') {
      html += esc(meta.warNote);
    }
    if (meta.myLoc) html += `<br>${meta.myDest ? `${flag(meta.myDest, 14)} ` : ''}${esc(meta.myLoc)}`;
    html += `</div>`;
    if (dupeOnPage) html += `<div class="sec err">Flight Watch is installed more than once. Remove the extra copies (in PDA: Settings > Userscripts) and keep only the one from GitHub.</div>`;
    if (!cfg.apiKey) html += `<div class="sec err">Add an API key in Settings.</div>`;
    else if (cfg.enemyMode === 'manual' && !cfg.factionId) html += `<div class="sec err">Add a faction ID in Settings, or switch Enemy to auto.</div>`;
    if (lastError) html += `<div class="sec err">${esc(lastError)}</div>`;

    if (showSettings) {
      html += renderSettings();
    } else if (showDebug) {
      html += renderDebug(state, meta, t);
    } else {
      const board = countryBoard(state, t);
      // Risky countries first: yours on top, then soonest enemy landing / most enemies.
      const risky = COUNTRIES.filter((c) => board[c].risky).sort((a, z) => {
        if (a === meta.myDest) return -1;
        if (z === meta.myDest) return 1;
        const ba = board[a], bz = board[z];
        const sa = ba.there.length * 100 + ba.inbound.length, sz = bz.there.length * 100 + bz.inbound.length;
        return sz - sa;
      });
      const safe = COUNTRIES.filter((c) => !board[c].risky);

      // Faction mates in danger.
      if (cfg.showMates) {
        const mates = matesInDanger(meta, board, t);
        if (mates.length) {
          html += `<div class="sec"><h4>Faction mates at risk (${mates.length})</h4>`;
          mates.forEach(({ f }, i) => {
            const where =
              f.kind === 'there' ? `in ${esc(f.country)}`
              : `flying to ${esc(f.country)}${f.eta ? `, lands ~${fmt(f.eta - t)}` : ''}`;
            html += `<div class="mate">${flag(f.country)}<div class="info"><a href="https://www.torn.com/profiles.php?XID=${esc(f.player_id)}" target="_blank">${esc(f.name)}</a> <span class="muted">${esc(f.level)}</span><br><span class="muted">${where}</span></div><button data-warn="${i}">Warn</button></div>`;
          });
          html += `</div>`;
        } else if (!meta.friends) {
          html += `<div class="sec muted">Faction mate warnings need the Flight Watch server.</div>`;
        }
      }

      html += `<div class="sec"><h4>Risky (${risky.length})</h4>`;
      if (!risky.length) html += `<div class="muted">No enemies abroad or flying right now.</div>`;
      for (const c of risky) {
        const b = board[c];
        const me = meta.myDest === c;
        const chips = [];
        if (b.there.length) chips.push(`<span class="chip there">${b.there.length} there</span>`);
        if (b.hosp.length) chips.push(`<span class="chip hosp">${b.hosp.length} in hosp</span>`);
        if (b.inbound.length) chips.push(`<span class="chip in">${b.inbound.length} inbound${b.next !== null ? ` · next ${fmt(b.next)}` : ''}</span>`);
        html += `<div class="card${me ? ' me' : ''}"><div class="top" data-c="${esc(c)}">${flag(c)}<span class="name">${esc(c)}${me ? ' <span class="muted">(you)</span>' : ''}</span><span class="muted">${expanded.has(c) || me ? '▾' : '▸'}</span></div><div class="chips">${chips.join('')}</div>`;
        if (expanded.has(c) || me) {
          html += `<div class="people"><table>${[...b.there, ...b.hosp, ...b.inbound].map(([id, r]) => memberRow(id, r, t, multi)).join('')}</table></div>`;
        }
        html += `</div>`;
      }
      const canFly = !meta.myKind || meta.myKind === 'torn';
      html += `</div><div class="sec"><h4>Safe (${safe.length}) <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:normal">${canFly ? 'tap to fly' : ''}</span></h4><div class="safe">${safe.map((c) => `<span class="${meta.myDest === c ? 'me' : ''}${canFly ? ' go' : ''}" data-fly="${esc(c)}" title="${canFly ? `Open the travel agency with ${esc(c)} selected` : esc(c)}">${flag(c, 14)}${esc(DESTS[c].code)}</span>`).join('')}</div></div>`;
    }
    if (!showSettings) {
      html += `<div class="ft"><a href="#" id="ukw-refresh">Refresh now</a><a href="#" id="ukw-debug">${showDebug ? 'Back to countries' : 'Raw statuses'}</a></div>`;
    }
    panel.innerHTML = html;

    const dbg = panel.querySelector('#ukw-debug');
    if (dbg) dbg.onclick = (e) => { e.preventDefault(); showDebug = !showDebug; render(); };
    const rf = panel.querySelector('#ukw-refresh');
    if (rf) rf.onclick = (e) => { e.preventDefault(); lastPoll = 0; forceWarCheck = true; store.set('ukw_leader', null); };

    panel.querySelector('#ukw-gear').onclick = (e) => {
      e.preventDefault();
      showSettings = !showSettings;
      render();
    };
    panel.querySelectorAll('[data-c]').forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('a')) return;
        const c = el.dataset.c;
        expanded.has(c) ? expanded.delete(c) : expanded.add(c);
        render();
      };
    });
    panel.querySelectorAll('[data-fly]').forEach((el) => {
      el.onclick = () => bookFlight(el.dataset.fly, meta);
    });
    if (!showSettings && !showDebug && cfg.showMates) {
      const mates = matesInDanger(meta, countryBoard(state, t), t);
      panel.querySelectorAll('[data-warn]').forEach((b) => {
        b.onclick = () => {
          const m = mates[Number(b.dataset.warn)];
          if (!m) return;
          const text = warningText(m.f, m.b, now());
          const subject = `Flight Watch: ${m.f.country} is risky`;
          // Hand the message to the compose page, which fills it in (see prefillCompose). Saved to
          // storage for the new tab, and in the link as a fallback in case storage isn't shared.
          const pending = { xid: String(m.f.player_id), subject, body: text, ts: now() };
          store.set('fw_pending', pending);
          if (native) flushNow();
          const hash = `#/p=compose&XID=${encodeURIComponent(m.f.player_id)}&fwmsg=${encodeURIComponent(JSON.stringify({ s: subject, b: text, ts: pending.ts }))}`;
          const go = () => window.open(`https://www.torn.com/messages.php${hash}`, '_blank');
          // Copy as well, so pasting still works if Torn's page changes and the fill-in can't find the boxes.
          copyText(text).catch(() => {}).finally(go);
        };
      });
    }
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
      btn.innerHTML = `${flag(meta.myDest, 16)}${esc(DESTS[meta.myDest].code)}${n ? `<span class="n">${n}</span>` : ''}`;
    } else {
      const risky = COUNTRIES.filter((c) => board[c].risky).length;
      const mates = getCfg().showMates ? matesInDanger(meta, board, now()).length : 0;
      btn.innerHTML = `Fly${risky ? `<span class="n" title="Risky countries">${risky}</span>` : ''}${mates ? `<span class="w" title="Faction mates at risk">${mates}</span>` : ''}`;
    }
  }

  // ---------- Book a flight ----------
  // Tapping a safe country opens Torn's travel agency and selects that destination. The user still
  // picks the ticket and presses Continue / Travel: the script never confirms a flight.
  // Selectors come from Torn's current travel page (page.php?sid=travel): a destination list of
  // buttons with aria-controls="travel-country-..." on mobile, and radio inputs named
  // "destination" on the desktop world map. Both carry the country or city name.
  const TRAVEL_URL = 'https://www.torn.com/page.php?sid=travel';
  const onTravelPage = () => /sid=travel|travelagency\.php/.test(location.href);
  function bookFlight(country, meta) {
    if (meta && meta.myKind && meta.myKind !== 'torn') {
      toast('You need to be back in Torn to book a flight.');
      return;
    }
    store.set('fw_travel', { country, ts: now() });
    if (native) flushNow();
    if (onTravelPage()) selectDestination();
    else location.href = TRAVEL_URL;
  }
  const destTerms = (c) => {
    const d = DESTS[c];
    const t = [c.toLowerCase(), d.city.toLowerCase()];
    if (c === 'UAE') t.push('united arab emirates', 'uae');
    if (c === 'Cayman Islands') t.push('cayman');
    return t;
  };
  const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
  function findDestinationControl(country) {
    const terms = destTerms(country);
    const matches = (txt) => terms.some((term) => txt.includes(term));
    // Mobile list.
    const listBtns = document.querySelectorAll('[class*="destinationList"] button[aria-controls^="travel-country-"], button[aria-controls^="travel-country-"]');
    for (const b of listBtns) {
      if (matches(norm(`${b.textContent} ${b.getAttribute('aria-label')} ${b.getAttribute('aria-controls')}`))) return b;
    }
    // Desktop map.
    const radios = document.querySelectorAll('input[type="radio"][name="destination"], [class*="worldMap"] input[type="radio"]');
    for (const r of radios) {
      const label = r.closest('label');
      if (matches(norm(`${r.getAttribute('aria-label')} ${r.value} ${label ? label.textContent : ''} ${label ? label.getAttribute('aria-label') : ''}`))) return r;
    }
    return null;
  }
  const realClick = (el) => {
    for (const type of ['pointerdown', 'mousedown']) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true })); } catch (e) {}
    }
    el.click();
    for (const type of ['mouseup', 'pointerup']) {
      try { el.dispatchEvent(new MouseEvent(type, { bubbles: true })); } catch (e) {}
    }
  };
  let selecting = false;
  function selectDestination() {
    if (selecting || !onTravelPage()) return;
    const p = store.get('fw_travel', null);
    if (!p || !DESTS[p.country] || now() - (p.ts || 0) > 180) return;
    selecting = true;
    const started = Date.now();
    const timer = setInterval(() => {
      const ctl = findDestinationControl(p.country);
      if (ctl) {
        clearInterval(timer);
        selecting = false;
        store.set('fw_travel', null);
        if (native) flushNow();
        // Expanding an already open list row would close it again.
        const open = ctl.getAttribute('aria-expanded') === 'true' || ctl.checked === true;
        if (!open) realClick(ctl);
        try { (ctl.closest('label') || ctl).scrollIntoView({ block: 'center' }); } catch (e) {}
        toast(`${p.country} selected. Choose your ticket, then press Continue and Travel yourself.`);
      } else if (Date.now() - started > 15000) {
        clearInterval(timer);
        selecting = false;
        store.set('fw_travel', null);
        toast(`Couldn't find ${p.country} on the travel page. Pick it yourself.`);
      }
    }, 300);
  }

  // ---------- Compose prefill ----------
  // On Torn's compose page, fill in a warning queued by the Warn button. The user reads it and
  // presses Send themselves: Torn's rules don't allow scripts to send messages.
  function readPending() {
    let p = store.get('fw_pending', null);
    const m = location.hash.match(/[&?]fwmsg=([^&]+)/);
    if (m) {
      try {
        const h = JSON.parse(decodeURIComponent(m[1]));
        const xid = (location.hash.match(/XID=(\d+)/) || [])[1];
        if (!p || (h.ts || 0) >= (p.ts || 0)) p = { xid, subject: h.s, body: h.b, ts: h.ts };
      } catch (e) {}
    }
    return p;
  }
  // React and similar frameworks ignore plain .value writes; use the native setter plus events.
  function setFieldValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    setter && setter.set ? setter.set.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setEditable(el, text) {
    const doc = el.ownerDocument;
    el.focus();
    try {
      doc.execCommand('selectAll', false, null);
      if (doc.execCommand('insertText', false, text)) return true;
    } catch (e) {}
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  }
  const visible = (el) => !!el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  function findSubject() {
    const sel = 'input[name="subject"], input#subject, input[name*="subject" i], input[placeholder*="subject" i], input[aria-label*="subject" i]';
    return [...document.querySelectorAll(sel)].find(visible) || null;
  }
  // Only ever look inside Torn's "Send a Message" box: the container that holds both the subject
  // field and a Send button. An earlier version fell back to the whole page and wrote into the
  // sidebar Notes box, because the subject field appears before the message editor has loaded.
  const isEmpty = (b) => (b.kind === 'textarea' ? !b.el.value.trim() : !(b.el.textContent || '').trim());
  const offLimits = (el) => !!el.closest('[class*="chat" i], [id*="chat" i], [class*="sidebar" i], [id*="sidebar" i], [class*="notes" i], [id*="notes" i], #ukw-panel');
  function composeRoot(subj) {
    if (!subj) return null;
    let node = subj.parentElement;
    for (let i = 0; node && i < 10; i++, node = node.parentElement) {
      if (node === document.body) return null;
      const send = [...node.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')].find(
        (b) => /^\s*send\s*$/i.test(b.textContent || b.value || '')
      );
      if (send) return node;
    }
    return null;
  }
  function editorIn(root) {
    for (const f of root.querySelectorAll('iframe')) {
      try {
        const b = f.contentDocument && f.contentDocument.body;
        if (b && (b.isContentEditable || f.contentDocument.designMode === 'on') && visible(f)) return { el: b, kind: 'editable' };
      } catch (e) {}
    }
    const ce = [...root.querySelectorAll('[contenteditable="true"], [contenteditable=""]')].find((x) => visible(x) && !offLimits(x));
    if (ce) return { el: ce, kind: 'editable' };
    const ta = [...root.querySelectorAll('textarea')].find((x) => visible(x) && !offLimits(x));
    if (ta) return { el: ta, kind: 'textarea' };
    return null;
  }
  function findBody(subj) {
    const root = composeRoot(subj);
    return root ? editorIn(root) : null; // no compose box yet: keep waiting, never search the page
  }
  let prefillRunning = false;
  function prefillCompose() {
    if (prefillRunning || !/messages\.php/.test(location.pathname) || !/p=compose/.test(location.hash)) return;
    const p = readPending();
    if (!p || now() - (p.ts || 0) > 300) return; // only warnings queued in the last 5 minutes
    const xid = (location.hash.match(/XID=(\d+)/) || [])[1];
    if (p.xid && xid && String(p.xid) !== String(xid)) return;
    prefillRunning = true;
    const started = Date.now();
    const timer = setInterval(() => {
      const subj = findSubject();
      const body = findBody(subj);
      if (body) {
        clearInterval(timer);
        if (subj && p.subject && !subj.value) setFieldValue(subj, p.subject);
        // Never overwrite something the user has already typed.
        if (!isEmpty(body)) {
          prefillRunning = false;
          toast('The message box already has text, so Flight Watch left it alone. The warning is on your clipboard.');
          return;
        }
        if (body.kind === 'textarea') setFieldValue(body.el, p.body);
        else setEditable(body.el, p.body);
        store.set('fw_pending', null);
        if (native) flushNow();
        prefillRunning = false;
        toast('Warning written in. Check it, then press Send.');
      } else if (Date.now() - started > 15000) {
        clearInterval(timer);
        prefillRunning = false;
        toast("Couldn't find the message box. The warning is on your clipboard: paste it in and send.");
      }
    }, 300);
  }

  // ---------- Start ----------
  // In Torn PDA with native storage: load it once, carry over settings from the old localStorage
  // copy on the first run, then delete our old localStorage keys to give that space back.
  const OLD_KEYS = ['ukw_cfg', 'fw_state', 'fw_meta', 'fw_srv'];
  async function boot() {
    if (!IS_PDA || typeof PDA_storage === 'undefined' || !PDA_storage || typeof PDA_storage.loadAll !== 'function') return;
    try {
      const all = (await PDA_storage.loadAll()) || {};
      if (!('ukw_cfg' in all)) {
        try {
          const old = localStorage.getItem('fw:ukw_cfg');
          if (old) {
            all.ukw_cfg = JSON.parse(old);
            await PDA_storage.set('ukw_cfg', all.ukw_cfg);
          }
        } catch (e) {}
      }
      native = all;
      for (const k of OLD_KEYS) {
        try { localStorage.removeItem(`fw:${k}`); } catch (e) {}
      }
    } catch (e) {
      storeError = `PDA storage: ${(e && (e.code || e.message)) || 'load failed'}, using localStorage`;
    }
  }

  boot().then(() => {
    prefillCompose();
    selectDestination();
    window.addEventListener('hashchange', prefillCompose);
    setInterval(() => {
      if (amLeader()) poll();
      updateBadge();
      if (!showSettings) render();
    }, 1000);
    updateBadge();
  });

  if (window.Notification && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch (e) {}
  }
})();
