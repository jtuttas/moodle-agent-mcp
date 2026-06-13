// rehydrate-file.ts – lokale Datei-Rehydrierung (Pseudonym → Klarname)
//
// Läuft ausschließlich lokal. Der Rückgabewert enthält KEINE Klarnamen –
// nur Metadaten (Anzahl ersetzter Pseudonyme, Pseudonym-Kürzel, Feldname).
//
// .txt/.md  → TypeScript direkt (rehydrateTextForField aus redact.ts)
// .docx     → JSZip: ZIP öffnen, XML-Parts ersetzen, ZIP zurückschreiben
//             Verarbeitet word/document.xml sowie alle Header-/Footer-Parts.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { rehydrateTextForField, getRehydrationPairs } from "./redact.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");

/** Gibt den konfigurierbaren Basisordner zurück (lazy, damit Tests den Env-Wert setzen können). */
export function getRehydrateBaseDir(): string {
  return resolve(
    process.env.REHYDRATE_BASE_DIR ??
      join(PROJECT_ROOT, "..", "MoodleTutor", "Berichte")
  );
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
export async function rehydrateFile(
  infile: string,
  outfile: string | undefined,
  field: "fullname" | "email" | "username" = "fullname"
): Promise<RehydrateResult> {
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
  };
}
