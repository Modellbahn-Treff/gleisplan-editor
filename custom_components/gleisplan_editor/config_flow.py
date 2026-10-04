"""Einrichtung über die Oberfläche – es gibt nichts einzustellen."""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN


class GleisplanEditorConfigFlow(ConfigFlow, domain=DOMAIN):
    """Legt den einen Eintrag an (single_config_entry im Manifest)."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="Gleisplan-Editor", data={})
        return self.async_show_form(step_id="user")
