/**
 * Opening Bell API smoke tests — file-existence checks only.
 *
 * These verify that all expected files were created during the Opening Bell
 * feature implementation. They are intentionally simple: no network calls,
 * no database, no mocked services.
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(ROOT, relativePath));
}

describe("Opening Bell — file existence smoke tests", () => {
  it("opening-bell page exists", () => {
    expect(exists("src/app/opening-bell/page.tsx")).toBe(true);
  });

  it("opening-bell list API route exists", () => {
    expect(exists("src/app/api/opening-bell/route.ts")).toBe(true);
  });

  it("opening-bell detail API route exists", () => {
    expect(exists("src/app/api/opening-bell/[id]/route.ts")).toBe(true);
  });

  it("opening-bell XLSX report route exists", () => {
    expect(
      exists("src/app/api/reports/opening-bell/[id]/xlsx/route.ts")
    ).toBe(true);
  });

  it("opening-bell cron route exists", () => {
    expect(exists("src/app/api/cron/opening-bell/route.ts")).toBe(true);
  });

  it("opening-bell email module exists", () => {
    expect(exists("src/lib/email/opening-bell-email.ts")).toBe(true);
  });

  it("OpeningBellCard component exists", () => {
    expect(exists("src/components/opening-bell/OpeningBellCard.tsx")).toBe(
      true
    );
  });
});
