# Pseudonymisierung am MCP-Server (Datenschutz)

Diese Erweiterung sorgt dafür, dass **Klarnamen, E-Mail-Adressen und Logins von
Schülerinnen und Schülern den Server nicht verlassen**. Der MCP-Server ist die
letzte Station unter Kontrolle der Schule, bevor Tool-Ergebnisse an das (Cloud-)
Modell gehen – genau hier wird redigiert.

## Was passiert

```
Moodle (lokal) ──▶ MCP-Server (lokal) ──▶ [Redaktion] ──▶ Modell (Cloud)
                                              │
                                   pseudonym-map.json (vertraulich, bleibt lokal)
```

- **Hinweg:** In jeder Moodle-Antwort werden `fullname`, `firstname`,
  `lastname`, `email` und `username` durch ein stabiles Pseudonym (`S-0001`,
  `S-0002`, …) ersetzt – auch wenn Namen mitten im Freitext stehen (Feedback,
  Nachrichten, Abgabe-Inhalte).
- Die numerische **`userid` bleibt erhalten**. Sie ist nur mit Zugriff auf die
  lokale Moodle-Instanz auflösbar, die das Modell nicht hat. Dadurch
  funktionieren `moodle_grade_assignment` und `moodle_send_message` ohne
  Rückübersetzung weiter.
- Kurs-, Gruppen- und Modulnamen werden **nicht** verändert.

## Umsetzung im Code

- Neues Modul `src/redact.ts`:
  - `harvestIdentities(data)` – lernt Personen (userid + Klardaten) aus jeder
    Moodle-Rohantwort und vergibt stabile Pseudonyme.
  - `redactResult(result)` / `redactText(text)` – ersetzen alle bekannten
    Klardaten in der Tool-Ausgabe.
- `src/index.ts` ruft `harvestIdentities()` zentral in `moodleCall()` auf und
  legt einen Redaktions-Wrapper um den Tool-Handler (`redactResult`).

## Zuordnungstabelle

Die Zuordnung Pseudonym ↔ Klardaten liegt **ausschließlich lokal** in
`pseudonym-map.json` (per `.gitignore` vom Commit ausgeschlossen). Diese Datei
ist vertraulich und darf niemals an Modell, MCP-Client oder Cloud gegeben
werden. Sie dient der Lehrkraft, um Pseudonyme bei Bedarf lokal wieder
aufzulösen.

## Konfiguration

| Variable        | Bedeutung                                                        |
| --------------- | ---------------------------------------------------------------- |
| `REDACT_PII`    | `1` (Standard) = Redaktion aktiv; `0` = aus (nur Debugging)      |
| `PSEUDONYM_MAP` | Optionaler Pfad zur Zuordnungsdatei (Standard: Projektwurzel)    |

## Grenzen

- Der Freitext-Scrubber arbeitet nach bestem Aufwand: Er ersetzt **bekannte**
  Namen. Ein Name eines Nutzers, den der Server in der aktuellen Sitzung noch
  nie über eine Moodle-Antwort „gesehen" hat, kann in seltenen Fällen
  unredigiert durchrutschen. In der Praxis ruft fast jeder Workflow zuerst
  Kurs-/Schülerlisten ab, wodurch die Zuordnung gefüllt wird.
- Die `userid` ist ein Quasi-Identifikator (siehe oben) – im Sinne der
  Datenminimierung bewusst beibehalten, aber ohne Moodle nicht auflösbar.

## Rueckweg-Rehydrierung (ausgehende Nachrichten/Feedback)

Der ausgehende Weg (Modell -> Tool -> Moodle) laeuft durch den Server. Daher
ersetzt der Server in ausgehenden Texten Pseudonyme (S-000x) wieder durch den
echten Namen, BEVOR der Aufruf an Moodle geht. Das Modell adressiert per
Pseudonym ("Hallo S-0002,"), der Empfaenger in Moodle erhaelt den Klarnamen
("Hallo Joerg,") - der Name entsteht rein lokal und gelangt nie ins Modell.

Betroffene Tools: `moodle_send_message` (message, subject),
`moodle_send_message_to_course` (message, subject), `moodle_grade_assignment`
(feedback). Funktion: `rehydrateText()` in `redact.ts`.

Konfiguration: `REHYDRATE_FIELD=firstname` (Standard, natuerliche Anrede) oder
`fullname`.

## Tool moodle_rehydrate_report

Rehydriert eine **lokale Berichtsdatei** (Pseudonym → Klarname), ohne dass
Klarnamen jemals an das Modell übertragen werden. Das Tool:

1. Validiert den Dateipfad gegen `REHYDRATE_BASE_DIR` (Pfad-Traversal sicher abgewiesen).
2. Liest `.md`/`.txt` direkt in TypeScript (nutzt dieselbe Zuordnungstabelle wie die
   laufende Redaktion).
3. Verarbeitet `.docx` vollständig in Node.js via **JSZip** (kein Python nötig):
   öffnet das DOCX-ZIP, ersetzt Pseudonyme in `word/document.xml` und allen
   Header-/Footer-Parts, schreibt das ZIP zurück.
4. Gibt **ausschließlich Metadaten** zurück – kein Klarname im Rückgabewert:
   ```json
   { "ok": true, "datei": "bericht.klar.md",
     "pseudonyme_ersetzt": 3, "schueler": ["S-0001","S-0002","S-0003"],
     "field": "fullname", "ausgabe_getrennt": true }
   ```

### Getrennter Ausgabeordner (Datenschutz)

Der Eingabeordner (`REHYDRATE_BASE_DIR`) muss für den MCP-Client (z. B. Claude
CoWork) **beschreibbar** sein – nur so kann dieser die *pseudonymisierte* Vorlage
dort ablegen. Die rehydrierte Ausgabe enthält jedoch **Klarnamen**: Läge sie im
selben, für CoWork lesbaren Ordner, könnte das Modell sie zurücklesen, und der
Datenschutzgewinn wäre dahin.

Lösung: `REHYDRATE_OUT_DIR` auf einen **getrennten** Ordner setzen, auf den CoWork
**keinen Lesezugriff** hat. Dann gilt:

- Die Klartext-Ausgabe wird ausschließlich dorthin geschrieben
  (Standard-Dateiname `<name>.klar.<ext>`), die pseudonymisierte Eingabe wird
  **nie** überschrieben (`ausgabe_getrennt: true`).
- Ist `REHYDRATE_OUT_DIR` nicht gesetzt und landet die Ausgabe im lesbaren
  Eingabeordner, enthält das Ergebnis zusätzlich ein Feld `warnung` und
  `ausgabe_getrennt: false`.

### Konfiguration

| Variable             | Bedeutung                                                          |
| -------------------- | ------------------------------------------------------------------ |
| `REHYDRATE_BASE_DIR` | Eingabe-Basisordner (pseudonymisierte Vorlage; Standard: `../MoodleTutor/Berichte`) |
| `REHYDRATE_OUT_DIR`  | Optional: getrennter Ausgabeordner für die Klarnamen-Datei (für CoWork möglichst nicht lesbar) |
| `PSEUDONYM_MAP`      | Pfad zur Zuordnungsdatei (wie bei der übrigen Redaktion)           |
