// ===========================================================================
// file-extract.ts
// ---------------------------------------------------------------------------
// Gemeinsame Textextraktion für die Download-Tools. Ziel: Abgabe-Dateien als
// lesbaren Text an das Modell geben – NIE als Base64. Base64 ist für das
// Modell unlesbar und sprengt bei mehreren PDFs/Fotos sofort das Token-Limit
// des MCP-Clients.
//
//   Text/Code → UTF-8-Text
//   .docx     → extractDocxText (office-extract.ts)
//   .xlsx     → extractXlsxText (office-extract.ts)
//   .pdf      → Textebene via unpdf (gescannte PDFs liefern ggf. leeren Text)
//   sonstige  → null (Aufrufer liefert nur Metadaten)
// ===========================================================================

import { extractText, getDocumentProxy } from "unpdf";
import { extractDocxText, extractXlsxText } from "./office-extract.js";

const TEXT_MIMES = new Set([
  "text/plain", "text/html", "text/css", "text/javascript",
  "text/csv", "text/xml", "text/markdown",
  "application/json", "application/xml", "application/javascript",
  "application/x-httpd-php",
]);

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "html", "htm", "css", "js", "ts", "jsx", "tsx",
  "py", "java", "c", "cpp", "h", "cs", "php", "rb", "go",
  "json", "xml", "yaml", "yml", "csv", "sql", "sh", "bat",
  "rs", "swift", "kt", "r", "m", "vue", "svelte",
]);

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const IMAGE_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
]);

export type ExtractKind = "text" | "docx" | "xlsx" | "pdf";

export function fileExtension(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

/** Ermittelt, ob (und wie) aus der Datei Text gewonnen werden kann. */
export function extractKind(filename: string, mimetype: string): ExtractKind | null {
  const mime = mimetype.split(";")[0].trim().toLowerCase();
  const ext = fileExtension(filename);
  if (mime === DOCX_MIME || ext === "docx") return "docx";
  if (mime === XLSX_MIME || ext === "xlsx") return "xlsx";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  // SVG ist zwar XML, wird aber als Bild behandelt
  if (mime === "image/svg+xml" || ext === "svg") return null;
  if (TEXT_MIMES.has(mime) || TEXT_EXTENSIONS.has(ext)) return "text";
  return null;
}

export async function extractPdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => `--- Seite ${i + 1} ---\n${t.trim()}`);
  return { text: pages.join("\n\n"), pages: totalPages };
}

/** Extrahiert Text gemäß `kind`. */
export async function extractByKind(kind: ExtractKind, buf: Buffer): Promise<string> {
  switch (kind) {
    case "text":
      return buf.toString("utf8");
    case "docx":
      return extractDocxText(buf);
    case "xlsx":
      return extractXlsxText(buf);
    case "pdf":
      return (await extractPdfText(buf)).text;
  }
}

/** Kürzt Text auf `max` Zeichen und markiert das Abschneiden. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n\n[… gekürzt: ${text.length - max} weitere Zeichen nicht übertragen]`,
    truncated: true,
  };
}
