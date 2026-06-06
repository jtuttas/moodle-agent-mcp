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
