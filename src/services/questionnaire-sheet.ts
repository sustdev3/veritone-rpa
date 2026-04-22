import { google } from "googleapis";

async function getAuthenticatedSheets() {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!serviceAccountEmail || !privateKey || !sheetId) {
    throw new Error("Missing Google Sheets env vars: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID");
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: "service_account",
      private_key: privateKey.replace(/\\n/g, "\n"),
      client_email: serviceAccountEmail,
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return { sheets: google.sheets({ version: "v4", auth }), sheetId };
}

// Returns a map of "adrefNo|datePosted" -> cumulative answered count.
// Summary tab columns: A=adrefNo, B=advertTitle, C=datePosted (YYYY-MM-DD), D=totalAnswered
export async function getAnsweredCounts(): Promise<Map<string, number>> {
  const { sheets, sheetId } = await getAuthenticatedSheets();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Summary!A2:D",
  });

  const counts = new Map<string, number>();

  for (const row of response.data.values || []) {
    const adrefNo = (row[0] || "").trim();
    const datePosted = (row[2] || "").trim();
    const count = parseInt(row[3] || "0", 10);
    if (adrefNo && datePosted) counts.set(`${adrefNo}|${datePosted}`, count);
  }

  return counts;
}
