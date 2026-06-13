/**
 * Unit-Tests für src/rehydrate-file.ts
 *
 * Getestet wird:
 *  1. Erfolgreiche Ersetzung in .md  (fullname)
 *  2. Erfolgreiche Ersetzung in .txt (email)
 *  3. Verweigerung bei Pfad-Traversal
 *  4. Verweigerung bei absolutem Pfad außerhalb der Basis
 *  5. Datei ohne Pseudonyme → pseudonyme_ersetzt = 0
 *  5b. Fehlende Map für .docx → klarer RehydrateError (kein Dateiinhalt preisgegeben)
 *  6. Rückgabewert enthält KEINE Klarnamen
 *  7. Ersetzung .docx (übersprungen wenn Python/python-docx fehlt)
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
import { spawnSync } from "node:child_process";

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
  "Erika Musterfrau",
  "Erika",
  "Musterfrau",
  "Max Beispielmann",
  "Max",
  "Beispielmann",
  "Lena Testperson",
  "Lena",
  "Testperson",
  "erika.muster@schule.test",
  "emusterfrau",
  "max.beispiel@schule.test",
  "mbeispiel",
  "lena.test@schule.test",
  "ltestperson",
];

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
  restoreEnv();
});

function restoreEnv(): void {
  if (savedBase === undefined) {
    delete process.env.REHYDRATE_BASE_DIR;
  } else {
    process.env.REHYDRATE_BASE_DIR = savedBase;
  }
  if (savedMap === undefined) {
    delete process.env.PSEUDONYM_MAP;
  } else {
    process.env.PSEUDONYM_MAP = savedMap;
  }
  // Restore zu tmpBase für die Dauer der Testsuite
  process.env.REHYDRATE_BASE_DIR = tmpBase;
  process.env.PSEUDONYM_MAP = fakeMapPath;
}

async function getModule() {
  // Lazy import; lazy Getter in rehydrate-file.ts lesen env-Vars zur Laufzeit.
  return import("../rehydrate-file.js");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rehydrate-file", () => {
  test("1 – .md: Pseudonyme durch fullname ersetzen", async () => {
    const { rehydrateFile } = await getModule();

    const content = "# Bericht\n\nS-0001 hat abgegeben. S-0002 noch nicht.\n";
    writeFileSync(join(tmpBase, "bericht.md"), content, "utf-8");

    const result = rehydrateFile("bericht.md", "bericht_klar.md", "fullname");

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.field, "fullname");
    assert.ok(result.pseudonyme_ersetzt >= 2, "mind. 2 Pseudonyme ersetzt");
    assert.ok(result.schueler.includes("S-0001"), "S-0001 in schueler-Liste");
    assert.ok(result.schueler.includes("S-0002"), "S-0002 in schueler-Liste");

    const written = readFileSync(join(tmpBase, "bericht_klar.md"), "utf-8");
    assert.ok(written.includes("Erika Musterfrau"), "Klarname muss in Datei stehen");
    assert.ok(written.includes("Max Beispielmann"), "Klarname muss in Datei stehen");
    assert.ok(!written.includes("S-0001"), "Pseudonym darf nicht mehr enthalten sein");
    assert.ok(!written.includes("S-0002"), "Pseudonym darf nicht mehr enthalten sein");
  });

  test("2 – .txt: Pseudonyme durch email ersetzen (in-place)", async () => {
    const { rehydrateFile } = await getModule();

    const content = "Kontakt: S-0001 und S-0003\n";
    const txtPath = join(tmpBase, "adressen.txt");
    writeFileSync(txtPath, content, "utf-8");

    const result = rehydrateFile("adressen.txt", undefined, "email");

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.field, "email");
    assert.ok(result.pseudonyme_ersetzt >= 1);
    for (const ps of result.schueler) {
      assert.match(ps, /^S-\d{4}$/, `"${ps}" ist kein Pseudonym-Format`);
    }
    const written = readFileSync(txtPath, "utf-8");
    assert.ok(
      written.includes("erika.muster@schule.test") ||
        written.includes("lena.test@schule.test"),
      "mind. eine E-Mail muss in Datei stehen"
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
      process.platform === "win32"
        ? "C:\\Windows\\System32\\hosts"
        : "/etc/hosts";
    assert.throws(
      () => safePath(outside),
      (err: unknown) => err instanceof RE
    );
  });

  test("5 – Datei ohne Pseudonyme: pseudonyme_ersetzt = 0", async () => {
    const { rehydrateFile } = await getModule();
    writeFileSync(
      join(tmpBase, "no-pseudo.txt"),
      "Alle haben das Ziel erreicht.\n",
      "utf-8"
    );
    const result = rehydrateFile("no-pseudo.txt", undefined, "fullname");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pseudonyme_ersetzt, 0);
    assert.deepStrictEqual(result.schueler, []);
  });

  test("5b – fehlende Map für .docx → RehydrateError (kein Dateiinhalt preisgegeben)", async () => {
    const { rehydrateFile, RehydrateError: RE } = await getModule();
    // Fake-.docx anlegen (nicht valides Docx – aber map-check kommt vorher)
    writeFileSync(join(tmpBase, "fake.docx"), "not a real docx", "utf-8");

    const orig = process.env.PSEUDONYM_MAP;
    process.env.PSEUDONYM_MAP = join(tmpBase, "does-not-exist.json");
    try {
      assert.throws(
        () => rehydrateFile("fake.docx", undefined, "fullname"),
        (err: unknown) => {
          assert.ok(err instanceof RE, "muss RehydrateError sein");
          const msg = (err as Error).message;
          // Kein Dateiinhalt, kein Pfad mit Klarnamen
          assert.ok(!REAL_NAMES.some((n) => msg.includes(n)), "keine Klarnamen in Fehlermeldung");
          return true;
        }
      );
    } finally {
      // Env-Var immer wiederherstellen – auch bei Assertion-Fehler
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

    const result = rehydrateFile("check-privacy.md", undefined, "fullname");

    const resultJson = JSON.stringify(result);
    for (const name of REAL_NAMES) {
      assert.ok(
        !resultJson.includes(name),
        `Klarname "${name}" darf NICHT im Rückgabe-JSON stehen`
      );
    }
    // schueler darf nur Pseudonyme enthalten
    for (const s of result.schueler) {
      assert.match(s, /^S-\d+$/, `"${s}" ist kein Pseudonym`);
    }
  });

  test("7 – .docx Ersetzung (übersprungen wenn Python/python-docx nicht verfügbar)", async () => {
    const pyCheck = spawnSync("python3", ["--version"], { encoding: "utf-8" });
    if (pyCheck.status !== 0 || pyCheck.error) return;

    const docxCheck = spawnSync("python3", ["-c", "import docx"], { encoding: "utf-8" });
    if (docxCheck.status !== 0) return;

    const { rehydrateFile } = await getModule();

    // Test-.docx via Python erstellen
    const docxPath = join(tmpBase, "test-input.docx");
    const createScript =
      `from docx import Document\n` +
      `import sys\n` +
      `doc = Document()\n` +
      `doc.add_paragraph("S-0001 hat die Aufgabe bestanden.")\n` +
      `doc.add_paragraph("S-0002 noch nicht.")\n` +
      `doc.save(sys.argv[1])\n`;

    const cr = spawnSync("python3", ["-c", createScript, docxPath], {
      encoding: "utf-8",
    });
    if (cr.status !== 0) return; // python-docx-Fehler → überspringen

    assert.ok(existsSync(docxPath), "Test-DOCX muss existieren");

    const result = rehydrateFile(
      join(tmpBase, "test-input.docx"),   // absoluter Pfad innerhalb Basis
      join(tmpBase, "test-output.docx"),
      "fullname"
    );

    assert.strictEqual(result.ok, true);
    assert.ok(result.pseudonyme_ersetzt >= 2, "mind. 2 Pseudonyme ersetzt");
    assert.ok(result.schueler.includes("S-0001"));
    assert.ok(result.schueler.includes("S-0002"));

    // Kein Klarname im JSON-Ergebnis
    const resultJson = JSON.stringify(result);
    for (const name of REAL_NAMES) {
      assert.ok(!resultJson.includes(name), `"${name}" darf nicht im Ergebnis stehen`);
    }

    // Dateiinhalt via Python prüfen
    const checkScript =
      `from docx import Document\n` +
      `import sys\n` +
      `doc = Document(sys.argv[1])\n` +
      `print(" ".join(p.text for p in doc.paragraphs))\n`;
    const cc = spawnSync("python3", ["-c", checkScript, join(tmpBase, "test-output.docx")], {
      encoding: "utf-8",
    });
    assert.ok(cc.stdout.includes("Erika Musterfrau"), "Klarname muss in .docx stehen");
    assert.ok(!cc.stdout.includes("S-0001"), "Pseudonym darf nicht mehr in .docx stehen");
  });
});
