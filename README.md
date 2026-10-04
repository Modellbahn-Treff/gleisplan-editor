# Gleisplan-Editor für ha-floorplan

Web-Tool zum Zeichnen von Modellbahn-Gleisplänen (Geraden, Kurven,
Weichen, Kreuzungen, Prellböcke, Links, Signale, Blockabschnitte) – als Grundlage für die [ha-floorplan](https://github.com/ExperienceLovelace/ha-floorplan)-Karte
in Home Assistant.

Der Editor läuft auf zwei Arten:

- **als Panel in Home Assistant** (Custom Integration): mit Entity-Auswahl, Live-Zuständen,
  Plan-Speicherung in Home Assistant und Veröffentlichen per Knopfdruck,
- **eigenständig im Browser**, ohne Home Assistant: Übergabe per Datei-Export.

## Installation in Home Assistant

Voraussetzung: Home Assistant 2024.7 oder neuer. Die Installationsart spielt keine Rolle
(HA OS, Container, Core).

1. **Über HACS**: HACS → ⋮ → *Benutzerdefinierte Repositories* → URL dieses Repositorys,
   Typ *Integration* → „Gleisplan-Editor“ installieren.
   **Oder von Hand**: den Ordner `custom_components/gleisplan_editor` nach
   `<config>/custom_components/` kopieren.
2. Home Assistant neu starten.
3. *Einstellungen → Geräte & Dienste → Integration hinzufügen* → „Gleisplan-Editor“.
4. In der Seitenleiste erscheint **Gleisplan** (nur für Administratoren).

Für die Anzeige im Dashboard wird zusätzlich
[ha-floorplan](https://github.com/ExperienceLovelace/ha-floorplan) benötigt (über HACS).

### Was das Panel zusätzlich kann

- **Entity-Auswahl**: Die Entity-Felder schlagen die vorhandenen Entities vor (passende
  Domänen zuerst) und zeigen darunter den aktuellen Zustand. Unbekannte Entities werden rot
  markiert.
- **Live-Zustände**: Weichen und Signale zeigen im Editor die Stellung der Anlage, belegte
  Blöcke sind in der Blockliste markiert. Über „Weiche schalten (Test)“ lässt sich die
  Zuordnung direkt prüfen.
- **Pläne in Home Assistant**: Der geöffnete Plan wird nach jeder Änderung automatisch
  gespeichert (`<config>/.storage/gleisplan_editor.plans`) und steht damit auf jedem Gerät
  bereit. Oben den Plannamen eintragen; „Pläne…“ öffnet oder löscht gespeicherte Pläne,
  „Neuer Plan“ legt einen weiteren an.
- **In HA veröffentlichen**: schreibt SVG und CSS nach `<config>/www/floorplan/`. Der
  Dateiname folgt dem Plannamen („Bahnhof Süd“ → `bahnhof_sued.svg`), ohne Namen
  `gleisplan.svg`. Danach zeigt ein Dialog die fertige Karte als YAML: beim ersten Mal in
  ein Dashboard einfügen (*Karte hinzufügen → Manuell*). Später genügt erneutes
  Veröffentlichen, solange sich keine Entities, Element-IDs oder Link-Ziele ändern – sonst
  die Karte neu einfügen.

Wurde der Ordner `www` beim Veröffentlichen erst angelegt, muss Home Assistant einmal neu
gestartet werden, damit `/local/…` erreichbar ist (der Dialog weist darauf hin).

## Eigenständig starten (ohne Home Assistant)

`custom_components/gleisplan_editor/frontend/index.html` per Doppelklick im Browser öffnen
(Chrome/Edge/Firefox/Safari). Kein Server, kein Build-Schritt, keine Internetverbindung
nötig. Der Plan wird automatisch im Browser (`localStorage`) zwischengespeichert.

## Bedienung

- Werkzeug links wählen, dann im Raster klicken um ein Element zu platzieren.
- Erneuter Klick auf ein vorhandenes Gleis/Weiche vom selben Typ **dreht** es um 90°.
- **Signal**: Klickposition in der Zelle bestimmt die Seite (oben/rechts/unten/links).
- **Block**: "+ Neuer Block" klicken, dann Zellen anklicken um sie zuzuweisen/zu entfernen.
- **Auswahl**-Werkzeug: Element anklicken → rechts Element-ID, HA-Entity und Beschriftung setzen.
  Die Beschriftung einer Weiche wird neben der Weiche ins SVG geschrieben und ist damit auch in Home Assistant sichtbar.
- **Link**: Gleisende mit Fortsetzung auf einem anderen Plan (wenn nicht die ganze Anlage auf einen
  Plan passt). Verhält sich wie ein Prellbock, hat aber einen Pfeil als Symbol und kann keinem Block
  zugeordnet werden. Im Auswahl-Werkzeug rechts die **Zielseite** setzen (z.B. `/lovelace/gleisplan-2`) –
  in Home Assistant öffnet ein Klick auf den Link diese Seite.
- `R` = Auswahl drehen (15°, `Umschalt+R` zurück), `Entf` = löschen.
- **Unbegrenzte Zeichenfläche**: Ausschnitt verschieben mit Mausrad/Trackpad, mittlerer Maustaste
  oder `Leertaste`+Ziehen; zoomen mit `Strg/Cmd`+Mausrad bzw. Pinch oder den Knöpfen unten rechts.
  Beim Ziehen an den Rand wandert der Ausschnitt mit.
- **Mehrfachauswahl**: Rahmen auf leerer Fläche aufziehen, `Strg/Cmd+A` (alles) oder
  `Umschalt`+Klick. Die Auswahl lässt sich gemeinsam verschieben (ziehen oder Pfeiltasten,
  mit `Umschalt` in 1-px-Schritten) und am orangen Griff gemeinsam drehen.
- **Zwischenablage**: `Strg/Cmd+C` / `X` / `V`, `Strg/Cmd+D` dupliziert. Kopien lassen sich auch
  in einen anderen Plan einfügen (nach „Plan laden“/„Neuer Plan“ oder in einem zweiten Fenster).
  Standard: Gleise, Weichen und Signale samt HA-Entities, ohne Blockzuordnung.
  `Strg/Cmd+Umschalt+V` öffnet einen Dialog für Blockzuordnung und Entities.
- **Rückgängig/Wiederholen**: `Strg/Cmd+Z`, `Strg/Cmd+Umschalt+Z` (oder `Strg+Y`).
- `Esc` hebt die Auswahl auf bzw. wechselt zurück zum Auswahl-Werkzeug.
- Die Hilfe (Button oben rechts) fasst das nochmal zusammen.

## Export

- **SVG exportieren** → `gleisplan.svg`
- **CSS exportieren** → `gleisplan.css` (Basis-Styles + Zustandsklassen)
- **ha-floorplan YAML** → `gleisplan-floorplan.yaml` (nur für Elemente mit gesetzter HA-Entity bzw. Links mit Zielseite)
- **Plan speichern (.json)** → zum späteren Weiterbearbeiten

## Einrichtung in Home Assistant

Die Schritte 1–3 gelten für den Datei-Export; im Panel erledigt sie „In HA veröffentlichen“.

1. [ha-floorplan](https://github.com/ExperienceLovelace/ha-floorplan) über HACS installieren.
2. `gleisplan.svg` und `gleisplan.css` nach `<config>/www/floorplan/` kopieren.
3. Inhalt von `gleisplan-floorplan.yaml` komplett in den YAML-Editor einer neuen
   Lovelace-Karte einfügen – `type: custom:floorplan-card`, `full_height: true` und
   `config:` sind bereits enthalten (Pfade `image:`/`stylesheet:` ggf. anpassen,
   `image_resource_prefix` beachten falls ihr eine andere Ordnerstruktur nutzt).
4. Für jede Weiche muss die verknüpfte Entity ein `switch` (oder `input_boolean`)
   sein, dessen Zustand die Weichenstellung widerspiegelt – passt `tap_action`/
   `service` in der YAML ggf. an eure tatsächliche Weichensteuerung an
   (z.B. andere Service-Domain, `select.select_option` bei Mehrwegweichen).
5. Links erzeugen eine Regel mit `tap_action: navigate` und dem eingetragenen Pfad als
   `navigation_path` (bei `http(s)://`-Adressen `action: url`). Für jeden Teilplan eine eigene
   Ansicht/ein eigenes Dashboard mit eigener Floorplan-Karte anlegen und die Links gegenseitig
   auf deren Pfade zeigen lassen.
6. Blockabschnitte und Signale sind in Home Assistant reine Anzeige und nicht anklickbar
   (`tap_action: false` in der YAML, `pointer-events: none` im CSS) – nur Weichen schalten.
7. Für Blockabschnitte eignet sich ein `binary_sensor` (Gleisbesetztmelder),
   für Signale ein `light`, `input_select` oder ein Template-Sensor mit
   Zuständen `on`/`off`.

Die generierte YAML ist ein **Startpunkt** – Klassennamen (`block-occupied`,
`turnout-diverging`, `signal-green`, …) lassen sich in `gleisplan.css` frei
anpassen, ebenso die Farben/Stile.

## Aufbau

```
custom_components/gleisplan_editor/
├── __init__.py        Panel, Plan-Speicher, Schreib-Befehl (WebSocket, nur Administratoren)
├── config_flow.py     Einrichtung über die Oberfläche
├── manifest.json
└── frontend/
    ├── panel.js       Panel für die Seitenleiste: zeigt index.html im iframe, reicht hass hinein
    ├── index.html     der Editor
    ├── app.js
    ├── ha.js          Home-Assistant-Anbindung, ohne Panel wirkungslos
    └── style.css
```

Die Editor-Dateien liefert Home Assistant unter `/gleisplan_editor/…` ohne Anmeldung aus – dort
liegt nur der Editor-Code. Pläne und das Schreiben von Dateien laufen über die angemeldete
WebSocket-Verbindung und sind auf Administratoren beschränkt.

## Lizenz

[MIT](LICENSE)
