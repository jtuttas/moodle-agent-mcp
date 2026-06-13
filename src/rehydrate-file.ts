// rehydrate-file.ts – lokale Datei-Rehydrierung (Pseudonym → Klarname)
//
// Läuft ausschließlich lokal. Der Rückgabewert enthält KEINE Klarnamen –
// nur Metadaten (Anzahl ersetzter Pseudonyme, Pseudonym-Kürzel, Feldname).
//
// .txt/.md  → TypeScript direkt (rehydrateTextForField aus redact.ts)
// .docx     → Python-Subprozess (rehydrate.py, benötigt python-docx)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { rehydrateTextForField } from "./redact.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");

/** Gibt den konfigurierbaren Basisordner zurück (lazy, damit Tests den Env-Wert setzen können). */
export function getRehydrateBaseDir(): string {
  return resolve(
    process.env.REHYDRATE_BASE_DIR ??
      join(PROJECT_ROOT, "..", "MoodleTutor", "Berichte")
  );
}

/** Pfad zur Zuordnungsdatei (lazy). */
export function getMapPath(): string {
  return process.env.PSEUDONYM_MAP ?? join(PROJECT_ROOT, "pseudonym-map.json");
}

/** Pfad zum Python-Skript für DOCX-Verarbeitung. */
export function getPythonScriptPath(): string {
  return join(PROJECT_ROOT, "rehydrate.py");
}

export class RehydrateError extends Error {}

/**
 * Validiert `p` gegen den Basisordner und gibt den absoluten Pfad zurück.
 * Wirft RehydrateError bei Pfad-Traversal oder absoluten Pfaden außerhalb der Basis.
 */
export function safePath(p: string): string {
  if (!p) throw new RehydrateError("Leerer Dateipfad.");
  const base = getRehydrateBaseDir();
  const abs = isAbsolute(p) ? p : join(base, p);
  const resolved = resolve(abs);
  const rel = relative(base, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new RehydrateError(
      "Pfad-Traversal oder Pfad außerhalb von REHYDRATE_BASE_DIR abgelehnt."
    );
  }
  return resolved;
}

export interface RehydrateResult {
  ok: boolean;
  /** Nur Dateiname, kein absoluter Pfad. */
  datei: string;
  pseudonyme_ersetzt: number;
  /** Nur Pseudonyme (S-xxxx), KEINE Klarnamen. */
  schueler: string[];
  field: string;
  fehler?: string;
}

/**
 * Rehydriert eine Berichtsdatei lokal (Pseudonym → echter Name).
 *
 * @param infile  Pfad zur Eingabedatei (relativ zu REHYDRATE_BASE_DIR oder absolut darin)
 * @param outfile Ausgabedatei (optional; Standard: in-place)
 * @param field   Welches Klardaten-Feld einsetzen (Standard: fullname)
 */
export function rehydrateFile(
  infile: string,
  outfile: string | undefined,
  field: "fullname" | "email" | "username" = "fullname"
): RehydrateResult {
  const absIn = safePath(infile);
  if (!existsSync(absIn)) {
    throw new RehydrateError(`Eingabedatei nicht gefunden: ${basename(infile)}`);
  }
  const absOut = outfile ? safePath(outfile) : absIn;
  const ext = absIn.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "docx") return rehydrateDocx(absIn, absOut, field);
  if (ext === "md" || ext === "txt") return rehydrateTextFile(absIn, absOut, field);
  throw new RehydrateError(
    `Nicht unterstützter Dateityp '.${ext}'. Erlaubt: .docx, .md, .txt`
  );
}

// ---------------------------------------------------------------------------
// .txt / .md
// ---------------------------------------------------------------------------

function rehydrateTextFile(
  absIn: string,
  absOut: string,
  field: "fullname" | "email" | "username"
): RehydrateResult {
  const original = readFileSync(absIn, "utf-8");
  const { text: rehydrated, replaced } = rehydrateTextForField(original, field);
  writeFileSync(absOut, rehydrated, "utf-8");
  return {
    ok: true,
    datei: basename(absOut),
    pseudonyme_ersetzt: replaced.length,
    schueler: replaced.sort(),
    field,
  };
}

// ---------------------------------------------------------------------------
// .docx  (Python-Subprozess)
// ---------------------------------------------------------------------------

function rehydrateDocx(
  absIn: string,
  absOut: string,
  field: "fullname" | "email" | "username"
): RehydrateResult {
  const scriptPath = getPythonScriptPath();
  const mapPath = getMapPath();

  if (!existsSync(scriptPath)) {
    throw new RehydrateError(
      `rehydrate.py nicht gefunden. Python-DOCX-Verarbeitung nicht möglich.`
    );
  }
  if (!existsSync(mapPath)) {
    throw new RehydrateError(
      "pseudonym-map.json nicht gefunden. Bitte zuerst Schülerdaten über ein Moodle-Tool laden."
    );
  }

  const pythonBin = process.env.PYTHON_BIN ?? "python3";
  const proc = spawnSync(
    pythonBin,
    [scriptPath, "--infile", absIn, "--outfile", absOut,
      "--field", field, "--map-path", mapPath, "--json-result"],
    { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 }
  );

  if (proc.error) {
    throw new RehydrateError(
      `Python konnte nicht gestartet werden: ${proc.error.message}. ` +
      "Sicherstellen: python3 und python-docx sind installiert (pip install python-docx)."
    );
  }
  if (proc.status !== 0) {
    const msg = (proc.stderr ?? "").trim();
    throw new RehydrateError(`rehydrate.py Fehler: ${msg || `Exit ${proc.status}`}`);
  }

  try {
    return JSON.parse(proc.stdout.trim()) as RehydrateResult;
  } catch {
    throw new RehydrateError(
      `Unerwartete Ausgabe von rehydrate.py – kein gültiges JSON.`
    );
  }
}
