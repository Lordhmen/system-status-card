/*
 * system-status-card — сводка состояния системы для Home Assistant.
 *
 * Одна карточка из секций:
 *   tiles   — плитки «название / значение / пояснение» с цветом по порогам (версии, аптайм, бэкап, температура…);
 *   meters  — шкалы-полоски (CPU, RAM, диск, флеш роутера);
 *   addons  — аддоны (приложения) Supervisor: состояние, версия, CPU/RAM, перезапуск, обновление;
 *   updates — все доступные обновления (update.*) одним списком;
 *   table   — небольшая таблица сущностей (например, параметры эфира 2.4 / 5 ГГц);
 *   buttons — кнопки действий с подтверждением (перезагрузка роутера, бэкап, Speedtest).
 *
 * Стиль общий с devices-table-card. Тема HA (тёмная и светлая), один файл без зависимостей.
 *
 * https://github.com/Lordhmen/system-status-card
 * Лицензия: MIT. История изменений — CHANGELOG.md.
 */
const SSC_VERSION = "0.1.4";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function globRe(g) {
  return new RegExp("^" + String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

const NA = new Set(["unavailable", "unknown", "", undefined, null]);

// Секунды -> «3 д 4 ч», «11 ч 44 мин», «25 мин»
function fmtDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} д${h ? ` ${h} ч` : ""}`;
  if (h) return `${h} ч${m ? ` ${m} мин` : ""}`;
  if (m) return `${m} мин`;
  return "< 1 мин";
}

// Длительность в секундах из значения с единицей HA
function toSeconds(v, unit) {
  const n = Number(v);
  if (!isFinite(n)) return NaN;
  switch (String(unit || "s").toLowerCase()) {
    case "ms": return n / 1000;
    case "min": return n * 60;
    case "h": return n * 3600;
    case "d": return n * 86400;
    default: return n;
  }
}

// «6 ч назад» / «через 17 ч»
function relWords(ms, now = Date.now()) {
  const diff = (ms - now) / 1000;
  const a = Math.abs(diff);
  if (a < 60) return "только что";
  // грубо: «2 д 8 ч», «6 ч», «25 мин» — чтобы влезало в плитку
  const t = a >= 86400 ? fmtDur(a) : a >= 3600 ? `${Math.floor(a / 3600)} ч` : fmtDur(a);
  return diff < 0 ? `${t} назад` : `через ${t}`;
}

function fmtNum(n, decimals) {
  if (!isFinite(n)) return "—";
  const d = decimals ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n);
}

function fmtBytes(b) {
  if (!isFinite(b)) return "—";
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${fmtNum(b, i >= 3 ? 1 : 0)} ${u[i]}`;
}

// ok | warn | bad по порогам; below: true — плохо, когда значение НИЖЕ порога
function level(v, warn, bad, below) {
  if (!isFinite(v)) return "";
  const hit = (t) => t !== undefined && t !== null && (below ? v <= t : v >= t);
  if (hit(bad)) return "bad";
  if (hit(warn)) return "warn";
  return warn !== undefined || bad !== undefined ? "ok" : "";
}

const SECTION_TYPES = ["tiles", "meters", "addons", "updates", "table", "buttons"];

const PLATFORM_KIND = {
  hassio: "Система", hacs: "HACS", mqtt: "Zigbee", esphome: "ESPHome", wled: "WLED", zha: "Zigbee", matter: "Matter",
};

class SystemStatusCard extends HTMLElement {
  static getStubConfig() {
    return {
      title: "Система",
      sections: [
        { type: "tiles", items: [{ entity: "update.home_assistant_core_update", name: "Core" }] },
        { type: "addons" },
        { type: "updates" },
      ],
    };
  }

