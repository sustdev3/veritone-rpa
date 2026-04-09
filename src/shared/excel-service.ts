import path from 'path';
import ExcelJS from 'exceljs';

export const REPORT_PATH = path.resolve(process.cwd(), 'data', 'Processing-Report.xlsx');

export const COL = {
  DATE_POSTED:         1,
  JOB_REF_NUMBER:      2,
  JOB_TITLE:           3,
  LOCATION:            4,
  KEYWORDS_USED:       5,
  TOTAL_APPLICATIONS:  6,
  AFTER_KW_FILTER:     7,
  PASSING_CANDIDATES:  8,
};

export async function appendToExcel(data: {
  datePosted: string;
  refNumber: string;
  jobTitle: string;
  location: string;
  keywordsUsed: string;
  totalApplications: number;
  filteredCount: number;
  passingCandidatesCount: number;
}): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(REPORT_PATH);

  const sheet = workbook.getWorksheet(1) ?? workbook.worksheets[0];

  let nextRow = 2;
  while (
    sheet.getCell(nextRow, COL.JOB_TITLE).value != null &&
    sheet.getCell(nextRow, COL.JOB_TITLE).value !== ''
  ) {
    nextRow++;
  }

  sheet.getCell(nextRow, COL.DATE_POSTED).value        = data.datePosted;
  sheet.getCell(nextRow, COL.JOB_REF_NUMBER).value     = data.refNumber;
  sheet.getCell(nextRow, COL.JOB_TITLE).value          = data.jobTitle;
  sheet.getCell(nextRow, COL.LOCATION).value           = data.location;
  sheet.getCell(nextRow, COL.KEYWORDS_USED).value      = data.keywordsUsed;
  sheet.getCell(nextRow, COL.TOTAL_APPLICATIONS).value = data.totalApplications;
  sheet.getCell(nextRow, COL.AFTER_KW_FILTER).value    = data.filteredCount;
  sheet.getCell(nextRow, COL.PASSING_CANDIDATES).value = data.passingCandidatesCount;

  await workbook.xlsx.writeFile(REPORT_PATH);
  console.log(`[ExcelService] Processing-Report.xlsx — wrote row ${nextRow}.`);
}
