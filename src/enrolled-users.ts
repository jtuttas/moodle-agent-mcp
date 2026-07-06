// ---------------------------------------------------------------------------
// enrolled-users.ts – Auswertung der core_enrol_get_enrolled_users-Antwort
// ---------------------------------------------------------------------------
//
// Moodle liefert pro eingeschriebenem Nutzer ein `roles`-Array. Jeder Eintrag
// hat die Felder { roleid, name, shortname, sortorder } (KEIN contextid – siehe
// enrol/externallib.php:get_enrolled_users_returns).
//
// WICHTIG – bewusst KEINE Heuristik:
//   Diese Funktion leitet Rollen ausschliesslich aus den von Moodle pro Nutzer
//   gelieferten `roles[].shortname`-Werten ab. Es gibt keinerlei Fallback, der
//   aus anderen Feldern (z. B. Enrolment, Name, Reihenfolge) eine Rolle wie
//   "trainer" ableitet. Was Moodle meldet, wird 1:1 uebernommen.
//
// KONTEXT-Semantik (Ursache fuer scheinbar falsche "trainer"-Tags):
//   core_enrol_get_enrolled_users nutzt user_get_user_details() ->
//   get_user_roles($coursecontext, $userid, /*checkparentcontexts*/ false).
//   Es werden also die im KURS-Kontext zugewiesenen Rollen gemeldet. Hat ein
//   Nutzer im Kurs-Kontext (ggf. versehentlich oder als Altlast) eine
//   Lehrer-/Trainer-Rolle zugewiesen, erscheint diese hier – auch wenn die
//   Teilnehmerliste in der Moodle-Oberflaeche sie nicht (mehr) anzeigt.
//   Das ist dann eine Daten-Auffaelligkeit in Moodle, kein Fehler dieser
//   Auswertung: die Rolle muss in Moodle selbst entfernt werden.
//
// Robustheit:
//   - Nicht-Objekt-Eintraege und Eintraege ohne string-`shortname` werden
//     ignoriert (statt `undefined`/leer ins Ergebnis zu schreiben).
//   - Leere/whitespace-only Kurznamen werden verworfen.
//   - Duplikate (mehrere role-Eintraege mit gleichem shortname, z. B. durch
//     doppelte roleid-Zuweisungen) werden zu genau einem Eintrag zusammengefasst
//     – unter Beibehaltung der von Moodle gelieferten Reihenfolge.
// ---------------------------------------------------------------------------

/** Ein Rollen-Eintrag, wie ihn core_enrol_get_enrolled_users liefert. */
export interface MoodleRole {
  roleid?: number;
  name?: string;
  shortname?: string;
  sortorder?: number;
}

/** Ein eingeschriebener Nutzer aus core_enrol_get_enrolled_users (Teilmenge). */
export interface EnrolledUser {
  id?: number;
  username?: unknown;
  fullname?: unknown;
  email?: unknown;
  roles?: unknown;
}

/**
 * Extrahiert die Rollen-Kurznamen eines Nutzers exakt so, wie Moodle sie im
 * Kurs-Kontext meldet – dedupliziert, ohne leere Werte, ohne Heuristik.
 */
export function roleShortnames(user: Pick<EnrolledUser, "roles">): string[] {
  if (!Array.isArray(user.roles)) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const entry of user.roles) {
    if (!entry || typeof entry !== "object") continue;
    const shortname = (entry as MoodleRole).shortname;
    if (typeof shortname !== "string") continue;
    const value = shortname.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}

/** Baut das an das Modell zurueckgegebene Nutzer-Objekt (roles pro Nutzer). */
export function mapEnrolledUser(user: EnrolledUser): {
  id: unknown;
  username: unknown;
  fullname: unknown;
  email: unknown;
  roles: string[];
} {
  return {
    id: user.id,
    username: user.username,
    fullname: user.fullname,
    email: user.email,
    roles: roleShortnames(user),
  };
}
