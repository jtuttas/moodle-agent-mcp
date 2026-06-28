// rehydrate-file.ts – lokale Datei-Rehydrierung (Pseudonym → Klarname)
//
// Läuft ausschließlich lokal. Der Rückgabewert enthält KEINE Klarnamen –
// nur Metadaten (Anzahl ersetzter Pseudonyme, Pseudonym-Kürzel, Feldname).
//
// .txt/.md  → TypeScript direkt (rehydrateTextForField aus redact.ts)
// .docx     → JSZip: ZIP öffnen, XML-Parts ersetzen, ZIP zurückschreiben
//             Verarbeitet word/document.xml sowie alle Header-/Footer-Parts.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join, relative, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { rehydrateTextForField, getRehydrationPairs } from "./redact.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");

/** Gibt den konfigurierbaren Eingabe-Basisordner zurück (lazy, damit Tests den Env-Wert setzen können). */
export function getRehydrateBaseDir(): string {
  return resolve(
    process.env.REHYDRATE_BASE_DIR ??
      join(PROJECT_ROOT, "..", "MoodleTutor", "Berichte")
  );
}

/**
 * Optionaler, GETRENNTER Ausgabeordner für rehydrierte Klarnamen-Dateien.
 *
 * Hintergrund: Der Eingabeordner (REHYDRATE_BASE_DIR) muss für den MCP-Client
 * (z. B. Claude CoWork) beschreibbar sein – nur so kann er die pseudonymisierte
 * Vorlage dort ablegen. Die rehydrierte AUSGABE enthält jedoch Klarnamen; läge
 * sie im selben, für CoWork lesbaren Ordner, könnte das Modell sie zurücklesen.
 * Ist REHYDRATE_OUT_DIR gesetzt, landet die Klartext-Ausgabe dort (idealerweise
 * ein für CoWork NICHT lesbarer Ordner) und die pseudonymisierte Eingabe wird
 * NIE überschrieben.
 *
 * @returns absoluter Pfad oder null, wenn nicht konfiguriert.
 */
export function getRehydrateOutDir(): string | null {
  const v = process.env.REHYDRATE_OUT_DIR;
  return v && v.trim() ? resolve(v) : null;
}

export class RehydrateError extends Error {}

/** Bindet `p` an `base`; wirft RehydrateError bei Traversal oder Pfad außerhalb. */
function confineTo(base: string, p: string): string {
  if (!p) throw new RehydrateError("Leerer Dateipfad.");
  const abs = isAbsolute(p) ? p : join(base, p);
  const resolved = resolve(abs);
  const rel = relative(base, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new RehydrateError(
      "Pfad-Traversal oder Pfad außerhalb des erlaubten Ordners abgelehnt."
    );
  }
  return resolved;
}

/**
 * Validiert `p` gegen den Eingabe-Basisordner (REHYDRATE_BASE_DIR).
 * Wirft RehydrateError bei Pfad-Traversal oder absoluten Pfaden außerhalb der Basis.
 */
export function safePath(p: string): string {
  return confineTo(getRehydrateBaseDir(), p);
}

/** Fügt vor der Dateiendung `.klar` ein (z. B. `bericht.md` → `bericht.klar.md`). */
function deriveClearName(inName: string): string {
  const dot = inName.lastIndexOf(".");
  if (dot <= 0) return `${inName}.klar`;
  return `${inName.slice(0, dot)}.klar${inName.slice(dot)}`;
}

/**
 * Bestimmt den Ausgabepfad und ob die Ausgabe datenschutzkonform getrennt liegt.
 *
 * - REHYDRATE_OUT_DIR gesetzt → Ausgabe ERZWUNGEN in diesen getrennten Ordner;
 *   Eingabedatei wird nie überschrieben.
 * - sonst → Ausgabe bleibt im (CoWork-lesbaren) Eingabeordner; es wird eine
 *   Warnung erzeugt, besonders deutlich bei In-place-Überschreibung.
 */
