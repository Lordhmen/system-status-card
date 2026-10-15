// Смоук-тесты карточки в Node без браузера: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "system-status-card.js"), "utf8");

const mkEl = () => ({ innerHTML: "", addEventListener() {} });
globalThis.HTMLElement = class {
  attachShadow() {
    const els = {};
    const root = { innerHTML: "", getElementById(id) { return els[id] || (els[id] = mkEl()); } };
    this.shadowRoot = root;
    return root;
  }
  dispatchEvent() {}
};
globalThis.customElements = { _m: {}, get(n) { return this._m[n]; }, define(n, c) { this._m[n] = c; } };
globalThis.window = {};
globalThis.console.info = () => {};
(0, eval)(src.replace("class SystemStatusCard", "globalThis.SSC = class SystemStatusCard")
  .replace('customElements.define("system-status-card", SystemStatusCard)', 'customElements.define("system-status-card", globalThis.SSC)'));
const SSC = globalThis.SSC;
const NOW = Date.parse("2026-10-15T08:00:00Z");
Date.now = () => NOW;

const st = (state, attributes = {}) => ({ state, attributes, last_changed: "2026-10-15T07:00:00Z" });
function hass(extra = {}) {
  return {
    config: { time_zone: "Asia/Yekaterinburg" }, user: { is_admin: false },
    states: {
      "update.core": st("on", { installed_version: "2026.10.1", latest_version: "2026.10.2", title: "Home Assistant Core", friendly_name: "Core" }),
      "update.os": st("off", { installed_version: "18.3", latest_version: "18.3" }),
      "update.card": st("on", { installed_version: "v1", latest_version: "v2", friendly_name: "Mushroom Обновление" }),
      "sensor.last_backup": st("2026-10-13T00:00:00Z", { device_class: "timestamp" }),
      "sensor.next_backup": st("2026-10-16T00:00:00Z", { device_class: "timestamp" }),
      "sensor.boot": st("2026-10-14T19:44:35Z"),
      "sensor.temp": st("87", { unit_of_measurement: "°C" }),
      "sensor.cpu": st("25", { unit_of_measurement: "%" }),
      "sensor.free": st("31.05", { unit_of_measurement: "MB" }),
      "sensor.total": st("62.27", { unit_of_measurement: "MB" }),
      "sensor.uptime_h": st("96.94", { unit_of_measurement: "h" }),
      "sensor.down": st("unavailable", { unit_of_measurement: "Mbit/s" }),
      "binary_sensor.wan": st("off", {}),
      "sensor.ch": st("149"),
      "sensor.noise": st("-92", { unit_of_measurement: "dBm" }),
      ...extra,
    },
    entities: { "update.core": { platform: "hassio" }, "update.os": { platform: "hassio" }, "update.card": { platform: "hacs" } },
    devices: {},
  };
}

test("плитки: версия, «назад» с порогом, аптайм, пороги, binary, duration, недоступно", () => {
  const c = new SSC();
  c.setConfig({ sections: [{ type: "tiles", items: [
    { entity: "update.core", name: "Core" },
    { entity: "update.os", name: "OS" },
    { entity: "sensor.last_backup", name: "Бэкап", format: "ago", warn_after: 26, bad_after: 50 },
    { entity: "sensor.next_backup", format: "in" },
    { entity: "sensor.boot", format: "since" },
    { entity: "sensor.temp", warn: 70, bad: 85 },
    { entity: "binary_sensor.wan", on_text: "онлайн", off_text: "нет связи" },
    { entity: "sensor.uptime_h", format: "duration" },
    { entity: "sensor.down" },
    { entity: "sensor.nope" },
  ] }] });
  c.hass = hass();
  const t = c._config.sections[0].items.map((it) => c._tile(it));
  assert.equal(t[0].value, "2026.10.1"); assert.equal(t[0].lvl, "warn"); assert.match(t[0].sub, /2026\.10\.2/);
  assert.equal(t[1].lvl, "ok");
  assert.equal(t[2].value, "2 д 8 ч назад"); assert.equal(t[2].lvl, "bad");
  assert.equal(t[3].value, "через 16 ч");
  assert.equal(t[4].value, "12 ч 15 мин");
  assert.equal(t[5].lvl, "bad"); assert.equal(t[5].value, "87 °C");
  assert.equal(t[6].value, "нет связи"); assert.equal(t[6].lvl, "bad");
  assert.equal(t[7].value, "4 д");
  assert.equal(t[8].lvl, "na");
  assert.equal(t[9].sub, "нет сущности");
  assert.match(c.shadowRoot.getElementById("body").innerHTML, /tile warn/);
});

test("шкалы: процент, free + max-сущность, пороги", () => {
  const c = new SSC();
  c.setConfig({ sections: [{ type: "meters", items: [
    { entity: "sensor.cpu", name: "CPU" },
    { entity: "sensor.free", max: "sensor.total", free: true, name: "Флеш" },
    { entity: "sensor.temp", max: 100, warn: 70, bad: 85 },
  ] }] });
  c.hass = hass();
  const m = c._config.sections[0].items.map((it) => c._meter(it));
  assert.equal(m[0].text, "25 %"); assert.equal(m[0].lvl, "ok");
  assert.equal(Math.round(m[1].pct), 50); assert.equal(m[1].sub, "31,2 из 62,3 MB");
  assert.equal(m[2].lvl, "bad");
});

