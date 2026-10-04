"""Gleisplan-Editor: Editor für Modellbahn-Gleispläne als Panel in Home Assistant.

Die Integration liefert den Editor (frontend/) aus, zeigt ihn als Panel in der
Seitenleiste, speichert die Pläne in .storage und schreibt die veröffentlichten
SVG/CSS-Dateien für ha-floorplan nach <config>/www/floorplan.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store
from homeassistant.loader import async_get_integration
from homeassistant.util import dt as dt_util

from .const import (
    DOMAIN,
    MAX_FILE_SIZE,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    PUBLISH_DIR,
    PUBLISH_URL,
    STATIC_URL,
    STORAGE_KEY,
    STORAGE_VERSION,
)

DATA_REGISTERED = f"{DOMAIN}_registered"

PLAN_ID = vol.All(str, vol.Match(r"^[A-Za-z0-9_-]{1,64}$"))
# Dateiname ohne Endung – bewusst eng, damit nichts außerhalb des Zielordners landet
FILE_BASE = vol.All(str, vol.Match(r"^[a-z0-9][a-z0-9_-]{0,63}$"))
FILE_CONTENT = vol.All(str, vol.Length(max=MAX_FILE_SIZE))


class PlanStorage:
    """Alle Pläne in einer Datei unter .storage."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.plans: dict[str, dict[str, Any]] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load()
        self.plans = (data or {}).get("plans", {})

    async def async_save(self) -> None:
        await self._store.async_save({"plans": self.plans})


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Panel und Speicher einrichten."""
    storage = PlanStorage(hass)
    await storage.async_load()
    hass.data[DOMAIN] = storage

    # Statische Pfade und WebSocket-Befehle lassen sich nicht wieder abmelden –
    # beim erneuten Laden des Eintrags deshalb nicht noch einmal registrieren.
    if not hass.data.get(DATA_REGISTERED):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    STATIC_URL,
                    str(Path(__file__).parent / "frontend"),
                    cache_headers=False,
                )
            ]
        )
        websocket_api.async_register_command(hass, ws_list_plans)
        websocket_api.async_register_command(hass, ws_get_plan)
        websocket_api.async_register_command(hass, ws_save_plan)
        websocket_api.async_register_command(hass, ws_delete_plan)
        websocket_api.async_register_command(hass, ws_publish)
        hass.data[DATA_REGISTERED] = True

    integration = await async_get_integration(hass, DOMAIN)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/panel.js?v={integration.version}",
        embed_iframe=False,
        require_admin=True,
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Panel entfernen; die gespeicherten Pläne bleiben erhalten."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    hass.data.pop(DOMAIN, None)
    return True


@callback
def _storage(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> PlanStorage | None:
    storage = hass.data.get(DOMAIN)
    if storage is None:
        connection.send_error(msg["id"], "not_loaded", "Gleisplan-Editor ist nicht geladen")
    return storage


def _plan_info(plan: dict[str, Any]) -> dict[str, Any]:
    return {"id": plan["id"], "name": plan["name"], "updated": plan["updated"]}


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/plans/list"})
@callback
def ws_list_plans(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Übersicht aller Pläne, ohne Inhalt."""
    if (storage := _storage(hass, connection, msg)) is None:
        return
    connection.send_result(msg["id"], [_plan_info(p) for p in storage.plans.values()])


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/plans/get", vol.Required("plan_id"): PLAN_ID}
)
@callback
def ws_get_plan(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Einen Plan samt Inhalt liefern."""
    if (storage := _storage(hass, connection, msg)) is None:
        return
    if (plan := storage.plans.get(msg["plan_id"])) is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "Plan nicht gefunden")
        return
    connection.send_result(msg["id"], plan)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/plans/save",
        vol.Required("plan_id"): PLAN_ID,
        vol.Optional("name", default=""): vol.All(str, vol.Length(max=120)),
        vol.Required("data"): dict,
    }
)
@websocket_api.async_response
async def ws_save_plan(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Plan anlegen oder überschreiben."""
    if (storage := _storage(hass, connection, msg)) is None:
        return
    plan = {
        "id": msg["plan_id"],
        "name": msg["name"],
        "updated": dt_util.utcnow().isoformat(),
        "data": msg["data"],
    }
    storage.plans[plan["id"]] = plan
    await storage.async_save()
    connection.send_result(msg["id"], _plan_info(plan))


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/plans/delete", vol.Required("plan_id"): PLAN_ID}
)
@websocket_api.async_response
async def ws_delete_plan(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Plan aus dem Speicher löschen (veröffentlichte Dateien bleiben liegen)."""
    if (storage := _storage(hass, connection, msg)) is None:
        return
    if storage.plans.pop(msg["plan_id"], None) is not None:
        await storage.async_save()
    connection.send_result(msg["id"])


def _write_files(directory: Path, files: dict[str, str]) -> bool:
    """Dateien schreiben; True, wenn der www-Ordner dabei erst angelegt wurde."""
    created_www = not directory.parent.is_dir()
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (directory / name).write_text(content, encoding="utf-8")
    return created_www


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/publish",
        vol.Required("name"): FILE_BASE,
        vol.Required("svg"): FILE_CONTENT,
        vol.Required("css"): FILE_CONTENT,
    }
)
@websocket_api.async_response
async def ws_publish(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """SVG und CSS für ha-floorplan nach <config>/www/floorplan schreiben."""
    name = msg["name"]
    files = {f"{name}.svg": msg["svg"], f"{name}.css": msg["css"]}
    try:
        created_www = await hass.async_add_executor_job(
            _write_files, Path(hass.config.path(*PUBLISH_DIR)), files
        )
    except OSError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return
    connection.send_result(
        msg["id"],
        {
            "svg_url": f"{PUBLISH_URL}/{name}.svg",
            "css_url": f"{PUBLISH_URL}/{name}.css",
            # /local gibt es erst, wenn www beim Start von Home Assistant vorhanden war
            "restart_required": created_www,
        },
    )
