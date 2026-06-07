#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { harvestIdentities, redactResult, resolveStudent, REDACT_PII } from "./redact.js";

const MOODLE_URL = (process.env.MOODLE_URL ?? "").replace(/\/$/, "");
const MOODLE_TOKEN = process.env.MOODLE_TOKEN ?? "";

// ---------------------------------------------------------------------------
// Moodle REST API helper
// ---------------------------------------------------------------------------

function flattenParams(
  params: Record<string, unknown>,
  prefix = ""
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          Object.assign(
            result,
            flattenParams(item as Record<string, unknown>, `${fullKey}[${index}]`)
          );
        } else {
          result[`${fullKey}[${index}]`] = String(item);
        }
      });
    } else if (typeof value === "object" && value !== null) {
      Object.assign(result, flattenParams(value as Record<string, unknown>, fullKey));
    } else if (value !== undefined && value !== null) {
      result[fullKey] = String(value);
    }
  }
  return result;
}

async function moodleCall(
  wsfunction: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!MOODLE_URL || !MOODLE_TOKEN) {
    throw new Error(
      "Umgebungsvariablen MOODLE_URL und MOODLE_TOKEN müssen gesetzt sein."
    );
  }

  const body = new URLSearchParams({
    wstoken: MOODLE_TOKEN,
    wsfunction,
    moodlewsrestformat: "json",
    ...flattenParams(params),
  });

  const response = await fetch(`${MOODLE_URL}/webservice/rest/server.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  if (data && typeof data === "object" && "exception" in data) {
    const err = data as { errorcode?: string; message?: string };
    throw new Error(`Moodle-Fehler [${err.errorcode ?? "?"}]: ${err.message ?? "Unbekannter Fehler"}`);
  }
  // Personen-Identitäten aus der Rohantwort lernen (für die Pseudonymisierung),
  // bevor die Daten weiterverarbeitet und an das Modell zurückgegeben werden.
  if (REDACT_PII) harvestIdentities(data);
  return data;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "moodle-agent-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Tool-Definitionen
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "moodle_get_user_groups",
      description:
        "Gibt alle Gruppen zurück, in denen ein Nutzer Mitglied ist – kursübergreifend (Kurs-Gruppen) und global (Kohorten/System-Gruppen). Kurs-Gruppen werden aus allen eingeschriebenen Kursen gesammelt; Kohorten werden direkt über die Kohorten-API abgefragt.",
      inputSchema: {
        type: "object",
        properties: {
          userid: { type: "number", description: "Benutzer-ID" },
          include_cohorts: {
            type: "boolean",
            description: "true = auch globale Kohorten abfragen (Standard: true)",
          },
        },
        required: ["userid"],
      },
    },
    {
      name: "moodle_get_course_info",
      description:
        "Gibt Metadaten eines oder mehrerer Kurse zurück: Titel, Kurztitel, Beschreibung, Kategorie, Start-/Enddatum, Sichtbarkeit, Format und Anzahl Abschnitte. Ideal als erster Schritt um Kursinformationen im Kontext zu haben.",
      inputSchema: {
        type: "object",
        properties: {
          courseids: {
            type: "array",
            items: { type: "number" },
            description: "Liste von Kurs-IDs. Leer lassen um ALLE Kurse abzurufen.",
          },
          field: {
            type: "string",
            enum: ["id", "ids", "shortname", "idnumber", "category"],
            description: "Suchfeld (Standard: 'id'). Mit 'ids' können mehrere IDs übergeben werden.",
          },
        },
        required: [],
      },
    },
    {
      name: "moodle_get_enrolled_students",
      description:
        "Gibt alle im Kurs eingeschriebenen Nutzer zurück (id, Name, E-Mail, Rollen). Nützlich um userids für andere Tools zu ermitteln.",
      inputSchema: {
        type: "object",
        properties: {
          courseid: { type: "number", description: "Kurs-ID (steht in der URL: ?id=XX)" },
        },
        required: ["courseid"],
      },
    },
    {
      name: "moodle_get_activity_completion",
      description:
        "Gibt den Aktivitätsabschluss-Status für einen Kurs zurück. Zeigt welche Aktivitäten ein Schüler abgeschlossen hat. Ohne userid werden ALLE eingeschriebenen Schüler abgefragt.",
      inputSchema: {
        type: "object",
        properties: {
          courseid: { type: "number", description: "Kurs-ID" },
          userid: {
            type: "number",
            description: "Benutzer-ID (optional – ohne = alle Schüler des Kurses)",
          },
        },
        required: ["courseid"],
      },
    },
    {
      name: "moodle_get_assignment_submissions",
      description:
        "Gibt alle Abgaben zu einer oder mehreren Moodle-Aufgaben (mod_assign) zurück inkl. Status, Abgabedatum und Dateiinfos.",
      inputSchema: {
        type: "object",
        properties: {
          assignmentids: {
            type: "array",
            items: { type: "number" },
            description: "Liste der Aufgaben-IDs (instance-ID der Aufgabe, nicht cmid)",
          },
          status: {
            type: "string",
            enum: ["", "draft", "submitted", "reopened"],
            description: "Filter nach Abgabe-Status (leer = alle)",
          },
        },
        required: ["assignmentids"],
      },
    },
    {
      name: "moodle_get_submission_details",
      description:
        "Gibt die vollständige Abgabe eines Schülers für eine Aufgabe zurück, inkl. vorhandener Bewertung und Feedback.",
      inputSchema: {
        type: "object",
        properties: {
          assignid: { type: "number", description: "Aufgaben-ID (instance-ID)" },
          userid: { type: "number", description: "Benutzer-ID des Schülers" },
        },
        required: ["assignid", "userid"],
      },
    },
    {
      name: "moodle_grade_assignment",
      description:
        "Benotet eine Aufgaben-Abgabe und speichert schriftliches Feedback. Die Note muss zur Bewertungsskala der Aufgabe passen (z.B. 0–100).",
      inputSchema: {
        type: "object",
        properties: {
          assignid: { type: "number", description: "Aufgaben-ID (instance-ID)" },
          userid: { type: "number", description: "Benutzer-ID des Schülers" },
          grade: {
            type: "number",
            description: "Note (gemäß Aufgaben-Skala, z.B. 0–100; -1 = keine Bewertung)",
          },
          feedback: {
            type: "string",
            description: "Textliches Feedback an den Schüler (HTML erlaubt)",
          },
          workflowstate: {
            type: "string",
            enum: ["", "released", "readyforreview", "inreview", "readyforrelease"],
            description:
              "'released' = sofort für Schüler sichtbar; leer = Standardverhalten",
          },
        },
        required: ["assignid", "userid", "grade", "feedback"],
      },
    },
    {
      name: "moodle_get_quiz_results",
      description:
        "Gibt Quiz-Ergebnisse zurück. Mit userid = Versuche eines Schülers; mit courseid (ohne userid) = beste Note aller Schüler im Kurs.",
      inputSchema: {
        type: "object",
        properties: {
          quizid: { type: "number", description: "Quiz-ID (instance-ID)" },
          userid: {
            type: "number",
            description: "Benutzer-ID (optional – für einzelnen Schüler)",
          },
          courseid: {
            type: "number",
            description:
              "Kurs-ID (optional – für beste Noten ALLER Schüler, wenn userid fehlt)",
          },
          status: {
            type: "string",
            enum: ["all", "finished", "unfinished"],
            description: "Filter nach Versuchs-Status (Standard: all)",
          },
        },
        required: ["quizid"],
      },
    },
    {
      name: "moodle_get_course_grades",
      description:
        "Gibt alle Noten eines Kurses aus dem Bewertungsbuch zurück. Optional für einen einzelnen Schüler, sonst für alle.",
      inputSchema: {
        type: "object",
        properties: {
          courseid: { type: "number", description: "Kurs-ID" },
          userid: {
            type: "number",
            description: "Benutzer-ID (optional – ohne = alle Schüler des Kurses)",
          },
        },
        required: ["courseid"],
      },
    },
    {
      name: "moodle_get_course_modules",
      description:
        "Gibt alle Kursaktivitäten und -materialien mit cmid, instance-ID, Typ (assign, quiz, page, …) und Abschlusskonfiguration zurück.",
      inputSchema: {
        type: "object",
        properties: {
          courseid: { type: "number", description: "Kurs-ID" },
          modtype: {
            type: "string",
            description:
              "Filter nach Modultyp, z.B. 'assign', 'quiz', 'page' (optional)",
          },
        },
        required: ["courseid"],
      },
    },
    {
      name: "moodle_get_assignment_feedback",
      description:
        "Liest das vorhandene Feedback und die Bewertung für eine Aufgabe eines Schülers aus.",
      inputSchema: {
        type: "object",
        properties: {
          assignid: { type: "number", description: "Aufgaben-ID (instance-ID)" },
          userid: { type: "number", description: "Benutzer-ID des Schülers" },
        },
        required: ["assignid", "userid"],
      },
    },
    {
      name: "moodle_send_message",
      description:
        "Sendet eine direkte Moodle-Mitteilung (Nachricht) an einen oder mehrere Schüler. Die Nachricht erscheint im Moodle-Postfach des Schülers.",
      inputSchema: {
        type: "object",
        properties: {
          userids: {
            type: "array",
            items: { type: "number" },
            description: "Liste der Empfänger-Benutzer-IDs",
          },
          message: {
            type: "string",
            description: "Nachrichtentext (HTML erlaubt)",
          },
          subject: {
            type: "string",
            description: "Betreff der Nachricht (optional, wird dem Text vorangestellt)",
          },
          format: {
            type: "number",
            enum: [0, 1, 2, 4],
            description: "Textformat: 0=Moodle, 1=HTML (Standard), 2=Plain-Text, 4=Markdown",
          },
        },
        required: ["userids", "message"],
      },
    },
    {
      name: "moodle_send_message_to_course",
      description:
        "Sendet eine direkte Moodle-Mitteilung an ALLE eingeschriebenen Schüler eines Kurses.",
      inputSchema: {
        type: "object",
        properties: {
          courseid: { type: "number", description: "Kurs-ID" },
          message: {
            type: "string",
            description: "Nachrichtentext (HTML erlaubt)",
          },
          subject: {
            type: "string",
            description: "Betreff (optional, wird dem Text vorangestellt)",
          },
          format: {
            type: "number",
            enum: [0, 1, 2, 4],
            description: "Textformat: 0=Moodle, 1=HTML (Standard), 2=Plain-Text, 4=Markdown",
          },
        },
        required: ["courseid", "message"],
      },
    },
    {
      name: "moodle_get_submission_content",
      description:
        "Liest den vollständigen Inhalt einer Schülerabgabe: Inline-Text (Online-Texteingabe) wird direkt zurückgegeben; hochgeladene Dateien werden mit authentifizierten Download-URLs gelistet. Erster Schritt bevor moodle_download_submission_file aufgerufen wird.",
      inputSchema: {
        type: "object",
        properties: {
          assignid: { type: "number", description: "Aufgaben-ID (instance-ID)" },
          userid: { type: "number", description: "Benutzer-ID des Schülers" },
        },
        required: ["assignid", "userid"],
      },
    },
    {
      name: "moodle_download_submission_file",
      description:
        "Lädt eine Datei aus einer Moodle-Abgabe herunter. Text/Code-Dateien werden als lesbarer Text zurückgegeben, Bilder als Bilddaten, PDFs als Base64. Die fileurl kommt aus moodle_get_submission_content.",
      inputSchema: {
        type: "object",
        properties: {
          fileurl: {
            type: "string",
            description: "Datei-URL aus moodle_get_submission_content (ohne Token)",
          },
          filename: {
            type: "string",
            description: "Dateiname (für MIME-Typ-Erkennung, optional)",
          },
        },
        required: ["fileurl"],
      },
    },
    {
      name: "moodle_get_messages",
      description:
        "Liest Nachrichten aus dem Moodle-Posteingang oder -Ausgang eines Nutzers. Gibt Absender, Empfänger, Text und Zeitstempel zurück. Ideal um Schülerantworten auf gesendete Mitteilungen zu lesen.",
      inputSchema: {
        type: "object",
        properties: {
          userid: {
            type: "number",
            description: "Benutzer-ID, deren Nachrichten gelesen werden (eigener Account oder Schüler-ID)",
          },
          type: {
            type: "string",
            enum: ["conversations", "notifications"],
            description: "'conversations' = Direktnachrichten (Standard), 'notifications' = Systemmeldungen",
          },
          direction: {
            type: "string",
            enum: ["received", "sent"],
            description: "'received' = Posteingang (Standard), 'sent' = gesendete Nachrichten",
          },
          read: {
            type: "boolean",
            description: "true = nur gelesene, false = nur ungelesene, weggelassen = alle",
          },
          limit: {
            type: "number",
            description: "Maximale Anzahl Nachrichten (Standard: 50)",
          },
          offset: {
            type: "number",
            description: "Offset für Pagination (Standard: 0)",
          },
        },
        required: ["userid"],
      },
    },
    {
      name: "moodle_get_conversations",
      description:
        "Listet alle Konversationen (Chat-Verläufe) eines Moodle-Nutzers auf, mit letzter Nachricht, Gesprächspartner und Anzahl ungelesener Nachrichten.",
      inputSchema: {
        type: "object",
        properties: {
          userid: {
            type: "number",
            description: "Benutzer-ID",
          },
          type: {
            type: "number",
            enum: [1, 2],
            description: "1 = Einzelgespräche (Standard), 2 = Gruppenkonversationen",
          },
          unread_only: {
            type: "boolean",
            description: "true = nur Konversationen mit ungelesenen Nachrichten",
          },
          limit: {
            type: "number",
            description: "Maximale Anzahl Konversationen (Standard: 20)",
          },
          offset: {
            type: "number",
            description: "Offset für Pagination (Standard: 0)",
          },
        },
        required: ["userid"],
      },
    },
    {
      name: "moodle_get_conversation_with_user",
      description:
        "Liest den kompletten Nachrichtenverlauf zwischen zwei Nutzern (z.B. Lehrer und Schüler). Gibt alle Nachrichten chronologisch zurück.",
      inputSchema: {
        type: "object",
        properties: {
          userid: {
            type: "number",
            description: "Eigene Benutzer-ID (Lehrer)",
          },
          otheruserid: {
            type: "number",
            description: "Benutzer-ID des Gesprächspartners (Schüler)",
          },
          limit: {
            type: "number",
            description: "Maximale Anzahl Nachrichten (Standard: 100)",
          },
          offset: {
            type: "number",
            description: "Offset für Pagination (Standard: 0)",
          },
        },
        required: ["userid", "otheruserid"],
      },
    },
    {
      name: "moodle_resolve_student",
      description:
        "Loest einen vom Nutzer genannten Schueler (Name, Namensteil, E-Mail oder Login) LOKAL zu userid + Pseudonym auf. Nutzt die vertrauliche lokale Zuordnung und gibt NUR die Treffer zurueck (userid + Pseudonym, KEINE Klarnamen, KEINE Gesamtliste). Immer aufrufen, wenn der Nutzer einen Schueler beim Namen nennt, um danach dessen userid fuer Noten/Abgaben/Nachrichten zu verwenden.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, Namensteil, E-Mail oder Login des Schuelers" },
          courseid: { type: "number", description: "Optional: Kurs-ID, um die Zuordnung vor dem Aufloesen sicher zu befuellen" },
        },
        required: ["query"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool-Handler
// ---------------------------------------------------------------------------

const handleToolCall = async (request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) => {
  const { name, arguments: rawArgs } = request.params;
  const args = rawArgs ?? {};

  try {
    switch (name) {
      // ------------------------------------------------------------------
      case "moodle_get_user_groups": {
        const userid = args.userid as number;
        const includeCohorts = args.include_cohorts !== false; // Standard: true

        // Kurs-Gruppen: core_enrol_get_enrolled_users gibt pro Nutzer
        // bereits ein 'groups'-Array zurück — keine separate Gruppen-API nötig.
        // Strategie: alle Kurse holen, pro Kurs enrolled_users abrufen,
        // den Zielnutzer finden und seine Gruppen extrahieren.
        const allCourses = (await moodleCall("core_course_get_courses", {})) as Array<{
          id: number;
          fullname: string;
          shortname: string;
        }>;

        type GroupEntry = {
          id: number;
          name: string;
          description: string;
          type: "course-group";
          courseid: number;
          coursename: string;
        };

        const courseGroups: GroupEntry[] = [];
        for (const course of allCourses.filter((c) => c.id !== 1)) {
          try {
            const users = (await moodleCall("core_enrol_get_enrolled_users", {
              courseid: course.id,
            })) as Array<{
              id: number;
              groups?: Array<{ id: number; name: string; description: string }>;
            }>;
            const targetUser = users.find((u) => u.id === userid);
            if (targetUser) {
              for (const g of targetUser.groups ?? []) {
                if (!courseGroups.find((x) => x.id === g.id)) {
                  courseGroups.push({
                    id: g.id,
                    name: g.name,
                    description: g.description?.replace(/<[^>]*>/g, "").trim() ?? "",
                    type: "course-group",
                    courseid: course.id,
                    coursename: course.fullname,
                  });
                }
              }
            }
          } catch {
            // Kurs ohne Zugriff – überspringen
          }
        }

        // 3. Globale Kohorten (System-Gruppen)
        type CohortEntry = {
          id: number;
          name: string;
          idnumber: string;
          description: string;
          type: "cohort";
          component: string;
        };

        const cohorts: CohortEntry[] = [];
        if (includeCohorts) {
          try {
            const result = (await moodleCall(
              "core_cohort_search_cohorts",
              {
                query: "",
                context: { contextlevel: "system", instanceid: 0 },
                includes: "all",
                limitfrom: 0,
                limitnum: 1000,
              }
            )) as { cohorts?: Array<{
              id: number;
              name: string;
              idnumber: string;
              description: string;
              component: string;
            }> };

            // Für jede Kohorte prüfen ob der Nutzer Mitglied ist
            for (const c of result.cohorts ?? []) {
              try {
                const members = (await moodleCall("core_cohort_get_cohort_members", {
                  cohortids: [c.id],
                })) as Array<{ cohortid: number; userids: number[] }>;
                const isMember = members[0]?.userids?.includes(userid);
                if (isMember) {
                  cohorts.push({
                    id: c.id,
                    name: c.name,
                    idnumber: c.idnumber,
                    description: c.description?.replace(/<[^>]*>/g, "").trim() ?? "",
                    type: "cohort",
                    component: c.component,
                  });
                }
              } catch {
                // Kohorte nicht zugänglich
              }
            }
          } catch {
            // Kohorten-API nicht verfügbar oder keine Berechtigung
          }
        }

        const total = courseGroups.length + cohorts.length;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  userid,
                  total_groups: total,
                  course_groups: courseGroups,
                  cohorts,
                  note: cohorts.length === 0 && includeCohorts
                    ? "Keine Kohorten gefunden oder Funktion 'core_cohort_search_cohorts'/'core_cohort_get_cohort_members' nicht im Moodle-Service aktiviert."
                    : undefined,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      case "moodle_get_course_info": {
        type CourseRaw = {
          id: number;
          fullname: string;
          shortname: string;
          idnumber: string;
          summary: string;
          summaryformat: number;
          format: string;
          startdate: number;
          enddate: number;
          visible: number;
          categoryid: number;
          categoryname?: string;
          numsections?: number;
          enrolledusercount?: number;
          completionnotify?: number;
          lang?: string;
          forcetheme?: string;
          courseformatoptions?: Array<{ name: string; value: unknown }>;
        };

        let courses: CourseRaw[];

        const courseids = args.courseids as number[] | undefined;

        if (courseids && courseids.length > 0) {
          // Konkrete IDs abrufen
          const result = (await moodleCall("core_course_get_courses", {
            options: { ids: courseids },
          })) as CourseRaw[];
          courses = result;
        } else {
          // Alle Kurse (ohne Filter)
          const result = (await moodleCall("core_course_get_courses", {})) as CourseRaw[];
          // Kurs 1 (Startseite) herausfiltern
          courses = result.filter((c) => c.id !== 1);
        }

        const mapped = courses.map((c) => ({
          id: c.id,
          fullname: c.fullname,
          shortname: c.shortname,
          idnumber: c.idnumber || null,
          summary: c.summary
            ? c.summary.replace(/<[^>]*>/g, "").trim().slice(0, 300) || null
            : null,
          format: c.format,
          categoryid: c.categoryid,
          startdate: c.startdate
            ? new Date(c.startdate * 1000).toISOString().slice(0, 10)
            : null,
          enddate: c.enddate && c.enddate > 0
            ? new Date(c.enddate * 1000).toISOString().slice(0, 10)
            : null,
          visible: c.visible === 1,
          lang: c.lang || null,
          numsections: c.numsections ?? null,
        }));

        return {
          content: [
            {
              type: "text",
              text: `${mapped.length} Kurs/Kurse gefunden:\n${JSON.stringify(mapped, null, 2)}`,
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      case "moodle_get_enrolled_students": {
        const data = (await moodleCall("core_enrol_get_enrolled_users", {
          courseid: args.courseid,
        })) as Array<Record<string, unknown>>;

        const students = data.map((u) => ({
          id: u.id,
          username: u.username,
          fullname: u.fullname,
          email: u.email,
          roles: Array.isArray(u.roles)
            ? (u.roles as Array<{ shortname: string }>).map((r) => r.shortname)
            : [],
        }));

        return { content: [{ type: "text", text: JSON.stringify(students, null, 2) }] };
      }

      // ------------------------------------------------------------------
      case "moodle_get_activity_completion": {
        if (args.userid !== undefined) {
          const data = await moodleCall(
            "core_completion_get_activities_completion_status",
            { courseid: args.courseid, userid: args.userid }
          );
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }

        // Alle eingeschriebenen Schüler abfragen
        const students = (await moodleCall("core_enrol_get_enrolled_users", {
          courseid: args.courseid,
        })) as Array<{ id: number; fullname: string; username: string }>;

        const results: unknown[] = [];
        for (const student of students) {
          try {
            const completion = (await moodleCall(
              "core_completion_get_activities_completion_status",
              { courseid: args.courseid, userid: student.id }
            )) as { statuses?: unknown[] };

            results.push({
              userid: student.id,
              fullname: student.fullname,
              username: student.username,
              completions: completion.statuses ?? [],
            });
          } catch (e) {
            results.push({
              userid: student.id,
              fullname: student.fullname,
              error: (e as Error).message,
            });
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      // ------------------------------------------------------------------
      case "moodle_get_assignment_submissions": {
        const params: Record<string, unknown> = {
          assignmentids: args.assignmentids,
        };
        if (args.status) params.status = args.status;

        const data = await moodleCall("mod_assign_get_submissions", params);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      // ------------------------------------------------------------------
      case "moodle_get_submission_details": {
        const [submissionsRaw, gradesRaw] = await Promise.all([
          moodleCall("mod_assign_get_submissions", {
            assignmentids: [args.assignid],
          }),
          moodleCall("mod_assign_get_grades", {
            assignmentids: [args.assignid],
          }),
        ]);

        type AssignData = {
          assignments?: Array<{
            submissions?: Array<{ userid: number } & Record<string, unknown>>;
            grades?: Array<{ userid: number } & Record<string, unknown>>;
          }>;
        };

        const submData = submissionsRaw as AssignData;
        const gradeData = gradesRaw as AssignData;

        const submission = submData.assignments?.[0]?.submissions?.find(
          (s) => s.userid === (args.userid as number)
        );
        const grade = gradeData.assignments?.[0]?.grades?.find(
          (g) => g.userid === (args.userid as number)
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ submission: submission ?? null, grade: grade ?? null }, null, 2),
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      case "moodle_grade_assignment": {
        await moodleCall("mod_assign_save_grade", {
          assignmentid: args.assignid,
          userid: args.userid,
          grade: args.grade,
          attemptnumber: -1,
          addattempt: 0,
          workflowstate: args.workflowstate ?? "",
          applytoall: 0,
          plugindata: {
            assignfeedbackcomments_editor: {
              text: args.feedback,
              format: 1, // HTML
            },
          },
        });

        return {
          content: [
            {
              type: "text",
              text: `✓ Bewertung gespeichert: Note ${args.grade} für Nutzer ${args.userid} (Aufgabe ${args.assignid})`,
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      case "moodle_get_quiz_results": {
        if (args.userid !== undefined) {
          // Einzelner Schüler – alle Versuche
          const data = await moodleCall("mod_quiz_get_user_attempts", {
            quizid: args.quizid,
            userid: args.userid,
            status: args.status ?? "all",
            includepreviews: 0,
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }

        if (args.courseid !== undefined) {
          // Alle Schüler – beste Note
          const students = (await moodleCall("core_enrol_get_enrolled_users", {
            courseid: args.courseid,
          })) as Array<{ id: number; fullname: string; username: string }>;

          const results: unknown[] = [];
          for (const student of students) {
            try {
              const best = await moodleCall("mod_quiz_get_user_best_grade", {
                quizid: args.quizid,
                userid: student.id,
              });
              results.push({
                userid: student.id,
                fullname: student.fullname,
                username: student.username,
                bestgrade: best,
              });
            } catch (e) {
              results.push({
                userid: student.id,
                fullname: student.fullname,
                error: (e as Error).message,
              });
            }
          }
          return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        }

        throw new Error(
          "Entweder 'userid' (einzelner Schüler) oder 'courseid' (alle Schüler) muss angegeben werden."
        );
      }

      // ------------------------------------------------------------------
      case "moodle_get_course_grades": {
        if (args.userid !== undefined) {
          const data = await moodleCall("gradereport_user_get_grade_items", {
            courseid: args.courseid,
            userid: args.userid,
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }

        const students = (await moodleCall("core_enrol_get_enrolled_users", {
          courseid: args.courseid,
        })) as Array<{ id: number; fullname: string; username: string }>;

        const results: unknown[] = [];
        for (const student of students) {
          try {
            const grades = (await moodleCall("gradereport_user_get_grade_items", {
              courseid: args.courseid,
              userid: student.id,
            })) as { usergrades?: Array<{ gradeitems?: unknown[] }> };

            results.push({
              userid: student.id,
              fullname: student.fullname,
              username: student.username,
              gradeitems: grades.usergrades?.[0]?.gradeitems ?? [],
            });
          } catch (e) {
            results.push({
              userid: student.id,
              fullname: student.fullname,
              error: (e as Error).message,
            });
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      // ------------------------------------------------------------------
      case "moodle_get_course_modules": {
        const data = (await moodleCall("core_course_get_contents", {
          courseid: args.courseid,
        })) as Array<{
          section: number;
          name: string;
          modules?: Array<Record<string, unknown>>;
        }>;

        const modules: unknown[] = [];
        for (const section of data) {
          for (const mod of section.modules ?? []) {
            const entry = {
              cmid: mod.id,
              instance: mod.instance,
              name: mod.name,
              modname: mod.modname,
              section: section.section,
              sectionname: section.name,
              visible: mod.visible,
              completion: mod.completion,
              completiondata: mod.completiondata,
              url: mod.url,
            };
            if (!args.modtype || mod.modname === args.modtype) {
              modules.push(entry);
            }
          }
        }

        return { content: [{ type: "text", text: JSON.stringify(modules, null, 2) }] };
      }

      // ------------------------------------------------------------------
      case "moodle_get_assignment_feedback": {
        const gradesRaw = (await moodleCall("mod_assign_get_grades", {
          assignmentids: [args.assignid],
        })) as {
          assignments?: Array<{
            grades?: Array<{
              userid: number;
              grade: string;
              timemodified: number;
              grader: number;
              plugins?: Array<{
                type: string;
                name: string;
                fileareas?: Array<{
                  area: string;
                  files?: unknown[];
                }>;
                editorfields?: Array<{
                  name: string;
                  text: string;
                }>;
              }>;
            }>;
          }>;
        };

        const gradeEntry = gradesRaw.assignments?.[0]?.grades?.find(
          (g) => g.userid === (args.userid as number)
        );

        if (!gradeEntry) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { message: "Keine Bewertung für diesen Schüler gefunden.", userid: args.userid },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const feedback = {
          userid: gradeEntry.userid,
          grade: gradeEntry.grade,
          timemodified: gradeEntry.timemodified,
          grader: gradeEntry.grader,
          comments: gradeEntry.plugins
            ?.find((p) => p.type === "comments")
            ?.editorfields?.find((f) => f.name === "comments")?.text ?? null,
        };

        return { content: [{ type: "text", text: JSON.stringify(feedback, null, 2) }] };
      }

      // ------------------------------------------------------------------
      case "moodle_get_submission_content": {
        const submRaw = (await moodleCall("mod_assign_get_submissions", {
          assignmentids: [args.assignid],
        })) as {
          assignments?: Array<{
            submissions?: Array<{
              userid: number;
              status: string;
              timemodified: number;
              attemptnumber: number;
              plugins?: Array<{
                type: string;
                editorfields?: Array<{ name: string; text: string; format: number }>;
                fileareas?: Array<{
                  area: string;
                  files?: Array<{
                    filename: string;
                    filesize: number;
                    fileurl: string;
                    timemodified: number;
                    mimetype?: string;
                  }>;
                }>;
              }>;
            }>;
          }>;
        };

        const submission = submRaw.assignments?.[0]?.submissions?.find(
          (s) => s.userid === (args.userid as number)
        );

        if (!submission) {
          return {
            content: [{ type: "text", text: `Keine Abgabe für Nutzer ${args.userid} gefunden.` }],
          };
        }

        // Inline-Text extrahieren (onlinetext-Plugin)
        const textPlugin = submission.plugins?.find((p) => p.type === "onlinetext");
        const inlineText =
          textPlugin?.editorfields?.find((f) => f.name === "onlinetext")?.text ?? null;

        // Dateiliste extrahieren (file-Plugin)
        const filePlugin = submission.plugins?.find((p) => p.type === "file");
        const rawFiles =
          filePlugin?.fileareas?.find((a) => a.area === "submission_files")?.files ?? [];

        // Authentifizierte Download-URLs erzeugen
        const files = rawFiles.map((f) => ({
          filename: f.filename,
          filesize: f.filesize,
          mimetype: f.mimetype ?? "application/octet-stream",
          timemodified: f.timemodified,
          fileurl: f.fileurl,
          downloadurl: `${f.fileurl}?token=${MOODLE_TOKEN}`,
        }));

        const result = {
          userid: submission.userid,
          status: submission.status,
          timemodified: submission.timemodified,
          attemptnumber: submission.attemptnumber,
          inlinetext: inlineText,
          files,
          hint:
            files.length > 0
              ? "Nutze moodle_download_submission_file mit der 'fileurl' um Dateien zu lesen."
              : undefined,
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ------------------------------------------------------------------
      case "moodle_download_submission_file": {
        const fileUrl = args.fileurl as string;
        const filename = (args.filename as string | undefined) ?? fileUrl.split("/").pop() ?? "";

        // Token anfügen falls noch nicht vorhanden
        const authedUrl = fileUrl.includes("token=")
          ? fileUrl
          : `${fileUrl}?token=${MOODLE_TOKEN}`;

        const response = await fetch(authedUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} beim Laden von ${filename}`);
        }

        const contentType =
          response.headers.get("content-type") ?? "application/octet-stream";
        const mimeBase = contentType.split(";")[0].trim().toLowerCase();

        // --- Text / Code-Dateien ---
        const textMimes = new Set([
          "text/plain", "text/html", "text/css", "text/javascript",
          "text/csv", "text/xml", "text/markdown",
          "application/json", "application/xml", "application/javascript",
          "application/x-httpd-php",
        ]);
        const textExtensions = new Set([
          "txt", "md", "html", "htm", "css", "js", "ts", "jsx", "tsx",
          "py", "java", "c", "cpp", "h", "cs", "php", "rb", "go",
          "json", "xml", "yaml", "yml", "csv", "sql", "sh", "bat",
          "rs", "swift", "kt", "r", "m", "vue", "svelte",
        ]);
        const ext = filename.split(".").pop()?.toLowerCase() ?? "";

        if (textMimes.has(mimeBase) || textExtensions.has(ext)) {
          const text = await response.text();
          return {
            content: [
              {
                type: "text",
                text: `=== ${filename} (${mimeBase}, ${text.length} Zeichen) ===\n\n${text}`,
              },
            ],
          };
        }

        // --- Bilder ---
        const imageMimes = new Set([
          "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
        ]);
        if (imageMimes.has(mimeBase)) {
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          return {
            content: [
              {
                type: "image",
                data: base64,
                mimeType: mimeBase as string,
              },
            ],
          };
        }

        // --- PDFs ---
        if (mimeBase === "application/pdf" || ext === "pdf") {
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          // MCP embedded resource für PDFs
          return {
            content: [
              {
                type: "text",
                text: `PDF-Datei: ${filename} (${buffer.byteLength} Bytes)\nBase64-kodiert für den PDF-Viewer:\n${base64}`,
              },
            ],
          };
        }

        // --- Sonstige Binärdateien ---
        const buffer = await response.arrayBuffer();
        return {
          content: [
            {
              type: "text",
              text: [
                `Datei: ${filename}`,
                `MIME-Typ: ${mimeBase}`,
                `Größe: ${buffer.byteLength} Bytes`,
                `Direkt-Download-URL (mit Token): ${authedUrl}`,
                "",
                "Diese Datei kann nicht automatisch angezeigt werden.",
                "Öffne die Download-URL im Browser oder lade sie manuell herunter.",
              ].join("\n"),
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      case "moodle_get_messages": {
        // Moodle 4.x: Direktnachrichten sind nur über die Konversations-API
        // zuverlässig abrufbar. core_message_get_messages liefert in neueren
        // Versionen keine Ergebnisse mehr für Direktnachrichten.
        const convParams: Record<string, unknown> = {
          userid: args.userid,
          type: 1, // 1 = Einzelgespräche
          limitfrom: (args.offset as number | undefined) ?? 0,
          limitnum: (args.limit as number | undefined) ?? 50,
        };

        const convData = (await moodleCall(
          "core_message_get_conversations",
          convParams
        )) as {
          conversations?: Array<{
            id: number;
            name: string;
            type: number;
            membercount: number;
            isread: boolean;
            unreadcount?: number;
            messages?: Array<{
              useridfrom: number;
              text: string;
              timecreated: number;
            }>;
            members?: Array<{ id: number; fullname: string }>;
          }>;
        };

        let conversations = convData.conversations ?? [];

        // Filter: nur ungelesene wenn read: false übergeben
        if (args.read === false) {
          conversations = conversations.filter((c) => (c.unreadcount ?? 0) > 0);
        } else if (args.read === true) {
          conversations = conversations.filter((c) => c.isread);
        }

        // direction: 'received' → Konversationen mit eingehender letzter Nachricht
        // d.h. letzte Nachricht stammt NICHT von uns selbst
        const direction = (args.direction as string | undefined) ?? "received";
        if (direction === "received") {
          conversations = conversations.filter((c) => {
            const lastMsg = c.messages?.[0];
            return lastMsg && lastMsg.useridfrom !== (args.userid as number);
          });
        }

        const result = conversations.map((c) => ({
          conversationid: c.id,
          partner: c.members
            ?.filter((m) => m.id !== (args.userid as number))
            .map((m) => ({ id: m.id, fullname: m.fullname })),
          unreadcount: c.unreadcount ?? 0,
          isread: c.isread,
          lastmessage: c.messages?.[0]
            ? {
                from: c.messages[0].useridfrom,
                text: c.messages[0].text,
                date: new Date(c.messages[0].timecreated * 1000).toISOString(),
              }
            : null,
        }));

        return {
          content: [
            {
              type: "text",
              text: `${result.length} Konversation(en) mit ${direction === "received" ? "eingegangenen" : "allen"} Nachrichten:\n${JSON.stringify(result, null, 2)}`,
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      case "moodle_get_conversations": {
        const params: Record<string, unknown> = {
          userid: args.userid,
          limitfrom: (args.offset as number | undefined) ?? 0,
          limitnum: (args.limit as number | undefined) ?? 20,
        };
        if (args.type !== undefined) params.type = args.type;
        if (args.unread_only) params.favourites = 0; // Moodle-API-Flag

        const data = (await moodleCall("core_message_get_conversations", params)) as {
          conversations?: Array<{
            id: number;
            type: number;
            name: string;
            membercount: number;
            isread: boolean;
            unreadcount?: number;
            messages?: Array<{
              useridfrom: number;
              text: string;
              timecreated: number;
            }>;
            members?: Array<{
              id: number;
              fullname: string;
            }>;
          }>;
        };

        const conversations = (data.conversations ?? [])
          .filter((c) => !args.unread_only || (c.unreadcount ?? 0) > 0)
          .map((c) => ({
            id: c.id,
            type: c.type === 1 ? "Einzelgespräch" : "Gruppe",
            name: c.name,
            members: (c.members ?? []).map((m) => ({ id: m.id, fullname: m.fullname })),
            unreadcount: c.unreadcount ?? 0,
            isread: c.isread,
            lastmessage: c.messages?.[0]
              ? {
                  from: c.messages[0].useridfrom,
                  text: c.messages[0].text,
                  date: new Date(c.messages[0].timecreated * 1000).toISOString(),
                }
              : null,
          }));

        return {
          content: [
            {
              type: "text",
              text: `${conversations.length} Konversation(en):\n${JSON.stringify(conversations, null, 2)}`,
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      case "moodle_get_conversation_with_user": {
        // Zuerst Konversations-ID zwischen den zwei Nutzern ermitteln
        const convData = (await moodleCall(
          "core_message_get_conversation_between_users",
          {
            userid: args.userid,
            otheruserid: args.otheruserid,
            includecontactrequests: 0,
            includeprivacyinfo: 0,
          }
        )) as { id?: number } | null;

        if (!convData || !convData.id) {
          return {
            content: [
              {
                type: "text",
                text: `Keine Konversation zwischen Nutzer ${args.userid} und ${args.otheruserid} gefunden.`,
              },
            ],
          };
        }

        // Nachrichten der Konversation laden
        const msgData = (await moodleCall(
          "core_message_get_conversation_messages",
          {
            currentuserid: args.userid,
            convid: convData.id,
            limitfrom: (args.offset as number | undefined) ?? 0,
            limitnum: (args.limit as number | undefined) ?? 100,
            newest: 0, // älteste zuerst = chronologisch
          }
        )) as {
          messages?: Array<{
            id: number;
            useridfrom: number;
            text: string;
            timecreated: number;
          }>;
          members?: Array<{ id: number; fullname: string }>;
        };

        const memberMap = new Map(
          (msgData.members ?? []).map((m) => [m.id, m.fullname])
        );

        const messages = (msgData.messages ?? []).map((m) => ({
          id: m.id,
          from: m.useridfrom,
          fromName: memberMap.get(m.useridfrom) ?? `Nutzer ${m.useridfrom}`,
          text: m.text,
          date: new Date(m.timecreated * 1000).toISOString(),
        }));

        return {
          content: [
            {
              type: "text",
              text: `Konversation (ID ${convData.id}) – ${messages.length} Nachricht(en):\n${JSON.stringify(messages, null, 2)}`,
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      case "moodle_send_message": {
        const textFormat = (args.format as number | undefined) ?? 1;
        const subject = args.subject as string | undefined;

        const buildText = (msg: string) =>
          subject ? `<strong>${subject}</strong><br>${msg}` : msg;

        const messages = (args.userids as number[]).map((uid, index) => ({
          touserid: uid,
          text: buildText(args.message as string),
          textformat: textFormat,
          clientmsgid: `msg-${Date.now()}-${index}`,
        }));

        const results = (await moodleCall(
          "core_message_send_instant_messages",
          { messages }
        )) as Array<{ msgid: number; clientmsgid: string; errormessage?: string }>;

        const summary = results.map((r, i) => ({
          userid: (args.userids as number[])[i],
          msgid: r.msgid,
          success: !r.errormessage,
          error: r.errormessage ?? null,
        }));

        const sent = summary.filter((s) => s.success).length;
        return {
          content: [
            {
              type: "text",
              text: `${sent}/${summary.length} Nachrichten erfolgreich gesendet.\n${JSON.stringify(summary, null, 2)}`,
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      case "moodle_send_message_to_course": {
        const textFormat = (args.format as number | undefined) ?? 1;
        const subject = args.subject as string | undefined;

        const buildText = (msg: string) =>
          subject ? `<strong>${subject}</strong><br>${msg}` : msg;

        // Alle Schüler des Kurses laden
        const students = (await moodleCall("core_enrol_get_enrolled_users", {
          courseid: args.courseid,
        })) as Array<{ id: number; fullname: string; roles?: Array<{ shortname: string }> }>;

        if (students.length === 0) {
          return {
            content: [{ type: "text", text: "Keine Schüler im Kurs gefunden." }],
          };
        }

        // In Batches à 50 senden (Moodle-Limit)
        const BATCH = 50;
        const allResults: Array<{ userid: number; fullname: string; success: boolean; error: string | null }> = [];

        for (let i = 0; i < students.length; i += BATCH) {
          const batch = students.slice(i, i + BATCH);
          const messages = batch.map((s, j) => ({
            touserid: s.id,
            text: buildText(args.message as string),
            textformat: textFormat,
            clientmsgid: `bulk-${Date.now()}-${i + j}`,
          }));

          const results = (await moodleCall(
            "core_message_send_instant_messages",
            { messages }
          )) as Array<{ msgid: number; errormessage?: string }>;

          results.forEach((r, j) => {
            allResults.push({
              userid: batch[j].id,
              fullname: batch[j].fullname,
              success: !r.errormessage,
              error: r.errormessage ?? null,
            });
          });
        }

        const sent = allResults.filter((r) => r.success).length;
        const failed = allResults.filter((r) => !r.success);

        return {
          content: [
            {
              type: "text",
              text:
                `${sent}/${allResults.length} Nachrichten gesendet.` +
                (failed.length > 0
                  ? `\n\nFehlgeschlagen:\n${JSON.stringify(failed, null, 2)}`
                  : ""),
            },
          ],
        };
      }

      // ------------------------------------------------------------------
      // ------------------------------------------------------------------
      case "moodle_resolve_student": {
        // Optional Roster laden, damit die lokale Zuordnung sicher gefuellt ist
        if (args.courseid !== undefined) {
          try {
            await moodleCall("core_enrol_get_enrolled_users", { courseid: args.courseid });
          } catch {
            // ignorieren - dann nur aus vorhandener Zuordnung aufloesen
          }
        }
        const matches = resolveStudent(String(args.query ?? ""));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ query: args.query ?? "", matches }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unbekanntes Tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Fehler: ${(error as Error).message}` }],
      isError: true,
    };
  }
};

// Zentraler Pseudonymisierungs-Punkt: Jedes Tool-Ergebnis durchläuft die
// Redaktion, bevor es den Server (und damit die lokale Umgebung) verlässt.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await handleToolCall(request);
  return redactResult(result);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
