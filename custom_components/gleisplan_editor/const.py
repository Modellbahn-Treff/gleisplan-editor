"""Konstanten des Gleisplan-Editors."""

DOMAIN = "gleisplan_editor"

# Editor-Dateien (frontend/) – ohne Anmeldung abrufbar, enthält nur den Editor-Code
STATIC_URL = "/gleisplan_editor"

PANEL_URL_PATH = "gleisplan-editor"
PANEL_ELEMENT = "gleisplan-editor-panel"
PANEL_TITLE = "Gleisplan"
PANEL_ICON = "mdi:train"

STORAGE_KEY = f"{DOMAIN}.plans"
STORAGE_VERSION = 1

# Zielordner für veröffentlichte Pläne: <config>/www/floorplan → /local/floorplan
PUBLISH_DIR = ("www", "floorplan")
PUBLISH_URL = "/local/floorplan"
MAX_FILE_SIZE = 5 * 1024 * 1024