function resolveOutput(
  absIn: string,
  outfile: string | undefined
): { absOut: string; ausgabe_getrennt: boolean; warnung?: string } {
  const outDir = getRehydrateOutDir();

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const target = outfile ?? deriveClearName(basename(absIn));
    const absOut = confineTo(outDir, target);
    if (absOut === absIn) {
      throw new RehydrateError(
        "Ausgabe würde die Eingabedatei überschreiben. Bitte einen anderen Dateinamen wählen."
      );
    }
    return { absOut, ausgabe_getrennt: true };
  }

  const absOut = outfile ? safePath(outfile) : absIn;
  const warnung =
    absOut === absIn
      ? "IN-PLACE-Überschreibung: Die pseudonymisierte Vorlage wurde im Eingabeordner (REHYDRATE_BASE_DIR) durch Klarnamen ersetzt. Dieser Ordner ist für den MCP-Client (CoWork) lesbar – die Klarnamen können dadurch zurück ins Modell gelangen. Empfehlung: REHYDRATE_OUT_DIR auf einen für CoWork NICHT lesbaren Ordner setzen."
      : "Die Klarnamen-Ausgabe liegt im Eingabeordner (REHYDRATE_BASE_DIR), der für den MCP-Client (CoWork) lesbar ist. Für eine echte Trennung REHYDRATE_OUT_DIR auf einen für CoWork NICHT lesbaren Ordner setzen.";
  return { absOut, ausgabe_getrennt: false, warnung };
}

export interface RehydrateResult {
  ok: boolean;
  /** Nur Dateiname, kein absoluter Pfad. */
  datei: string;
  pseudonyme_ersetzt: number;
  /** Nur Pseudonyme (S-xxxx), KEINE Klarnamen. */
  schueler: string[];
  field: string;
  /** true = Ausgabe in getrenntem REHYDRATE_OUT_DIR (empfohlen, datenschutzkonform). */
  ausgabe_getrennt: boolean;
  /** Datenschutzhinweis, falls die Klartext-Ausgabe im CoWork-lesbaren Eingabeordner liegt. */
  warnung?: string;
  fehler?: string;
}

/**
 * Rehydriert eine Berichtsdatei lokal (Pseudonym → echter Name).
 *
 * @param infile  Pfad zur Eingabedatei (relativ zu REHYDRATE_BASE_DIR oder absolut darin)
 * @param outfile Ausgabedatei (optional; Standard: in-place)
 * @param field   Welches Klardaten-Feld einsetzen (Standard: fullname)
 */
export async function rehydrateFile(
  infile: string,
  outfile: string | undefined,
  field: "fullname" | "email" | "username" = "fullname"
): Promise<RehydrateResult> {
  const absIn = safePath(infile);
  if (!existsSync(absIn)) {
    throw new RehydrateError(`Eingabedatei nicht gefunden: ${basename(infile)}`);
  }

  const { absOut, ausgabe_getrennt, warnung } = resolveOutput(absIn, outfile);
  const ext = absIn.split(".").pop()?.toLowerCase() ?? "";

  let result: RehydrateResult;
  if (ext === "docx") result = await rehydrateDocx(absIn, absOut, field);
  else if (ext === "md" || ext === "txt") result = rehydrateTextFile(absIn, absOut, field);
  else
    throw new RehydrateError(
      `Nicht unterstützter Dateityp '.${ext}'. Erlaubt: .docx, .md, .txt`
    );

  result.ausgabe_getrennt = ausgabe_getrennt;
  if (warnung) result.warnung = warnung;
  return result;
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
    ausgabe_getrennt: false,
  };
}

// ---------------------------------------------------------------------------
// .docx  (JSZip + XML-Ersetzung, kein Python)
// ---------------------------------------------------------------------------

/** Escaped Sonderzeichen für XML-Textinhalt (verhindert kaputtes XML). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function rehydrateDocx(
  absIn: string,
  absOut: string,
  field: "fullname" | "email" | "username"
): Promise<RehydrateResult> {
  const pairs = getRehydrationPairs(field);
  const replaced = new Set<string>();

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(readFileSync(absIn));
  } catch {
    throw new RehydrateError(
      "Datei konnte nicht als DOCX gelesen werden (kein gültiges ZIP/DOCX-Format)."
    );
  }

  // Relevante XML-Parts: Hauptdokument + alle Header/Footer
  const partNames = Object.keys(zip.files).filter(
    (name) =>
      name === "word/document.xml" ||
      /^word\/(header|footer)\d*\.xml$/i.test(name)
  );

  for (const partName of partNames) {
    const file = zip.file(partName);
    if (!file) continue;
    let xml = await file.async("string");
    let changed = false;

    for (const { re, repl, pseudonym } of pairs) {
      // XML-escape des Klarnamens, damit kein ungültiges XML entsteht
      const xmlRepl = escapeXml(repl);
      const next = xml.replace(re, xmlRepl);
      if (next !== xml) {
        replaced.add(pseudonym);
        xml = next;
        changed = true;
      }
    }

    if (changed) zip.file(partName, xml);
  }

  const outputBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
  writeFileSync(absOut, outputBuffer);

  return {
    ok: true,
    datei: basename(absOut),
    pseudonyme_ersetzt: replaced.size,
    schueler: [...replaced].sort(),
    field,
    ausgabe_getrennt: false,
  };
}
