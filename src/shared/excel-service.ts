import path from 'path';
import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';

export const REPORT_PATH = path.resolve(process.cwd(), 'data', 'Processing-Report.xlsx');

export const COL = {
  START_TIME:         1,
  END_TIME:           2,
  ELAPSED:            3,
  JOB_TITLE:          4,
  LOCATION:           5,
  JOB_DESCRIPTION:    6,
  TOTAL_APPLICATIONS: 7,
  KEYWORD_1:          8,
  KEYWORD_2:          9,
  KEYWORD_3:          10,
  KEYWORD_4:          11,
  AFTER_KW_FILTER:    12,
  AFTER_RESUME:       13,
  ERROR:              14,
  GENERAL_FILTER_REJECTS:   15,
  LABOURING_FILTER_REJECTS: 16,
  HEAVY_LABOURING_REJECTS:  17,
  EMPLOYMENT_DATE_REJECTS:  18,
};

function findLastWrittenRow(sheet: ExcelJS.Worksheet): number {
  let row = 2;
  while (
    sheet.getCell(row + 1, COL.JOB_TITLE).value != null &&
    sheet.getCell(row + 1, COL.JOB_TITLE).value !== ''
  ) {
    row++;
  }
  return row;
}

export async function appendToExcel(data: {
  startTime: DateTime;
  jobTitle: string;
  location: string;
  jobDescription: string;
  totalApplications: number;
  selectedKeywords?: string[];
  filteredCount?: number;
}): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(REPORT_PATH);

  const sheet = workbook.getWorksheet(1) ?? workbook.worksheets[0];

  let nextRow = 2;
  while (sheet.getCell(nextRow, COL.JOB_TITLE).value != null &&
         sheet.getCell(nextRow, COL.JOB_TITLE).value !== '') {
    nextRow++;
  }

  sheet.getCell(nextRow, COL.START_TIME).value        = data.startTime.toFormat('dd/MM/yyyy HH:mm:ss');
  sheet.getCell(nextRow, COL.JOB_TITLE).value         = data.jobTitle;
  sheet.getCell(nextRow, COL.LOCATION).value          = data.location;
  sheet.getCell(nextRow, COL.JOB_DESCRIPTION).value   = data.jobDescription;
  sheet.getCell(nextRow, COL.TOTAL_APPLICATIONS).value = data.totalApplications;

  const kwCols = [COL.KEYWORD_1, COL.KEYWORD_2, COL.KEYWORD_3, COL.KEYWORD_4];
  (data.selectedKeywords ?? []).forEach((kw, i) => {
    if (i < kwCols.length) sheet.getCell(nextRow, kwCols[i]).value = kw;
  });

  if (data.filteredCount !== undefined) {
    sheet.getCell(nextRow, COL.AFTER_KW_FILTER).value = data.filteredCount;
  }

  await workbook.xlsx.writeFile(REPORT_PATH);
  console.log(`[ExcelService] Processing-Report.xlsx — wrote row ${nextRow}.`);
}

export async function markAdvertSkipped(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(REPORT_PATH);
  const sheet = workbook.getWorksheet(1) ?? workbook.worksheets[0];
  const row = findLastWrittenRow(sheet);
  sheet.getCell(row, COL.END_TIME).value = 'SKIPPED (NO FILTERED CANDIDATES)';
  sheet.getCell(row, COL.ELAPSED).value = 'SKIPPED (NO FILTERED CANDIDATES)';
  await workbook.xlsx.writeFile(REPORT_PATH);
}

export async function finaliseAdvertRow(data: {
  endTime: DateTime;
  elapsedStr: string;
  passCount: number;
  generalFilterRejects: number;
  labouringFilterRejects: number;
  heavyLabouringRejects: number;
  employmentDateRejects: number;
}): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(REPORT_PATH);
  const sheet = workbook.getWorksheet(1) ?? workbook.worksheets[0];
  const row = findLastWrittenRow(sheet);
  sheet.getCell(row, COL.END_TIME).value = data.endTime.toISO();
  sheet.getCell(row, COL.ELAPSED).value = data.elapsedStr;
  sheet.getCell(row, COL.AFTER_RESUME).value = data.passCount;
  sheet.getCell(row, COL.ERROR).value = 'no errors';
  sheet.getCell(row, COL.GENERAL_FILTER_REJECTS).value = data.generalFilterRejects;
  sheet.getCell(row, COL.LABOURING_FILTER_REJECTS).value = data.labouringFilterRejects;
  sheet.getCell(row, COL.HEAVY_LABOURING_REJECTS).value = data.heavyLabouringRejects;
  sheet.getCell(row, COL.EMPLOYMENT_DATE_REJECTS).value = data.employmentDateRejects;
  await workbook.xlsx.writeFile(REPORT_PATH);
}

export async function writeAdvertError(errorMessage: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(REPORT_PATH);
  const sheet = workbook.getWorksheet(1) ?? workbook.worksheets[0];
  const row = findLastWrittenRow(sheet);
  sheet.getCell(row, COL.ERROR).value = errorMessage;
  await workbook.xlsx.writeFile(REPORT_PATH);
}
