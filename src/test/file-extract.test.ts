/**
 * Unit-Tests für src/file-extract.ts
 *
 * Hintergrund: moodle_download_all_submissions lieferte PDFs/Bilder als Base64
 * in einer einzigen JSON-Antwort (>1 Mio. Tokens). Der Client legte das in eine
 * Datei ab, die das Modell nicht mehr lesen konnte. Jetzt wird Text extrahiert
 * und größenbegrenzt; Binärdateien liefern nur Metadaten.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractKind, extractPdfText, capText } from "../file-extract.js";

/** Minimal-PDF mit einer Seite und dem Text `text` (korrekte xref-Offsets). */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("extractKind – Text, Office, PDF, Bild, Binär", () => {
  assert.equal(extractKind("main.py", "application/octet-stream"), "text");
  assert.equal(extractKind("a.docx", "application/octet-stream"), "docx");
  assert.equal(extractKind("a.xlsx", ""), "xlsx");
  assert.equal(extractKind("scan", "application/pdf"), "pdf");
  assert.equal(extractKind("logo.svg", "image/svg+xml"), null);
  assert.equal(extractKind("foto.jpg", "image/jpeg"), null);
  assert.equal(extractKind("projekt.zip", "application/zip"), null);
});

test("extractPdfText – liefert Text und Seitenzahl statt Base64", async () => {
  const { text, pages } = await extractPdfText(makePdf("Hallo Welt"));
  assert.equal(pages, 1);
  assert.match(text, /--- Seite 1 ---/);
  assert.match(text, /Hallo Welt/);
});

test("capText – kürzt und markiert, lässt kurze Texte unverändert", () => {
  assert.deepEqual(capText("kurz", 10), { text: "kurz", truncated: false });
  const r = capText("x".repeat(100), 10);
  assert.equal(r.truncated, true);
  assert.ok(r.text.startsWith("x".repeat(10)));
  assert.match(r.text, /gekürzt: 90 weitere Zeichen/);
});