  setConfig(config) {
    if (!config) throw new Error("No configuration.");
    const sections = config.sections || [];
    if (!Array.isArray(sections) || !sections.length) throw new Error("sections: укажите хотя бы одну секцию");
    for (const s of sections) {
      if (!SECTION_TYPES.includes(s.type)) throw new Error(`Unknown section type "${s.type}" (${SECTION_TYPES.join(" | ")})`);
      if ((s.type === "tiles" || s.type === "meters" || s.type === "buttons") && !Array.isArray(s.items)) throw new Error(`${s.type}: нужен список items`);
      if (s.type === "table" && (!Array.isArray(s.rows) || !Array.isArray(s.columns))) throw new Error("table: нужны columns и rows");
    }
    this._config = { actions: true, ...config, sections };
    this._html = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._renderShell();
    if (this._hass) this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first && this._wantsAddons()) this._loadAddons();
    this._render();
  }

  connectedCallback() {
    if (!this._timer) {
      this._timer = setInterval(() => {
        this._tick = (this._tick || 0) + 1;
        if (this._wantsAddons() && this._tick % 2 === 0) this._loadAddons();
        this._render();
      }, 30000);
    }
  }
  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    return 2 + this._config.sections.length * 2;
  }
  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  get _admin() {
    return !!this._hass?.user?.is_admin;
  }

  get _tz() {
    return this._config.time_zone || this._hass?.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  _fmtDate(ms, withDay = true) {
    if (!ms) return "";
    try {
      const o = { timeZone: this._tz, hour: "2-digit", minute: "2-digit" };
      if (withDay) { o.day = "2-digit"; o.month = "2-digit"; }
      return new Intl.DateTimeFormat("ru-RU", o).format(new Date(ms)).replace(",", "");
    } catch (_) {
      return new Date(ms).toLocaleString();
    }
  }

  // ---------- данные: аддоны ----------

  _wantsAddons() {
    return this._config.sections.some((s) => s.type === "addons");
  }

  async _loadAddons() {
    const h = this._hass;
    if (!h || !this._admin || typeof h.callWS !== "function" || this._addonsBusy) return;
    this._addonsBusy = true;
    try {
      const r = await h.callWS({ type: "supervisor/api", endpoint: "/addons", method: "get" });
      const list = (r?.addons || r || []).filter((a) => a && a.slug);
      const sec = this._config.sections.find((s) => s.type === "addons") || {};
      if (sec.stats !== false) {
        await Promise.all(list.filter((a) => a.state === "started").map(async (a) => {
          try {
            a._stats = await h.callWS({ type: "supervisor/api", endpoint: `/addons/${a.slug}/stats`, method: "get" });
          } catch (_) { /* статистика необязательна */ }
        }));
      }
      this._addons = list;
      this._addonsErr = null;
    } catch (e) {
      this._addonsErr = e?.message || String(e);
    } finally {
      this._addonsBusy = false;
      this._render();
    }
  }

  // Аддоны из сущностей (если нет прав администратора или Supervisor API недоступен)
  _addonsFromEntities() {
    const h = this._hass;
    const out = [];
    for (const d of Object.values(h.devices || {})) {
      const idf = (d.identifiers || []).find((i) => i[0] === "hassio");
      if (!idf || !/App|Add-?on/i.test(d.model || "")) continue;
      const ents = Object.values(h.entities || {}).filter((e) => e.device_id === d.id);
      const run = ents.find((e) => e.entity_id.startsWith("binary_sensor.") && /_running$/.test(e.entity_id));
      const upd = ents.find((e) => e.entity_id.startsWith("update."));
      const us = upd && h.states[upd.entity_id];
      const rs = run && h.states[run.entity_id];
      out.push({
        slug: idf[1],
        name: d.name_by_user || d.name,
        state: rs ? (rs.state === "on" ? "started" : "stopped") : "unknown",
        version: us?.attributes?.installed_version || d.sw_version || "",
        version_latest: us?.attributes?.latest_version || "",
        update_available: us?.state === "on",
        icon: false,
      });
    }
    return out;
  }

  _addonUpdateEntity(slug) {
    const h = this._hass;
    const dev = Object.values(h.devices || {}).find((d) => (d.identifiers || []).some((i) => i[0] === "hassio" && i[1] === slug));
    if (!dev) return null;
    const e = Object.values(h.entities || {}).find((x) => x.device_id === dev.id && x.entity_id.startsWith("update."));
    return e?.entity_id || null;
  }

  // ---------- значения ----------

  _st(id) {
    return id ? this._hass.states[id] : undefined;
  }

  _fmtState(st, item = {}) {
    if (!st) return "—";
    const raw = item.attribute ? st.attributes?.[item.attribute] : st.state;
    if (NA.has(raw)) return "—";
    const n = Number(raw);
    if (item.decimals !== undefined || item.factor !== undefined || item.unit !== undefined) {
      if (isFinite(n) && raw !== "" && raw !== true && raw !== false) {
        const v = n * (item.factor ?? 1);
        const unit = item.unit ?? (item.attribute ? "" : st.attributes?.unit_of_measurement || "");
        return `${fmtNum(v, item.decimals)}${unit ? ` ${unit}` : ""}`;
      }
    }
    if (!item.attribute && typeof this._hass.formatEntityState === "function") {
      try { return this._hass.formatEntityState(st); } catch (_) { /* старые версии HA */ }
    }
    if (isFinite(n) && raw !== "") {
      const unit = item.attribute ? "" : st.attributes?.unit_of_measurement || "";
      return `${fmtNum(n, item.decimals)}${unit ? ` ${unit}` : ""}`;
    }
    return String(raw);
  }

  // Вторая строка: время (timestamp) — «35 мин назад», остальное — как состояние
  _fmtSecondary(id, decimals) {
    const st = this._st(id);
    if (st && st.attributes?.device_class === "timestamp" && !NA.has(st.state)) {
      const ms = Date.parse(st.state);
      if (ms) return relWords(ms);
    }
    return this._fmtState(st, { decimals });
  }

  _num(st, item = {}) {
    if (!st) return NaN;
    const raw = item.attribute ? st.attributes?.[item.attribute] : st.state;
    if (NA.has(raw)) return NaN;
    const n = Number(raw);
    return isFinite(n) ? n * (item.factor ?? 1) : NaN;
  }

  // Плитка -> {value, sub, lvl, icon, entity}
  _tile(it) {
    const st = this._st(it.entity);
    const out = { name: it.name, icon: it.icon, value: "—", sub: "", lvl: "", entity: it.entity };
    if (it.entity && !st) { out.sub = "нет сущности"; out.lvl = "na"; return out; }
    if (!it.entity) { out.value = it.value ?? ""; out.sub = it.sub ?? ""; return out; }
    const a = st.attributes || {};
    const domain = it.entity.split(".")[0];
    out.name = out.name ?? a.friendly_name ?? it.entity;
    if (NA.has(st.state) && domain !== "update") {
      out.value = "—"; out.sub = "недоступно"; out.lvl = "na";
      out.icon = out.icon || a.icon || "mdi:help-circle-outline";
      return out;
    }
    const fmt = it.format || (domain === "update" ? "version" : domain === "binary_sensor" ? "binary" : "");
    switch (fmt) {
      case "version": {
        out.value = a.installed_version || "—";
        if (st.state === "on") { out.sub = `доступна ${a.latest_version}`; out.lvl = "warn"; }
        else if (a.in_progress) { out.sub = "обновляется…"; out.lvl = "warn"; }
        else { out.sub = "актуальная"; out.lvl = "ok"; }
        out.icon = out.icon || "mdi:package-up";
        break;
      }
      case "binary": {
        // ok_state — «хорошее» значение: "on" для состояния, true для атрибута (можно false: «перезагрузка не нужна»)
        const val = it.attribute ? a[it.attribute] : st.state;
        const on = String(val) === String(it.ok_state ?? (it.attribute ? true : "on"));
        out.value = on ? (it.on_text ?? "OK") : (it.off_text ?? "нет");
        out.lvl = on ? "ok" : (it.fail_level || "bad");
        break;
      }
      case "ago":
      case "in":
      case "since": {
        const ms = Date.parse(it.attribute ? a[it.attribute] : st.state);
        if (!ms) { out.value = "—"; break; }
        if (fmt === "since") {
          out.value = fmtDur((Date.now() - ms) / 1000);
          out.sub = it.sub ?? `с ${this._fmtDate(ms)}`;
        } else {
          out.value = relWords(ms);
          out.sub = it.sub ?? this._fmtDate(ms);
        }
        if (fmt === "ago") {
          const hrs = (Date.now() - ms) / 3600000;
          out.lvl = level(hrs, it.warn_after, it.bad_after);
        }
        break;
      }
      case "duration": {
        const s = toSeconds(it.attribute ? a[it.attribute] : st.state, it.unit || a.unit_of_measurement);
        out.value = isFinite(s) ? fmtDur(s) : "—";
        break;
      }
      default: {
        out.value = this._fmtState(st, it);
        out.lvl = level(this._num(st, it), it.warn, it.bad, it.below);
      }
    }
    if (it.secondary_attribute) {
      const v2 = a[it.secondary_attribute];
      out.sub = (it.secondary_prefix ? it.secondary_prefix + " " : "") + (NA.has(v2) ? "—" : String(v2));
    } else if (it.secondary) {
      out.sub = (it.secondary_prefix ? it.secondary_prefix + " " : "") + this._fmtSecondary(it.secondary, it.secondary_decimals);
    } else if (it.sub !== undefined && !["ago", "in", "since"].includes(fmt)) out.sub = it.sub;
    out.icon = out.icon || a.icon || "";
    return out;
  }

  _meter(it) {
    const st = this._st(it.entity);
    let v = this._num(st, it);
    let max = typeof it.max === "string" ? this._num(this._st(it.max)) : (it.max ?? 100);
    if (it.free && isFinite(max)) v = max - v;
    const pct = isFinite(v) && isFinite(max) && max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : NaN;
    const lvl = level(pct, it.warn ?? 75, it.bad ?? 90);
    let text = isFinite(pct) ? `${fmtNum(pct, pct < 10 ? 1 : 0)} %` : "—";
    let sub = "";
    if (it.secondary) sub = (it.secondary_prefix ? it.secondary_prefix + " " : "") + this._fmtSecondary(it.secondary, it.secondary_decimals);
    else if (typeof it.max === "string" && isFinite(v)) {
      const unit = it.unit ?? st?.attributes?.unit_of_measurement ?? "";
      sub = `${fmtNum(v, it.decimals ?? 1)} из ${fmtNum(max, it.decimals ?? 1)} ${unit}`.trim();
    }
    return { name: it.name ?? st?.attributes?.friendly_name ?? it.entity, icon: it.icon || st?.attributes?.icon || "", pct, text, sub, lvl, entity: it.entity };
  }

  // ---------- отрисовка ----------

  _renderShell() {
    const c = this._config;
    this.shadowRoot.innerHTML = `
      <style>
        :host { --ssc-line: rgba(127,127,127,.35); --ssc-row-line: rgba(127,127,127,.15); --ssc-hover: rgba(127,127,127,.08);
          --ssc-ok: var(--success-color, #4caf50); --ssc-bad: var(--error-color, #f44336); --ssc-warn: var(--warning-color, #ff9800);
          --ssc-na: var(--disabled-text-color, #888); --ssc-accent: var(--primary-color, #03a9f4); --ssc-track: rgba(127,127,127,.18); }
        @supports (color: color-mix(in srgb, red, blue)) {
          :host {
            --ssc-line: color-mix(in srgb, var(--primary-text-color, #e1e1e1) 25%, transparent);
            --ssc-row-line: color-mix(in srgb, var(--primary-text-color, #e1e1e1) 10%, transparent);
            --ssc-hover: color-mix(in srgb, var(--primary-text-color, #e1e1e1) 6%, transparent);
            --ssc-track: color-mix(in srgb, var(--primary-text-color, #e1e1e1) 12%, transparent);
          }
        }
        ha-card { display: block; padding: 16px; container-type: inline-size; }
        .top { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
        .title { flex: 1; font-size: 1.15em; font-weight: 500; display: flex; align-items: center; gap: 8px; min-width: 0; }
        .title ha-icon { --mdc-icon-size: 22px; color: var(--secondary-text-color); }
        .top .note { font-size: .8em; color: var(--secondary-text-color); }
        .sec + .sec { margin-top: 16px; }
        .sh { display: flex; align-items: center; gap: 6px; font-size: .78em; font-weight: 500; letter-spacing: .04em; text-transform: uppercase;
          color: var(--secondary-text-color); margin: 0 0 8px; }
        .sh ha-icon { --mdc-icon-size: 16px; }
        .sh .cnt { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400; }
        /* плитки */
        .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--ssc-tile-min, 132px), 1fr)); gap: 8px; }
        .tile { position: relative; padding: 9px 12px 10px; border-radius: 10px; background: var(--ssc-hover); min-width: 0; cursor: pointer; overflow: hidden; }
        .tile:hover { background: color-mix(in srgb, var(--ssc-hover) 100%, var(--ssc-accent) 6%); }
        .tile::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 0 3px 3px 0; background: transparent; }
        .tile.ok::before { background: var(--ssc-ok); } .tile.warn::before { background: var(--ssc-warn); }
        .tile.bad::before { background: var(--ssc-bad); } .tile.na::before { background: var(--ssc-na); }
        .tile .k { display: flex; align-items: center; gap: 5px; font-size: .78em; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tile .k ha-icon { --mdc-icon-size: 15px; flex: none; }
        .tile .v { font-size: 1.2em; font-weight: 500; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tile .v.long { font-size: 1em; margin-top: 4px; }
        .tile.warn .v { color: var(--ssc-warn); } .tile.bad .v { color: var(--ssc-bad); } .tile.na .v { color: var(--ssc-na); }
        .tile .s { font-size: .75em; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
        .tile.warn .s { color: var(--ssc-warn); }
        .tile.open { outline: 1px solid var(--ssc-accent); }
        .lpanel { margin-top: 8px; padding: 10px 12px; border-radius: 10px; background: var(--ssc-hover); }
        .lhead { display: flex; align-items: center; gap: 8px; font-size: .85em; font-weight: 500; margin-bottom: 8px; }
        .lhead > span { flex: 1; }
        .lhead .cnt { color: var(--secondary-text-color); font-weight: 400; margin-left: 4px; }
        .lbtn { font: inherit; font-size: .9em; background: none; border: 1px solid var(--divider-color); color: var(--secondary-text-color); border-radius: 8px; padding: 2px 8px; cursor: pointer; }
        .lbtn:hover { color: var(--ssc-accent); border-color: var(--ssc-accent); }
        .chips { display: flex; flex-wrap: wrap; gap: 5px; }
        .lchip { font-size: .78em; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--divider-color); font-family: var(--code-font-family, monospace); }
        /* шкалы */
        .meters { display: grid; grid-template-columns: repeat(auto-fit, minmax(var(--ssc-meter-min, 200px), 1fr)); gap: 10px 18px; }
        .meter { cursor: pointer; min-width: 0; }
        .meter .row { display: flex; align-items: baseline; gap: 6px; font-size: .85em; }
        .meter .row ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text-color); align-self: center; }
        .meter .n { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .meter .p { font-weight: 500; font-variant-numeric: tabular-nums; }
        .meter.warn .p { color: var(--ssc-warn); } .meter.bad .p { color: var(--ssc-bad); }
        .track { height: 6px; border-radius: 3px; background: var(--ssc-track); margin: 5px 0 3px; overflow: hidden; }
        .fill { height: 100%; border-radius: 3px; background: var(--ssc-accent); transition: width .4s ease; }
        .meter.ok .fill { background: var(--ssc-ok); } .meter.warn .fill { background: var(--ssc-warn); } .meter.bad .fill { background: var(--ssc-bad); }
        .meter .sb { font-size: .72em; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1em; }
        /* таблицы */
        table { width: 100%; border-collapse: collapse; font-size: .9em; }
        th { text-align: left; font-weight: 500; font-size: .82em; color: var(--secondary-text-color); padding: 5px 8px; border-bottom: 1px solid var(--ssc-line); white-space: nowrap; }
        td { padding: 6px 8px; border-bottom: 1px solid var(--ssc-row-line); vertical-align: middle; }
        tr:last-child td { border-bottom: none; }
        tbody tr.cl { cursor: pointer; } tbody tr.cl:hover { background: var(--ssc-hover); }
        td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
        td.cell { cursor: pointer; } td.cell:hover { background: var(--ssc-hover); }
        td.warn { color: var(--ssc-warn); } td.bad { color: var(--ssc-bad); }
        .nm { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .nm img, .nm ha-icon { width: 22px; height: 22px; --mdc-icon-size: 20px; flex: none; border-radius: 5px; object-fit: contain; color: var(--secondary-text-color); }
        .nm .tx { min-width: 0; }
        .nm .sub { font-size: .78em; color: var(--secondary-text-color); display: none; }
        .st { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
        .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ssc-na); }
        .dot.ok { background: var(--ssc-ok); } .dot.bad { background: var(--ssc-bad); } .dot.warn { background: var(--ssc-warn); }
        .ver { white-space: nowrap; font-variant-numeric: tabular-nums; }
        .up { font-size: .75em; padding: 1px 6px; border-radius: 6px; margin-left: 6px; color: var(--ssc-warn); border: 1px solid currentColor; cursor: pointer; white-space: nowrap; background: none; font-family: inherit; }
        .kind { font-size: .75em; color: var(--secondary-text-color); white-space: nowrap; }
        .c-act { width: 1%; text-align: right; padding-right: 0; white-space: nowrap; }
        .act { background: none; border: none; cursor: pointer; color: var(--secondary-text-color); padding: 4px; border-radius: 6px; line-height: 0; opacity: .5; }
        tr:hover .act { opacity: 1; }
        .act:hover { color: var(--ssc-accent); background: var(--ssc-hover); }
        @media (hover: none) { .act { opacity: .85; } }
        .act ha-icon { --mdc-icon-size: 20px; }
        /* кнопки */
        .btns { display: flex; flex-wrap: wrap; gap: 8px; }
        .btn { font: inherit; font-size: .85em; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--primary-text-color);
          background: var(--ssc-hover); border: 1px solid var(--divider-color); border-radius: 10px; padding: 7px 12px; }
        .btn:hover { border-color: var(--ssc-accent); color: var(--ssc-accent); }
        .btn.danger:hover { border-color: var(--ssc-bad); color: var(--ssc-bad); }
        .btn ha-icon { --mdc-icon-size: 18px; }
        .btn[disabled] { opacity: .5; cursor: progress; }
        .msg { padding: 10px 4px; color: var(--secondary-text-color); font-size: .9em; display: flex; align-items: center; gap: 8px; }
        .msg.ok { color: var(--ssc-ok); }
        .msg ha-icon { --mdc-icon-size: 18px; }
        .tt-n { display: none; }
        @container (max-width: 520px) {
          .tt-w { display: none; } .tt-n { display: table; }
          .hide-s { display: none; }
          .nm .sub { display: block; }
        }
        @container (max-width: 400px) {
          .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          ha-card { padding: 12px; }
        }
      </style>
      <ha-card>
        ${c.title || c.icon ? `<div class="top"><div class="title">${c.icon ? `<ha-icon icon="${esc(c.icon)}"></ha-icon>` : ""}<span>${esc(c.title || "")}</span></div><span class="note" id="note"></span></div>` : ""}
        <div id="body"></div>
      </ha-card>`;
    const root = this.shadowRoot;
    root.getElementById("body").addEventListener("click", (e) => this._onClick(e));
  }

  _render() {
    if (!this._hass || !this.shadowRoot) return;
    const html = this._config.sections.map((s, i) => this._renderSection(s, i)).join("");
    if (html === this._html) return;
    this._html = html;
    this.shadowRoot.getElementById("body").innerHTML = html;
  }

  _secHead(s, extra = "") {
    if (!s.title) return extra ? `<div class="sh">${extra}</div>` : "";
    return `<div class="sh">${s.icon ? `<ha-icon icon="${esc(s.icon)}"></ha-icon>` : ""}<span>${esc(s.title)}</span>${extra}</div>`;
  }

  _renderSection(s, si) {
    let inner = "";
    switch (s.type) {
      case "tiles": inner = this._renderTiles(s, si); break;
      case "meters": inner = this._renderMeters(s, si); break;
      case "addons": return this._renderAddons(s, si);
      case "updates": return this._renderUpdates(s, si);
      case "table": inner = this._renderTable(s, si); break;
      case "buttons": inner = this._renderButtons(s, si); break;
    }
    return `<div class="sec">${this._secHead(s)}${inner}</div>`;
  }

  _renderTiles(s, si) {
    const style = s.min_width ? ` style="--ssc-tile-min:${Number(s.min_width)}px"` : "";
    let panel = "";
    const tiles = `<div class="tiles"${style}>` + s.items.map((it, i) => {
      const t = this._tile(it);
      const open = this._open === `${si}:${i}`;
      if (open) panel = this._renderList(it, si, i);
      return `<div class="tile ${t.lvl}${open ? " open" : ""}" data-s="${si}" data-i="${i}" title="${esc(t.name)}">
        <div class="k">${t.icon ? `<ha-icon icon="${esc(t.icon)}"></ha-icon>` : ""}<span>${esc(t.name)}</span></div>
        <div class="v${String(t.value).length > 11 ? " long" : ""}">${esc(t.value)}</div><div class="s">${esc(t.sub) || "&nbsp;"}</div></div>`;
    }).join("") + `</div>`;
    return tiles + panel;
  }

  // Раскрывающийся список из атрибута (tap_action: {action: list, attribute: packages})
  _renderList(it, si, i) {
    const t = it.tap_action || {};
    const st = this._st(t.entity || it.entity);
    let v = st?.attributes?.[t.attribute];
    let items = Array.isArray(v) ? v : String(v ?? "").split(t.separator || ",");
    items = items.map((x) => String(x).trim()).filter(Boolean);
    const title = t.title || it.name || "";
    const body = items.length
      ? `<div class="chips">${items.map((x) => `<span class="lchip">${esc(x)}</span>`).join("")}</div>`
      : `<div class="msg">${esc(t.empty_text || "Список пуст")}</div>`;
    return `<div class="lpanel"><div class="lhead"><span>${esc(title)}${items.length ? ` <span class="cnt">${items.length}</span>` : ""}</span>
      ${t.more_info !== false ? `<button class="lbtn" data-mi="${si}:${i}">Подробнее</button>` : ""}<button class="lbtn" data-close="1" aria-label="Закрыть">✕</button></div>${body}</div>`;
  }

  _renderMeters(s, si) {
    const style = s.min_width ? ` style="--ssc-meter-min:${Number(s.min_width)}px"` : "";
    return `<div class="meters"${style}>` + s.items.map((it, i) => {
      const m = this._meter(it);
      return `<div class="meter ${m.lvl}" data-s="${si}" data-i="${i}">
        <div class="row">${m.icon ? `<ha-icon icon="${esc(m.icon)}"></ha-icon>` : ""}<span class="n">${esc(m.name)}</span><span class="p">${esc(m.text)}</span></div>
        <div class="track"><div class="fill" style="width:${isFinite(m.pct) ? m.pct.toFixed(1) : 0}%"></div></div>
        <div class="sb">${esc(m.sub) || "&nbsp;"}</div></div>`;
    }).join("") + `</div>`;
  }

  _addonList(s) {
    let list = this._admin && this._addons ? this._addons : this._addonsFromEntities();
    const inc = (s.include || []).map(globRe);
    const exc = (s.exclude || []).map(globRe);
    const hit = (res, a) => res.some((re) => re.test(a.slug) || re.test(a.name));
    if (inc.length) list = list.filter((a) => hit(inc, a));
    if (exc.length) list = list.filter((a) => !hit(exc, a));
    if (s.show_stopped === false) list = list.filter((a) => a.state === "started");
    const rank = (a) => (a.update_available ? 0 : a.state === "started" ? 1 : 2);
    return list.slice().sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), "ru"));
  }

  _renderAddons(s, si) {
    const list = this._addonList(s);
    this._shownAddons = list;
    const running = list.filter((a) => a.state === "started").length;
    const updates = list.filter((a) => a.update_available).length;
    const loading = this._admin && !this._addons && !this._addonsErr;
    const cnt = `<span class="cnt">${loading ? "загрузка…" : `${running} из ${list.length} работают${updates ? ` · обновлений: ${updates}` : ""}`}</span>`;
    const head = this._secHead({ title: s.title ?? "Аддоны", icon: s.icon ?? "mdi:puzzle" }, cnt);
    if (!list.length) {
      const why = this._addonsErr ? `Supervisor: ${this._addonsErr}` : this._admin && !this._addons ? "Загрузка…" : "Аддонов не найдено";
      return `<div class="sec">${head}<div class="msg">${esc(why)}</div></div>`;
    }
    const stats = s.stats !== false && this._admin && list.some((a) => a._stats);
    const act = this._config.actions && this._admin;
    const rows = list.map((a, i) => {
      const on = a.state === "started";
      const stLbl = on ? "работает" : a.state === "stopped" ? "остановлен" : a.state === "error" ? "ошибка" : "нет данных";
      const dot = on ? "ok" : a.state === "unknown" ? "" : "bad";
      const icon = a.icon ? `<img src="/api/hassio/addons/${encodeURIComponent(a.slug)}/icon" alt="" loading="lazy">` : `<ha-icon icon="mdi:puzzle-outline"></ha-icon>`;
      const ver = `<span class="ver">${esc(a.version || "—")}</span>${a.update_available ? `<button class="up" data-up="${i}" title="Обновить до ${esc(a.version_latest)}">→ ${esc(a.version_latest)}</button>` : ""}`;
      const st = a._stats;
      const cpu = st ? `${fmtNum(st.cpu_percent, st.cpu_percent < 10 ? 1 : 0)} %` : "—";
      const ram = st ? fmtBytes(st.memory_usage) : "—";
      const btn = act ? (on
        ? `<button class="act" data-restart="${i}" title="Перезапустить" aria-label="Перезапустить"><ha-icon icon="mdi:restart"></ha-icon></button>`
        : `<button class="act" data-start="${i}" title="Запустить" aria-label="Запустить"><ha-icon icon="mdi:play"></ha-icon></button>`) : "";
      return `<tr class="cl" data-addon="${i}">
        <td><div class="nm">${icon}<div class="tx"><div>${esc(a.name)}</div><div class="sub">${esc(a.version || "")}${a.update_available ? ` → ${esc(a.version_latest)}` : ""}${stats && st ? ` · ${cpu} · ${ram}` : ""}</div></div></div></td>
        <td><span class="st"><span class="dot ${dot}"></span><span class="hide-s">${stLbl}</span></span></td>
        <td class="hide-s">${ver}</td>
        ${stats ? `<td class="num hide-s">${cpu}</td><td class="num hide-s">${ram}</td>` : ""}
        ${act ? `<td class="c-act">${btn}</td>` : ""}</tr>`;
    }).join("");
    return `<div class="sec">${head}<table><thead><tr><th>Аддон</th><th>Состояние</th><th class="hide-s">Версия</th>
      ${stats ? `<th class="num hide-s">CPU</th><th class="num hide-s">RAM</th>` : ""}${act ? `<th class="c-act"></th>` : ""}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  _updateList(s) {
    const h = this._hass;
    const inc = (s.include || []).map(globRe);
    const exc = (s.exclude || []).map(globRe);
    const excP = s.exclude_platforms || [];
    const all = Object.keys(h.states).filter((id) => id.startsWith("update."))
      .filter((id) => (!inc.length || inc.some((re) => re.test(id))) && !exc.some((re) => re.test(id)))
      .filter((id) => !excP.includes(h.entities?.[id]?.platform))
      .filter((id) => !h.entities?.[id]?.hidden);
    const pending = all.filter((id) => h.states[id].state === "on").map((id) => {
      const st = h.states[id];
      const a = st.attributes || {};
      const plat = h.entities?.[id]?.platform || "";
      const name = a.title || String(a.friendly_name || id).replace(/\s*(Обновление|Update|прошивки|firmware)\s*$/i, "");
      return { id, name, from: a.installed_version, to: a.latest_version, kind: PLATFORM_KIND[plat] || plat, pic: a.entity_picture, busy: !!a.in_progress };
    }).sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return { total: all.length, pending };
  }

  _renderUpdates(s, si) {
    const { total, pending } = this._updateList(s);
    this._shownUpdates = pending;
    const head = this._secHead({ title: s.title ?? "Обновления", icon: s.icon ?? "mdi:package-up" },
      `<span class="cnt">${pending.length ? `доступно ${pending.length}` : `проверено ${total}`}</span>`);
    if (!pending.length) return `<div class="sec">${head}<div class="msg ok"><ha-icon icon="mdi:check-circle-outline"></ha-icon>Всё обновлено</div></div>`;
    const rows = pending.map((u, i) => {
      const icon = u.pic ? `<img src="${esc(u.pic)}" alt="" loading="lazy">` : `<ha-icon icon="mdi:package-up"></ha-icon>`;
      return `<tr class="cl" data-upd="${i}">
        <td><div class="nm">${icon}<div class="tx"><div>${esc(u.name)}</div><div class="sub">${esc(u.kind)}</div></div></div></td>
        <td class="hide-s"><span class="kind">${esc(u.kind)}</span></td>
        <td class="ver">${esc(u.from ?? "—")} → <b>${esc(u.to ?? "?")}</b>${u.busy ? " · идёт…" : ""}</td></tr>`;
    }).join("");
    return `<div class="sec">${head}<table><tbody>${rows}</tbody></table></div>`;
  }

  _renderTable(s, si) {
    const cols = s.columns.map((c) => (typeof c === "string" ? { name: c } : c));
    const head = `<tr><th></th>${cols.map((c) => `<th class="num">${esc(c.name)}</th>`).join("")}</tr>`;
    const cellHtml = (ri, ci) => {
      const cell = s.rows[ri]?.cells?.[ci];
      if (cell === null || cell === undefined || cell === "") return `<td class="num">—</td>`;
      const it = typeof cell === "string" ? { entity: cell } : cell;
      const merged = { ...(cols[ci] || {}), ...it };
      const st = this._st(it.entity);
      const lvl = level(this._num(st, merged), merged.warn, merged.bad, merged.below);
      const val = merged.format === "plain" ? (st && !NA.has(st.state) ? st.state : "—") : this._fmtState(st, merged);
      return `<td class="num cell ${lvl === "ok" ? "" : lvl}" data-s="${si}" data-r="${ri}" data-c="${ci}">${esc(val)}</td>`;
    };
    // На узкой карточке таблица переворачивается: параметры — строки, исходные строки — колонки
    const tHead = `<tr><th></th>${s.rows.map((r) => `<th class="num">${esc(r.name || "")}</th>`).join("")}</tr>`;
    const tBody = cols.map((c, ci) => `<tr><td>${esc(c.name)}</td>${s.rows.map((r, ri) => cellHtml(ri, ci)).join("")}</tr>`).join("");
    const narrow = `<table class="tt-n"><thead>${tHead}</thead><tbody>${tBody}</tbody></table>`;
    const body = s.rows.map((r, ri) => {
      const tds = (r.cells || []).map((cell, ci) => {
        if (cell === null || cell === undefined || cell === "") return `<td class="num">—</td>`;
        const it = typeof cell === "string" ? { entity: cell } : cell;
        const col = cols[ci] || {};
        const merged = { ...col, ...it };
        const st = this._st(it.entity);
        const lvl = level(this._num(st, merged), merged.warn, merged.bad, merged.below);
        const val = merged.format === "plain" ? (st && !NA.has(st.state) ? st.state : "—") : this._fmtState(st, merged);
        return `<td class="num cell ${lvl === "ok" ? "" : lvl}" data-s="${si}" data-r="${ri}" data-c="${ci}">${esc(val)}</td>`;
      }).join("");
      return `<tr><td><div class="nm">${r.icon ? `<ha-icon icon="${esc(r.icon)}"></ha-icon>` : ""}<span>${esc(r.name || "")}</span></div></td>${tds}</tr>`;
    }).join("");
    return `<div class="tt-w" style="overflow-x:auto"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>${narrow}`;
  }

  _renderButtons(s, si) {
    if (!this._config.actions) return "";
    const items = s.items.filter((b) => b.admin === false || this._admin);
    if (!items.length) return "";
    return `<div class="btns">` + items.map((b) => {
      const i = s.items.indexOf(b);
      const st = this._st(b.entity);
      const name = b.name ?? st?.attributes?.friendly_name ?? b.entity ?? b.service;
      return `<button class="btn${b.danger ? " danger" : ""}" data-s="${si}" data-b="${i}">${b.icon ? `<ha-icon icon="${esc(b.icon)}"></ha-icon>` : ""}<span>${esc(name)}</span></button>`;
    }).join("") + `</div>`;
  }

  // ---------- действия ----------

  _moreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }

  _navigate(path) {
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  _tap(it, key) {
    const t = it.tap_action;
    if (t?.action === "list") {
      this._open = this._open === key ? null : key;
      this._html = null;
      return this._render();
    }
    if (t?.action === "navigate" && t.navigation_path) return this._navigate(t.navigation_path);
    if (t?.action === "url" && t.url_path) return window.open(t.url_path, "_blank", "noopener");
    if (t?.action === "none") return;
    this._moreInfo(t?.entity || it.entity);
  }

  async _press(b, el) {
    const h = this._hass;
    const st = this._st(b.entity);
    const name = b.name ?? st?.attributes?.friendly_name ?? b.entity ?? b.service;
    if (b.confirm !== false) {
      const text = typeof b.confirm === "string" ? b.confirm : `${name}?`;
      if (!confirm(text)) return;
    }
    try {
      if (el) el.disabled = true;
      if (b.navigate) { this._navigate(b.navigate); return; }
      if (b.service) {
        const [d, sv] = String(b.service).split(".");
        await h.callService(d, sv, b.data || {}, b.target);
      } else if (b.entity) {
        const d = b.entity.split(".")[0];
        const map = { button: "press", input_button: "press", script: "turn_on", scene: "turn_on", automation: "trigger", switch: "toggle", light: "toggle" };
        await h.callService(d, map[d] || "turn_on", {}, { entity_id: b.entity });
      }
      this._toast(b.done_text || `${name}: выполнено`);
    } catch (e) {
      this._toast(`Не получилось: ${e?.message || e}`);
    } finally {
      if (el) setTimeout(() => { el.disabled = false; }, 1500);
    }
  }

  async _addonCall(a, svc, verb) {
    if (!confirm(`${verb} «${a.name}»?`)) return;
    try {
      await this._hass.callService("hassio", svc, { addon: a.slug });
      this._toast(`${a.name}: ${verb.toLowerCase()} — выполнено`);
      setTimeout(() => this._loadAddons(), 3000);
    } catch (e) {
      this._toast(`Не получилось: ${e?.message || e}`);
    }
  }

  _onClick(e) {
    const c = this._config;
    const t = e.target;
    const btn = t.closest("[data-b]");
    if (btn) {
      const b = c.sections[+btn.dataset.s]?.items?.[+btn.dataset.b];
      if (b) this._press(b, btn);
      return;
    }
    const up = t.closest("[data-up]");
    if (up) {
      e.stopPropagation();
      const a = this._shownAddons?.[+up.dataset.up];
      const ent = a && this._addonUpdateEntity(a.slug);
      if (ent) this._moreInfo(ent);
      else if (a) this._navigate(`/hassio/addon/${a.slug}/info`);
      return;
    }
    const rs = t.closest("[data-restart]");
    if (rs) { e.stopPropagation(); const a = this._shownAddons?.[+rs.dataset.restart]; if (a) this._addonCall(a, "addon_restart", "Перезапустить"); return; }
    const sa = t.closest("[data-start]");
    if (sa) { e.stopPropagation(); const a = this._shownAddons?.[+sa.dataset.start]; if (a) this._addonCall(a, "addon_start", "Запустить"); return; }
    const ad = t.closest("[data-addon]");
    if (ad) { const a = this._shownAddons?.[+ad.dataset.addon]; if (a) this._navigate(`/hassio/addon/${a.slug}/info`); return; }
    const ud = t.closest("[data-upd]");
    if (ud) { const u = this._shownUpdates?.[+ud.dataset.upd]; if (u) this._moreInfo(u.id); return; }
    const cell = t.closest("td[data-r]");
    if (cell) {
      const s = c.sections[+cell.dataset.s];
      const v = s?.rows?.[+cell.dataset.r]?.cells?.[+cell.dataset.c];
      this._moreInfo(typeof v === "string" ? v : v?.entity);
      return;
    }
    if (t.closest("[data-close]")) { this._open = null; this._html = null; this._render(); return; }
    const mi = t.closest("[data-mi]");
    if (mi) {
      const [a, b] = mi.dataset.mi.split(":");
      const it = c.sections[+a]?.items?.[+b];
      if (it) this._moreInfo(it.tap_action?.entity || it.entity);
      return;
    }
    const tile = t.closest(".tile[data-i], .meter[data-i]");
    if (tile) {
      const it = c.sections[+tile.dataset.s]?.items?.[+tile.dataset.i];
      if (it) this._tap(it, `${tile.dataset.s}:${tile.dataset.i}`);
    }
  }
}

if (!customElements.get("system-status-card")) {
  customElements.define("system-status-card", SystemStatusCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "system-status-card",
    name: "System Status Card",
    description: "Сводка состояния системы: плитки, шкалы, аддоны, обновления, таблица и кнопки с подтверждением",
    documentationURL: "https://github.com/Lordhmen/system-status-card",
  });
  console.info(`%c SYSTEM-STATUS-CARD %c v${SSC_VERSION} `, "background:#3f51b5;color:#fff", "");
}
