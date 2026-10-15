# System Status Card

A Lovelace card for Home Assistant: a **system status overview** in one card —
threshold tiles, meters, add-ons, updates, a small table and confirm-before-action buttons.

![Server](docs/screenshot-server.png)

- **tiles** — versions from `update.*` ("available X"), "7 h ago" / "in 16 h" / uptime, `binary_sensor` states, numbers with `warn`/`bad` thresholds.
- **meters** — percentage bars, `max` as a number or another entity, `free: true`.
- **addons** — Supervisor add-ons with icons, state, version, CPU and RAM; restart/start with confirmation; update via the standard HA dialog.
- **updates** — every `update.*` entity with a newer version.
- **table** — entities as rows × columns; transposed on narrow cards.
- **buttons** — buttons, scripts or any service, with confirmation.

Single JS file, no dependencies. Sister project of [devices-table-card](https://github.com/Lordhmen/devices-table-card).

## Install

HACS → ⋮ → Custom repositories → `https://github.com/Lordhmen/system-status-card`, type **Dashboard**.
Or download `system-status-card.js` from Releases into `/config/www/` and add it as a JavaScript module resource.

## Examples

See [`examples/server.yaml`](examples/server.yaml) and [`examples/network.yaml`](examples/network.yaml).
The full option reference is in the [Russian README](README.md#параметры-карточки).

## License

MIT
