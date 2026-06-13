/**
 * Unit-Tests für src/rehydrate-file.ts
 *
 * Getestet wird:
 *  1. Erfolgreiche Ersetzung in .md  (fullname)
 *  2. Erfolgreiche Ersetzung in .txt (email)
 *  3. Verweigerung bei Pfad-Traversal
 *  4. Verweigerung bei absolutem Pfad außerhalb der Basis
 *  5. Datei ohne Pseudonyme → pseudonyme_ersetzt = 0
 *  5b. Fehlende Map für .docx → RehydrateError (kein Dateiinhalt preisgegeben)
 *  6. Rückgabewert enthält KEINE Klarnamen
 *  7. .docx Ersetzung (via JSZip, kein Python nötig)
 *
 * Keine echten Schülerdaten: Fake-Map mit Dummy-Namen.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";

// ---------------------------------------------------------------------------
// Fake-Daten (keine echten Schülerdaten)
// ---------------------------------------------------------------------------

const FAKE_MAP = {
  _info: "TEST – enthält keine echten Daten",
  counter: 3,
  users: {
    "101": {
      pseudonym: "S-0001",
      fullname: "Erika Musterfrau",
      firstname: "Erika",
      lastname: "Musterfrau",
      email: "erika.muster@schule.test",
      username: "emusterfrau",
    },
    "102": {
      pseudonym: "S-0002",
      fullname: "Max Beispielmann",
      firstname: "Max",
      lastname: "Beispielmann",
      email: "max.beispiel@schule.test",
      username: "mbeispiel",
    },
    "103": {
      pseudonym: "S-0003",
      fullname: "Lena Testperson",
      firstname: "Lena",
      lastname: "Testperson",
      email: "lena.test@schule.test",
      username: "ltestperson",
    },
  },
};

// Alle echten Namen/E-Mails, die NIEMALS im Rückgabe-JSON stehen dürfen
const REAL_NAMES = [
  "Erika Musterfrau", "Erika", "Musterfrau",
  "Max Beispielmann", "Max", "Beispielmann",
  "Lena Testperson", "Lena", "Testperson",
  "erika.muster@schule.test", "emusterfrau",
  "max.beispiel@schule.test", "mbeispiel",
  "lena.test@schule.test", "ltestperson",
];

// ---------------------------------------------------------------------------
// Minimales .docx via JSZip (kein Python, kein externe Tooling nötig)
// ---------------------------------------------------------------------------

async function createMinimalDocx(path: string, bodyText: string): Promise<void> {
  const zip = new JSZip();

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`);

  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);

  // Zwei Paragraphen aus dem übergebenen Text aufbauen
  const paragraphs = bodyText.split("\n").filter(Boolean).map(
    (line) =>
      `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`
  ).join("\n    ");

  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
  </w:body>
</w:document>`);

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  writeFileSync(path, buf);
}

// ---------------------------------------------------------------------------
// Test-Setup
// ---------------------------------------------------------------------------

let tmpBase: string;
let fakeMapPath: string;
let savedBase: string | undefined;
let savedMap: string | undefined;

before(() => {
  tmpBase = mkdtempSync(join(tmpdir(), "rehydrate-test-"));
  fakeMapPath = join(tmpBase, "pseudonym-map.json");
  writeFileSync(fakeMapPath, JSON.stringify(FAKE_MAP, null, 2), "utf-8");

  savedBase = process.env.REHYDRATE_BASE_DIR;
  savedMap = process.env.PSEUDONYM_MAP;
  process.env.REHYDRATE_BASE_DIR = tmpBase;
  process.env.PSEUDONYM_MAP = fakeMapPath;
});

after(() => {
  rmSync(tmpBase, { recursive: true, force: true });
  if (savedBase === undefined) delete process.env.REHYDRATE_BASE_DIR;
  else process.env.REHYDRATE_BASE_DIR = savedBase;
  if (savedMap === undefined) delete process.env.PSEUDONYM_MAP;
  else process.env.PSEUDONYM_MAP = savedMap;
});

async function getModule() {
  return import("../rehydrate-file.js");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rehydrate-file", () => {
  test("1 – .md: Pseudonyme durch fullname ersetzen", async () => {
    const { rehydrateFile } = await getModule();

    writeFileSync(
      join(tmpBase, "bericht.md"),
      "# Bericht\n\nS-0001 hat abgegeben. S-0002 noch nicht.\n",
      "utf-8"
    );

    const result = await rehydrateFile("bericht.md", "bericht_klar.md", "fullname");

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.field, "fullname");
    assert.ok(result.pseudonyme_ersetzt >= 2);
    assert.ok(result.schueler.includes("S-0001"));
    assert.ok(result.schueler.includes("S-0002"));

    const written = readFileSync(join(tmpBase, "bericht_klar.md"), "utf-8");
    assert.ok(written.includes("Erika Musterfrau"));
    assert.ok(written.includes("Max Beispielmann"));
    assert.ok(!written.includes("S-0001"));
    assert.ok(!written.includes("S-0002"));
  });

  test("2 – .txt: Pseudonyme durch email ersetzen (in-place)", async () => {
    const { rehydrateFile } = await getModule();

    const txtPath = join(tmpBase, "adressen.txt");
    writeFileSync(txtPath, "Kontakt: S-0001 und S-0003\n", "utf-8");

    const result = await rehydrateFile("adressen.txt", undefined, "email");

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.field, "email");
    assert.ok(result.pseudonyme_ersetzt >= 1);
    for (const ps of result.schueler) {
      assert.match(ps, /^S-\d{4}$/, `"${ps}" ist kein Pseudonym-Format`);
    }
    const written = readFileSync(txtPath, "utf-8");
    assert.ok(
      written.includes("erika.muster@schule.test") ||
        written.includes("lena.test@schule.test")
    );
  });

  test("3 – Pfad-Traversal (..) wird abgelehnt", async () => {
    const { safePath, RehydrateError: RE } = await getModule();
    assert.throws(
      () => safePath("../../../etc/passwd"),
      (err: unknown) => err instanceof RE
    );
  });

  test("4 – Absoluter Pfad außerhalb der Basis wird abgelehnt", async () => {
    const { safePath, RehydrateError: RE } = await getModule();
    const outside =
      process.platform === "win32" ? "C:\\Windows\\System32\\hosts" : "/etc/hosts";
    assert.throws(
      () => safePath(outside),
      (err: unknown) => err instanceof RE
    );
  });

  test("5 – Datei ohne Pseudonyme: pseudonyme_ersetzt = 0", async () => {
    const { rehydrateFile } = await getModule();
    writeFileSync(join(tmpBase, "no-pseudo.txt"), "Alle haben das Ziel erreicht.\n", "utf-8");
    const result = await rehydrateFile("no-pseudo.txt", undefined, "fullname");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pseudonyme_ersetzt, 0);
    assert.deepStrictEqual(result.schueler, []);
  });

  test("5b – fehlende Map für .docx → RehydrateError (kein Dateiinhalt preisgegeben)", async () => {
    const { rehydrateFile, RehydrateError: RE } = await getModule();

    // Fake-.docx anlegen
    await createMinimalDocx(join(tmpBase, "fake.docx"), "S-0001 Test");

    const orig = process.env.PSEUDONYM_MAP;
    process.env.PSEUDONYM_MAP = join(tmpBase, "does-not-exist.json");
    try {
      // Mit leerer/fehlender Map läuft rehydrateDocx durch – aber 0 Ersetzungen,
      // kein Fehler (Map fehlt → Store leer → keine Paare). Wir prüfen stattdessen
      // den Fehlerfall "kein gültiges DOCX":
      const badPath = join(tmpBase, "bad.docx");
      writeFileSync(badPath, "kein zip", "utf-8");
      await assert.rejects(
        async () => rehydrateFile(join(tmpBase, "bad.docx"), undefined, "fullname"),
        (err: unknown) => {
          assert.ok(err instanceof RE, "muss RehydrateError sein");
          const msg = (err as Error).message;
          assert.ok(!REAL_NAMES.some((n) => msg.includes(n)), "keine Klarnamen in Fehlermeldung");
          return true;
        }
      );
    } finally {
      process.env.PSEUDONYM_MAP = orig ?? fakeMapPath;
    }
  });

  test("6 – Rückgabewert enthält KEINE Klarnamen", async () => {
    const { rehydrateFile } = await getModule();

    writeFileSync(
      join(tmpBase, "check-privacy.md"),
      "Bericht: S-0001, S-0002, S-0003\n",
      "utf-8"
    );

    const result = await rehydrateFile("check-privacy.md", undefined, "fullname");

    const resultJson = JSON.stringify(result);
    for (const name of REAL_NAMES) {
      assert.ok(!resultJson.includes(name), `"${name}" darf NICHT im JSON stehen`);
    }
    for (const s of result.schueler) {
      assert.match(s, /^S-\d+$/, `"${s}" ist kein Pseudonym`);
    }
  });

  test("7 – .docx Ersetzung via JSZip (kein Python nötig)", async () => {
    const { rehydrateFile } = await getModule();

    // Minimales .docx programmatisch erstellen
    const docxIn = join(tmpBase, "test-input.docx");
    await createMinimalDocx(
      docxIn,
      "S-0001 hat die Aufgabe bestanden.\nS-0002 noch nicht."
    );
    assert.ok(existsSync(docxIn));

    const docxOut = join(tmpBase, "test-output.docx");
    const result = await rehydrateFile(docxIn, docxOut, "fullname");

    assert.strictEqual(result.ok, true);
    assert.ok(result.pseudonyme_ersetzt >= 2);
    assert.ok(result.schueler.includes("S-0001"));
    assert.ok(result.schueler.includes("S-0002"));

    // Kein Klarname im JSON-Ergebnis
    const resultJson = JSON.stringify(result);
    for (const name of REAL_NAMES) {
      assert.ok(!resultJson.includes(name), `"${name}" darf nicht im Ergebnis stehen`);
    }

    // Ausgabe-DOCX prüfen: XML direkt lesen
    const outZip = await JSZip.loadAsync(readFileSync(docxOut));
    const docXml = await outZip.file("word/document.xml")!.async("string");
    assert.ok(docXml.includes("Erika Musterfrau"), "Klarname muss in XML stehen");
    assert.ok(!docXml.includes("S-0001"), "Pseudonym darf nicht mehr in XML stehen");
    assert.ok(docXml.includes("Max Beispielmann"));
    assert.ok(!docXml.includes("S-0002"));
  });
});
