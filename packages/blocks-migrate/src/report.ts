/**
 * What a migration did and what it left for a person: every step adds to one
 * report, which the command prints at the end.
 */
export type Step = "content" | "secrets" | "block map" | "vendor" | "imports" | "scripts";

export interface Note {
  step: Step;
  /** What the note is about: a type name, a file, an import specifier. */
  subject: string;
  message: string;
}

export interface Report {
  /** Changes the migration made. */
  done: Note[];
  /** Work left for a person: nothing was changed for these. */
  manual: Note[];
}

export function createReport(): Report {
  return { done: [], manual: [] };
}

function section(title: string, notes: Note[]): string[] {
  if (notes.length === 0) return [];
  const lines = [`${title} (${notes.length})`];
  for (const step of new Set(notes.map((n) => n.step))) {
    lines.push(`  ${step}`);
    for (const n of notes.filter((n) => n.step === step)) {
      lines.push(`    ${n.subject}: ${n.message}`);
    }
  }
  return lines;
}

export function formatReport(report: Report): string {
  const lines = [...section("Done", report.done), ...section("Left to do", report.manual)];
  return lines.length > 0 ? lines.join("\n") : "Nothing to migrate.";
}
