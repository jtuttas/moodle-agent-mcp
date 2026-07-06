// ===========================================================================
// office-extract.ts
// ---------------------------------------------------------------------------
// Textextraktion aus Office-Open-XML-Dateien (.docx / .xlsx) ohne externe
// Abhängigkeit außer JSZip (bereits im Projekt). Wird von den Download-Tools
// genutzt, damit Word-/Excel-Abgaben als lesbarer Text zurückgegeben werden
// statt nur als "kann nicht angezeigt werden".
//
//   .docx → Absätze aus word/document.xml (robuste Rekonstruktion inkl.
//           Zeilenumbrüchen <w:br>, Tabs <w:tab> und Absatzgrenzen <w:p>)
//   .xlsx → alle Arbeitsblätter, zeilen-/spaltengetreu (Tab-getrennt),
//           Shared-Strings aufgelöst
// ===========================================================================

import JSZip from "jszip";

/** Wandelt XML-Entities zurück in Klartext. `&amp;` zuletzt, um doppeltes
 *  Entschärfen zu vermeiden. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/** Extrahiert den Text eines einzelnen Word-XML-Parts (document/header/footer).
 *  Jedes <w:p> wird zu einer Zeile; <w:tab> → Tab, <w:br>/<w:cr> → Umbruch. */
function extractWordPartText(xml: string): string {
  // Nur der Body-Inhalt ist relevant; Absätze an </w:p> trennen.
  const paragraphs = xml.split(/<\/w:p>/);
  const lines: string[] = [];

  for (const para of paragraphs) {
    let text = "";
    // Reihenfolge der Alternativen ist wichtig: <w:t> vor <w:tab>, damit
    // "<w:tab/>" nicht fälschlich als leeres <w:t> interpretiert wird.
    const re =
      /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*?\/?>|<w:br\b[^>]*?\/?>|<w:cr\b[^>]*?\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(para)) !== null) {
      if (m[1] !== undefined) {
        text += m[1];
      } else if (m[0].startsWith("<w:tab")) {
        text += "\t";
      } else {
        text += "\n"; // <w:br> oder <w:cr>
      }
    }
    lines.push(unescapeXml(text));
  }

  // Mehr als eine Leerzeile zusammenfassen, Rand trimmen.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Liest den kompletten sichtbaren Text einer .docx (Hauptdokument + Kopf-/
 *  Fußzeilen). Wirft, wenn die Datei kein gültiges DOCX ist. */
export async function extractDocxText(buf: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error("Datei ist kein gültiges DOCX (ZIP konnte nicht geöffnet werden).");
  }

  const doc = zip.file("word/document.xml");
  if (!doc) {
    throw new Error("DOCX enthält kein word/document.xml.");
  }

  const parts: string[] = [await extractWordPartText(await doc.async("string"))];

  // Kopf-/Fußzeilen anhängen, falls vorhanden.
  const extraNames = Object.keys(zip.files)
    .filter((n) => /^word\/(header|footer)\d*\.xml$/i.test(n))
    .sort();
  for (const name of extraNames) {
    const f = zip.file(name);
    if (!f) continue;
    const t = extractWordPartText(await f.async("string"));
    if (t) parts.push(`--- ${name} ---\n${t}`);
  }

  return parts.filter((p) => p.length > 0).join("\n\n");
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** Spaltenbuchstaben (A, B, …, AA) → 0-basierter Index. */
function colToIndex(col: string): number {
  let n = 0;
  for (let i = 0; i < col.length; i++) {
    n = n * 26 + (col.charCodeAt(i) - 64);
  }
  return n - 1;
}

/** Parst xl/sharedStrings.xml in ein Array (Index → Zeichenkette). */
function parseSharedStrings(xml: string): string[] {
  const result: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    // Ein <si> kann mehrere <t> enthalten (Rich Text) – zusammenfügen.
    let text = "";
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(m[1])) !== null) text += tm[1];
    result.push(unescapeXml(text));
  }
  return result;
}

/** Extrahiert die Zellen eines Arbeitsblatts als Zeilen-Matrix. */
function parseSheet(sheetXml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const rowXml = rm[1] ?? ""; // leere Zeile (<row .../>) → keine Zellen
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      const attrs = cm[1];
      const inner = cm[2] ?? "";
      const rAttr = /r="([A-Z]+)\d+"/.exec(attrs);
      const tAttr = /t="([^"]+)"/.exec(attrs);
      const colIdx = rAttr ? colToIndex(rAttr[1]) : cells.length;

      let value = "";
      if (tAttr && tAttr[1] === "s") {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (v) value = sharedStrings[parseInt(v[1], 10)] ?? "";
      } else if (tAttr && tAttr[1] === "inlineStr") {
        let t = "";
        const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let tm: RegExpExecArray | null;
        while ((tm = tRe.exec(inner)) !== null) t += tm[1];
        value = unescapeXml(t);
      } else {
        // Zahl, Datum (seriell), Bool etc. – Rohwert aus <v>.
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? unescapeXml(v[1]) : "";
      }

      while (cells.length < colIdx) cells.push("");
      cells[colIdx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/** Liest alle Arbeitsblätter einer .xlsx als Tab-getrennten Text.
 *  Blattnamen werden – wo möglich – aus xl/workbook.xml übernommen. */
export async function extractXlsxText(buf: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error("Datei ist kein gültiges XLSX (ZIP konnte nicht geöffnet werden).");
  }

  const sharedFile = zip.file("xl/sharedStrings.xml");
  const sharedStrings = sharedFile
    ? parseSharedStrings(await sharedFile.async("string"))
    : [];

  // Blattnamen in Definitionsreihenfolge aus workbook.xml lesen.
  const sheetNames: string[] = [];
  const wb = zip.file("xl/workbook.xml");
  if (wb) {
    const wbXml = await wb.async("string");
    const nameRe = /<sheet\b[^>]*\bname="([^"]+)"[^>]*>/g;
    let nm: RegExpExecArray | null;
    while ((nm = nameRe.exec(wbXml)) !== null) sheetNames.push(unescapeXml(nm[1]));
  }

  // Worksheet-Dateien numerisch sortieren (sheet1, sheet2, … sheet10).
  const sheetFiles = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/sheet(\d+)\.xml$/i)?.[1] ?? "0", 10);
      const nb = parseInt(b.match(/sheet(\d+)\.xml$/i)?.[1] ?? "0", 10);
      return na - nb;
    });

  if (sheetFiles.length === 0) {
    throw new Error("XLSX enthält keine Arbeitsblätter.");
  }

  const blocks: string[] = [];
  for (let i = 0; i < sheetFiles.length; i++) {
    const f = zip.file(sheetFiles[i]);
    if (!f) continue;
    const rows = parseSheet(await f.async("string"), sharedStrings);
    const label = sheetNames[i] ?? `Blatt ${i + 1}`;
    const body = rows.map((r) => r.join("\t")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    blocks.push(`=== ${label} ===\n${body}`);
  }

  return blocks.join("\n\n");
}
