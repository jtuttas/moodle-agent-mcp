// ---------------------------------------------------------------------------
// redact.ts – Pseudonymisierung personenbezogener Daten am MCP-Server
// ---------------------------------------------------------------------------
//
// Zweck: Der MCP-Server ist die letzte Station unter Kontrolle der Schule,
// bevor Tool-Ergebnisse an das (Cloud-)Modell gehen. Dieses Modul ersetzt
// Klarnamen, E-Mail-Adressen und Logins durch stabile Pseudonyme (S-0001 …),
// BEVOR die Antwort den Server verlässt. Die numerische userid bleibt als
// technischer Schlüssel erhalten (sie ist ohne Zugriff auf die lokale
// Moodle-Instanz nicht auflösbar) – dadurch funktionieren grade/send_message
// ohne Rückübersetzung weiter.
//
// Die Zuordnung pseudonym <-> Klardaten liegt VERTRAULICH und ausschließlich
// lokal in pseudonym-map.json (Pfad via PSEUDONYM_MAP überschreibbar) und wird
// niemals an das Modell übertragen.
//
// Steuerung über Umgebungsvariable:  REDACT_PII=0  schaltet die Redaktion ab.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const REDACT_PII =
  (process.env.REDACT_PII ?? "1") !== "0" &&
  (process.env.REDACT_PII ?? "1").toLowerCase() !== "false";

const MAP_PATH =
  process.env.PSEUDONYM_MAP ?? join(HERE, "..", "pseudonym-map.json");

interface Identity {
  pseudonym: string;
  fullname?: string;
  firstname?: string;
  lastname?: string;
  email?: string;
  username?: string;
}

interface MapFile {
  _info: string;
  counter: number;
  users: Record<string, Identity>;
}

const store: MapFile = {
  _info:
    "VERTRAULICH - Zuordnung Pseudonym zu Klardaten. NIEMALS an Modell/Cloud geben.",
  counter: 0,
  users: {},
};

let dirty = false;

function loadStore(): void {
  if (!existsSync(MAP_PATH)) return;
  try {
    const parsed = JSON.parse(readFileSync(MAP_PATH, "utf-8")) as Partial<MapFile>;
    if (parsed.users) store.users = parsed.users;
    if (typeof parsed.counter === "number") store.counter = parsed.counter;
  } catch {
    // beschädigte Datei – mit leerem Store weiterarbeiten, nichts überschreiben
  }
}
loadStore();

function persist(): void {
  if (!dirty) return;
  try {
    writeFileSync(MAP_PATH, JSON.stringify(store, null, 2), "utf-8");
    dirty = false;
  } catch {
    // Schreibfehler nicht fatal – Redaktion läuft weiter (nur nicht persistent)
  }
}

function ensurePseudonym(uid: number | string): Identity {
  const key = String(uid);
  let id = store.users[key];
  if (!id) {
    store.counter += 1;
    id = { pseudonym: `S-${String(store.counter).padStart(4, "0")}` };
    store.users[key] = id;
    dirty = true;
  }
  return id;
}

function setIf(id: Identity, field: keyof Identity, value: unknown): void {
  if (typeof value === "string" && value.trim() && id[field] !== value) {
    id[field] = value;
    dirty = true;
  }
}

/** Registriert eine Person (uid + bekannte Klardaten) und vergibt ein Pseudonym. */
export function registerIdentity(uid: number | string, fields: Partial<Identity>): void {
  if (uid === undefined || uid === null || uid === "") return;
  const id = ensurePseudonym(uid);
  setIf(id, "fullname", fields.fullname);
  setIf(id, "firstname", fields.firstname);
  setIf(id, "lastname", fields.lastname);
  setIf(id, "email", fields.email);
  setIf(id, "username", fields.username);
}

const COURSE_MARKERS = ["shortname", "summaryformat", "categoryid", "modname", "summary"];

/**
 * Durchsucht beliebige Moodle-Antworten rekursiv nach Personen-Objekten
 * (userid/id + fullname/userfullname/email/username) und registriert sie.
 * Kurs-, Gruppen- und Modul-Objekte werden anhand typischer Felder ausgeschlossen.
 */
export function harvestIdentities(data: unknown): void {
  if (!REDACT_PII) return;
  walk(data);
  persist();
}

function walk(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  const looksLikeCourse = COURSE_MARKERS.some((m) => m in obj);
  const uidRaw = obj.userid ?? obj.id;
  const uid = typeof uidRaw === "number" ? uidRaw : undefined;

  const fullname =
    (typeof obj.fullname === "string" && obj.fullname) ||
    (typeof obj.userfullname === "string" && obj.userfullname) ||
    undefined;
  const email = typeof obj.email === "string" && obj.email.includes("@") ? obj.email : undefined;
  const username = typeof obj.username === "string" ? obj.username : undefined;
  const hasUserFullname = typeof obj.userfullname === "string";

  const isPerson =
    !!email ||
    !!username ||
    hasUserFullname ||
    (!!fullname && !looksLikeCourse);

  if (uid !== undefined && isPerson) {
    registerIdentity(uid, {
      fullname: fullname || undefined,
      firstname: typeof obj.firstname === "string" ? obj.firstname : undefined,
      lastname: typeof obj.lastname === "string" ? obj.lastname : undefined,
      email,
      username,
    });
  }

  // Rekursion in verschachtelte Strukturen
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") walk(value);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Pair {
  re: RegExp;
  repl: string;
}

