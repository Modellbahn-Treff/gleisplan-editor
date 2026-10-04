# Gleisplan-Editor für ha-floorplan

Lokales Web-Tool zum Zeichnen von Modellbahn-Gleisplänen (Geraden, Kurven,
Weichen, Kreuzungen, Prellböcke, Links, Signale, Blockabschnitte) im Stil der
Märklin CS3 – als Grundlage für die [ha-floorplan](https://github.com/ExperienceLovelace/ha-floorplan)-Karte
in Home Assistant.

## Starten

Einfach `index.html` per Doppelklick im Browser öffnen (Chrome/Edge/Firefox/Safari).
Kein Server, kein Build-Schritt, keine Internetverbindung nötig. Der Plan wird
automatisch im Browser (`localStorage`) zwischengespeichert.

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
