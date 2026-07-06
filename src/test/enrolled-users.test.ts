/**
 * Unit-Tests für src/enrolled-users.ts
 *
 * Hintergrund (Bug-Report Kurs 3775):
 *   moodle_get_enrolled_students meldete einen reinen Teilnehmer als "trainer".
 *   Untersuchung ergab: core_enrol_get_enrolled_users liefert die Rollen aus dem
 *   KURS-Kontext (get_user_roles(..., checkparentcontexts=false)). Der betroffene
 *   Nutzer hatte im Kurs-Kontext eine (Altlast-/versehentliche) trainer-Rolle
 *   zugewiesen – Moodle meldet sie, das Tool gibt sie 1:1 weiter. Es gibt KEINE
 *   Heuristik, die "trainer" erfindet.
 *
 * Diese Tests sichern ab:
 *   1. Saubere Zuordnung pro Nutzer (Lehrer vs. Teilnehmer) – keine Vermischung.
 *   2. Reproduktion der 3775-Antwort: die Rollen werden exakt so uebernommen,
 *      wie Moodle sie liefert (Teilnehmer bekommt genau das, was in roles[] steht).
 *   3. Robustheit: Duplikate zusammenfassen, leere/fehlende shortnames verwerfen.
 *
 * Keine echten Schülerdaten – nur nachgebaute API-Antworten.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  roleShortnames,
  mapEnrolledUser,
  EnrolledUser,
} from "../enrolled-users.js";

describe("roleShortnames – Rollen pro Nutzer, ohne Heuristik", () => {
  test("1 – saubere Zuordnung: Lehrer und Teilnehmer werden nicht vermischt", () => {
    // Nachgebaute, „gesunde“ Antwort: ein echter Lehrer, ein reiner Teilnehmer.
    const response: EnrolledUser[] = [
      {
        id: 100,
        username: "teacher1",
        fullname: "Teacher One",
        email: "teacher@example.test",
        roles: [
          { roleid: 3, name: "Lehrer", shortname: "editingteacher", sortorder: 0 },
          { roleid: 5, name: "Teilnehmer", shortname: "student", sortorder: 1 },
        ],
      },
      {
        id: 200,
        username: "student1",
        fullname: "Student One",
        email: "student@example.test",
        roles: [{ roleid: 5, name: "Teilnehmer", shortname: "student", sortorder: 0 }],
      },
    ];

    const mapped = response.map(mapEnrolledUser);

    assert.deepEqual(mapped[0].roles, ["editingteacher", "student"]);
    // Kernaussage: der reine Teilnehmer bekommt NUR "student" – nie "trainer".
    assert.deepEqual(mapped[1].roles, ["student"]);
  });

  test("2 – Reproduktion Kurs 3775: Rollen werden 1:1 aus Moodle uebernommen", () => {
    // Der 3775-Antwort nachempfunden: Nutzer B hat im KURS-Kontext eine
    // (Altlast-)trainer-Rolle -> Moodle meldet ["trainer"]. Das Tool erfindet
    // nichts, sondern gibt exakt das gelieferte roles[] zurueck.
    const response: EnrolledUser[] = [
      {
        id: 3865,
        username: "jtuttas",
        fullname: "Dr. Jörg Tuttas",
        email: "lehrer@example.test",
        roles: [
          { roleid: 4, name: "Trainer/in", shortname: "trainer", sortorder: 0 },
          { roleid: 5, name: "Teilnehmer/in", shortname: "teilnehmer", sortorder: 1 },
        ],
      },
      {
        id: 18081,
        username: "testtest",
        fullname: "test test",
        email: "test@test.de",
        // Genau das liefert Moodle für diesen Nutzer im Kurs 3775.
        roles: [{ roleid: 4, name: "Trainer/in", shortname: "trainer", sortorder: 0 }],
      },
    ];

    const mapped = response.map(mapEnrolledUser);

    assert.deepEqual(mapped[0].roles, ["trainer", "teilnehmer"]);
    // Nutzer B erscheint als "trainer", WEIL Moodle das so meldet (Kurs-Kontext-
    // Rollenzuweisung). Der Fix liegt in Moodle (Rollenzuweisung entfernen),
    // nicht in einer Heuristik hier. Der Test dokumentiert die faithful-Weitergabe.
    assert.deepEqual(mapped[1].roles, ["trainer"]);
  });

  test("3 – Duplikate (gleicher shortname / roleid) werden zusammengefasst", () => {
    const user: EnrolledUser = {
      id: 1,
      roles: [
        { roleid: 5, shortname: "student", sortorder: 0 },
        { roleid: 5, shortname: "student", sortorder: 0 }, // Duplikat
        { roleid: 3, shortname: "editingteacher", sortorder: 1 },
      ],
    };
    assert.deepEqual(roleShortnames(user), ["student", "editingteacher"]);
  });

  test("4 – leere/whitespace/fehlende shortnames werden verworfen", () => {
    const user: EnrolledUser = {
      id: 2,
      roles: [
        { roleid: 5, shortname: "student", sortorder: 0 },
        { roleid: 6, shortname: "   ", sortorder: 1 }, // leer -> ignorieren
        { roleid: 7, name: "ohne shortname", sortorder: 2 } as any, // kein shortname
        "kaputt" as any, // kein Objekt
        null as any,
      ],
    };
    assert.deepEqual(roleShortnames(user), ["student"]);
  });

  test("5 – fehlendes/ungültiges roles-Feld ergibt leeres Array", () => {
    assert.deepEqual(roleShortnames({ roles: undefined }), []);
    assert.deepEqual(roleShortnames({ roles: null as any }), []);
    assert.deepEqual(roleShortnames({ roles: "nope" as any }), []);
    assert.deepEqual(roleShortnames({}), []);
  });

  test("6 – Reihenfolge von Moodle bleibt erhalten", () => {
    const user: EnrolledUser = {
      id: 3,
      roles: [
        { roleid: 1, shortname: "manager", sortorder: 0 },
        { roleid: 4, shortname: "trainer", sortorder: 1 },
        { roleid: 5, shortname: "teilnehmer", sortorder: 2 },
      ],
    };
    assert.deepEqual(roleShortnames(user), ["manager", "trainer", "teilnehmer"]);
  });
});
