import { google } from "googleapis";

const DRY_RUN = process.env.DRY_RUN === "true";
const CUTOFF_DAYS = parseInt(process.env.CLEANUP_CUTOFF_DAYS ?? "14", 10);
const TERMINAL = new Set(["TRUE", "ERROR", "SKIPPED", "OUTSIDE WINDOW"]);

function statusPriority(status: string): number {
  const s = status.toUpperCase().trim();
  if (s === "") return 0;
  if (s === "1" || s === "2") return 1;
  return 2; // TRUE / ERROR / SKIPPED / OUTSIDE WINDOW
}

async function getWriteableSheets() {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!serviceAccountEmail || !privateKey || !sheetId) {
    throw new Error(
      "Missing Google Sheets env vars: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID",
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: "service_account",
      private_key: privateKey.replace(/\\n/g, "\n"),
      client_email: serviceAccountEmail,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return { sheets: google.sheets({ version: "v4", auth }), sheetId };
}

async function getSheet1IntId(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
): Promise<number> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets ?? []).find(
    (s) => s.properties?.title === "Sheet1",
  );
  if (sheet?.properties?.sheetId == null) {
    throw new Error("Sheet1 not found in spreadsheet");
  }
  return sheet.properties.sheetId;
}

export async function runCleanup(): Promise<void> {
  if (DRY_RUN) console.log("[Cleanup] DRY RUN — no changes will be made");
  console.log(`[Cleanup] Starting — cutoff: ${CUTOFF_DAYS} days`);

  const { sheets, sheetId } = await getWriteableSheets();
  const sheet1IntId = await getSheet1IntId(sheets, sheetId);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Sheet1!A:P",
  });
  const allRows = res.data.values ?? [];
  if (allRows.length <= 1) {
    console.log("[Cleanup] Sheet1 has no data rows — nothing to do");
    return;
  }

  const cutoffMs = Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000;
  const toDeleteIndices: number[] = []; // 0-based sheet row indices (header = 0)
  const toKeepRows: string[][] = [];

  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i] as string[];
    const tsRaw = (row[0] || "").trim();
    const status = (row[14] || "").toUpperCase().trim();
    const tsMs = tsRaw ? new Date(tsRaw).getTime() : NaN;

    if (TERMINAL.has(status) && !isNaN(tsMs) && tsMs < cutoffMs) {
      toDeleteIndices.push(i);
    } else {
      toKeepRows.push(row);
    }
  }

  console.log(
    `[Cleanup] ${toDeleteIndices.length} rows to delete, ${toKeepRows.length} rows to keep`,
  );

  if (toDeleteIndices.length === 0) {
    console.log("[Cleanup] No rows qualify for deletion — done");
    return;
  }

  // Tally advertIds from rows about to be deleted and add to CountsBaseline,
  // so mergeAnsweredSummary() can accumulate correctly after rows are gone.
  const deletedCounts = new Map<string, number>();
  for (const idx of toDeleteIndices) {
    const advertId = ((allRows[idx] as string[])[15] || "").trim(); // col P
    if (advertId) deletedCounts.set(advertId, (deletedCounts.get(advertId) ?? 0) + 1);
  }

  if (deletedCounts.size > 0) {
    const baselineRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "CountsBaseline!A2:B",
    });
    const baseline = new Map<string, number>();
    for (const row of baselineRes.data.values || []) {
      const advertId = (row[0] || "").trim();
      const count = parseInt(row[1], 10) || 0;
      if (advertId) baseline.set(advertId, count);
    }
    for (const [advertId, count] of deletedCounts) {
      baseline.set(advertId, (baseline.get(advertId) ?? 0) + count);
    }
    const baselineRows = Array.from(baseline.entries()).map(([id, n]) => [id, n]);

    if (!DRY_RUN) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: sheetId,
        range: "CountsBaseline!A2:B",
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: "CountsBaseline!A2",
        valueInputOption: "RAW",
        requestBody: { values: baselineRows },
      });
      console.log(`[Cleanup] CountsBaseline updated — ${baseline.size} advertId(s)`);
    } else {
      console.log(`[DRY RUN] Would update CountsBaseline for ${deletedCounts.size} advertId(s)`);
    }
  }

  // Delete in descending order so row indices don't shift mid-batch
  toDeleteIndices.sort((a, b) => b - a);

  if (!DRY_RUN) {
    const deleteRequests = toDeleteIndices.map((idx) => ({
      deleteDimension: {
        range: {
          sheetId: sheet1IntId,
          dimension: "ROWS",
          startIndex: idx,
          endIndex: idx + 1,
        },
      },
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: deleteRequests },
    });

    console.log(`[Cleanup] Deleted ${deleteRequests.length} rows`);
  } else {
    console.log(
      `[DRY RUN] Would delete 0-based row indices: ${toDeleteIndices.join(", ")}`,
    );
  }

  // Sort remaining rows: unprocessed first, retries next, terminal last; timestamp asc within each group
  toKeepRows.sort((a, b) => {
    const pa = statusPriority(a[14] || "");
    const pb = statusPriority(b[14] || "");
    if (pa !== pb) return pa - pb;
    const ta = new Date(a[0] || "").getTime() || 0;
    const tb = new Date(b[0] || "").getTime() || 0;
    return ta - tb;
  });

  if (!DRY_RUN) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: sheetId,
      range: "Sheet1!A2:P",
    });

    if (toKeepRows.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: "Sheet1!A2",
        valueInputOption: "RAW",
        requestBody: { values: toKeepRows },
      });
    }

    console.log(
      `[Cleanup] Complete — ${toDeleteIndices.length} deleted, ${toKeepRows.length} remain`,
    );
  } else {
    console.log("[DRY RUN] Sorted keep-rows (first 5):");
    toKeepRows
      .slice(0, 5)
      .forEach((r, i) =>
        console.log(`  [${i}] ts=${r[0]} status=${r[14] || "(empty)"} email=${r[1]}`),
      );
    console.log(`[DRY RUN] Would write ${toKeepRows.length} sorted rows back to Sheet1`);
  }
}