function buildPairs(): Pair[] {
  const pairs: Pair[] = [];
  for (const id of Object.values(store.users)) {
    const ps = id.pseudonym;
    const exact: string[] = [];
    if (id.fullname) exact.push(id.fullname);
    if (id.lastname && id.firstname) exact.push(`${id.lastname}, ${id.firstname}`);
    if (id.email) exact.push(id.email);
    if (id.username) exact.push(id.username);
    // Einzel-Token (Vor-/Nachname) für Erwähnungen mitten im Freitext
    if (id.firstname && id.firstname.length >= 3) exact.push(id.firstname);
    if (id.lastname && id.lastname.length >= 3) exact.push(id.lastname);
    for (const term of exact) {
      // Wortgrenzen ueber Unicode-Buchstaben/Ziffern/Unterstrich; Satzzeichen
      // (Punkt, Komma) zaehlen als Grenze, damit ein Name am Satzende erkannt
      // wird. E-Mails matchen trotzdem als Ganzes, da der Begriff seine eigenen
      // Punkte/@ als Literal enthaelt und laengere Begriffe zuerst ersetzt werden.
      const re = new RegExp(
        "(?<![\\p{L}\\p{N}_])" + escapeRe(term) + "(?![\\p{L}\\p{N}_])",
        "giu"
      );
      pairs.push({ re, repl: ps });
    }
  }
  // Laengste Begriffe zuerst ersetzen ("Christian Ziegner" vor "Christian")
  pairs.sort((a, b) => b.re.source.length - a.re.source.length);
  return pairs;
}

/** Ersetzt alle bekannten Klardaten in einem Text durch Pseudonyme. */
export function redactText(text: string): string {
  if (!REDACT_PII || !text) return text;
  let out = text;
  for (const pair of buildPairs()) out = out.replace(pair.re, pair.repl);
  return out;
}

interface ContentItem {
  type: string;
  text?: string;
  [k: string]: unknown;
}
interface ToolResult {
  content?: ContentItem[];
  [k: string]: unknown;
}

/** Wendet die Redaktion auf alle Text-Bestandteile eines Tool-Ergebnisses an. */
export function redactResult<T extends ToolResult>(result: T): T {
  if (!REDACT_PII || !result || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.map((item) =>
      item && item.type === "text" && typeof item.text === "string"
        ? { ...item, text: redactText(item.text) }
        : item
    ),
  };
}

/** Loest einen Namen/Teilstring/E-Mail/Login LOKAL zu userid + Pseudonym auf.
 *  Gibt bewusst KEINE Klarnamen zurueck (den Namen kennt das Modell bereits aus
 *  der Nutzereingabe) - nur den technischen Schluessel und das Pseudonym. */
export function resolveStudent(query: string): Array<{ userid: string; pseudonym: string }> {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const out: Array<{ userid: string; pseudonym: string }> = [];
  for (const [uid, id] of Object.entries(store.users)) {
    const fields = [id.fullname, id.firstname, id.lastname, id.email, id.username]
      .filter(Boolean)
      .map((x) => (x as string).toLowerCase());
    if (fields.some((f) => f.includes(q) || q.includes(f))) {
      out.push({ userid: uid, pseudonym: id.pseudonym });
    }
  }
  return out;
}

export const REHYDRATE_FIELD = (process.env.REHYDRATE_FIELD ?? "firstname").toLowerCase();

/** Rueckweg-Rehydrierung: ersetzt Pseudonyme (S-000x) in AUSGEHENDEM Text
 *  (Nachrichten/Feedback an Moodle) durch den echten Namen. Laeuft nur lokal,
 *  BEVOR der Aufruf an Moodle geht - das Modell hat die Namen nie gesehen.
 *  Standard: Vorname (REHYDRATE_FIELD=fullname fuer den ganzen Namen). */
export function rehydrateText(text: string): string {
  if (!REDACT_PII || !text) return text;
  let out = text;
  const ids = Object.values(store.users)
    .filter((id) => id.pseudonym)
    .sort((a, b) => b.pseudonym.length - a.pseudonym.length);
  for (const id of ids) {
    const firstFromFull = id.fullname ? id.fullname.trim().split(/\s+/)[0] : undefined;
    const name =
      REHYDRATE_FIELD === "fullname"
        ? id.fullname || id.firstname || firstFromFull
        : id.firstname || firstFromFull || id.fullname;
    if (name) out = out.split(id.pseudonym).join(name);
  }
  return out;
}