test("обновления: только доступные, имя без «Обновление», исключения", () => {
  const c = new SSC();
  c.setConfig({ sections: [{ type: "updates" }] });
  c.hass = hass();
  const u = c._updateList(c._config.sections[0]);
  assert.equal(u.total, 3);
  assert.deepEqual(u.pending.map((x) => x.name), ["Home Assistant Core", "Mushroom"]);
  assert.equal(u.pending[1].kind, "HACS");
  const u2 = c._updateList({ type: "updates", exclude_platforms: ["hacs"] });
  assert.equal(u2.pending.length, 1);
  c.hass = hass({ "update.core": st("off", { installed_version: "1", latest_version: "1" }), "update.card": st("off", {}) });
  assert.match(c.shadowRoot.getElementById("body").innerHTML, /Всё обновлено/);
});

test("аддоны из сущностей (без прав администратора) и сортировка", () => {
  const c = new SSC();
  c.setConfig({ sections: [{ type: "addons", exclude: ["core_samba"] }] });
  const h = hass({
    "binary_sensor.z_running": st("on"), "update.z": st("off", { installed_version: "2.14", latest_version: "2.14" }),
    "binary_sensor.m_running": st("off"), "update.m": st("on", { installed_version: "7.1", latest_version: "7.2" }),
    "binary_sensor.s_running": st("on"),
  });
  h.devices = {
    dz: { id: "dz", name: "Zigbee2MQTT", model: "Home Assistant App", identifiers: [["hassio", "45df_z2m"]] },
    dm: { id: "dm", name: "Mosquitto", model: "Home Assistant App", identifiers: [["hassio", "core_mosquitto"]] },
    ds: { id: "ds", name: "Samba", model: "Home Assistant App", identifiers: [["hassio", "core_samba"]] },
    dc: { id: "dc", name: "Core", model: "Home Assistant Core", identifiers: [["hassio", "core"]] },
  };
  h.entities = {
    "binary_sensor.z_running": { entity_id: "binary_sensor.z_running", device_id: "dz" }, "update.z": { entity_id: "update.z", device_id: "dz" },
    "binary_sensor.m_running": { entity_id: "binary_sensor.m_running", device_id: "dm" }, "update.m": { entity_id: "update.m", device_id: "dm" },
    "binary_sensor.s_running": { entity_id: "binary_sensor.s_running", device_id: "ds" },
  };
  c.hass = h;
  const l = c._addonList(c._config.sections[0]);
  assert.deepEqual(l.map((a) => a.name), ["Mosquitto", "Zigbee2MQTT"]);
  assert.equal(l[0].update_available, true); assert.equal(l[0].state, "stopped");
  assert.equal(c._addonUpdateEntity("core_mosquitto"), "update.m");
  const html = c.shadowRoot.getElementById("body").innerHTML;
  assert.match(html, /1 из 2 работают · обновлений: 1/);
  assert.doesNotMatch(html, /data-restart/, "без прав администратора кнопок нет");
});

test("аддоны из Supervisor API со статистикой", async () => {
  const c = new SSC();
  c.setConfig({ sections: [{ type: "addons" }] });
  const h = hass();
  h.user.is_admin = true;
  h.callWS = async (m) => m.endpoint === "/addons"
    ? { addons: [{ slug: "a", name: "A", state: "started", version: "1", version_latest: "1", icon: true }, { slug: "b", name: "B", state: "stopped", version: "2", version_latest: "3", update_available: true }] }
    : { cpu_percent: 1.5, memory_usage: 150 * 1024 * 1024 };
  c.hass = h;
  await new Promise((r) => setTimeout(r, 10));
  const html = c.shadowRoot.getElementById("body").innerHTML;
  assert.match(html, /150 МБ/); assert.match(html, /1,5 %/); assert.match(html, /data-start="0"/); assert.match(html, /→ 3/);
  assert.match(html, /\/api\/hassio\/addons\/a\/icon/);
});

test("таблица и кнопки; ошибки конфигурации", () => {
  const c = new SSC();
  c.setConfig({ sections: [
    { type: "table", columns: ["Канал", { name: "Шум", warn: -80 }], rows: [{ name: "5 ГГц", cells: [{ entity: "sensor.ch", format: "plain" }, "sensor.noise"] }] },
    { type: "buttons", items: [{ name: "Перезагрузить", entity: "button.x", confirm: "Точно?" }] },
  ] });
  const h = hass(); h.user.is_admin = true;
  c.hass = h;
  const html = c.shadowRoot.getElementById("body").innerHTML;
  assert.match(html, />149</); assert.match(html, /-92 dBm/); assert.match(html, /Перезагрузить/);
  assert.throws(() => c.setConfig({}), /sections/);
  assert.throws(() => c.setConfig({ sections: [{ type: "x" }] }), /Unknown section/);
  assert.throws(() => c.setConfig({ sections: [{ type: "tiles" }] }), /items/);
});
