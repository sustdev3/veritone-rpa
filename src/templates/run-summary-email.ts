import { AdvertRunResult } from '../shared/email-service';

export function buildRunSummaryHtml(results: AdvertRunResult[], runDate: string): string {
  const successCount = results.filter((r) => r.status === 'success').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  const advertSections = results.map((r) => buildAdvertSection(r)).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:20px;background:#f5f5f5;font-family:Arial,sans-serif;font-size:13px;color:#333;">
  <div style="max-width:700px;margin:0 auto;">
    <div style="background:#2c3e50;color:#fff;padding:20px 24px;border-radius:4px 4px 0 0;">
      <h1 style="margin:0;font-size:18px;font-weight:normal;">Veritone RPA — Run Summary</h1>
      <p style="margin:6px 0 0;font-size:12px;opacity:0.8;">${runDate}</p>
    </div>
    <div style="background:#fff;padding:14px 24px;border-bottom:1px solid #e0e0e0;">
      <span style="margin-right:20px;">&#10003; <strong>${successCount}</strong> processed</span>
      <span style="margin-right:20px;">&#9888; <strong>${skippedCount}</strong> skipped</span>
      <span>&#10007; <strong>${errorCount}</strong> errors</span>
    </div>
    ${advertSections}
  </div>
</body>
</html>`;
}

function tableRow(label: string, value: string | number | undefined | null, index: number): string {
  if (value === undefined || value === null || value === '') return '';
  const bg = index % 2 === 0 ? '#f9f9f9' : '#ffffff';
  return `<tr>
    <td style="padding:7px 12px;background:${bg};color:#666;width:195px;font-size:12px;vertical-align:top;">${label}</td>
    <td style="padding:7px 12px;background:${bg};font-size:13px;vertical-align:top;">${value}</td>
  </tr>`;
}

function buildAdvertSection(r: AdvertRunResult): string {
  const borderColor =
    r.status === 'success' ? '#27ae60' :
    r.status === 'skipped' ? '#f39c12' :
    '#e74c3c';

  const statusLabel =
    r.status === 'success' ? '&#10003; Success' :
    r.status === 'skipped' ? '&#9888; Skipped' :
    '&#10007; Error';

  const rows: string[] = [];
  let i = 0;

  rows.push(tableRow('Status', statusLabel, i++));
  if (r.location) rows.push(tableRow('Location', r.location, i++));
  if (r.elapsedStr) rows.push(tableRow('Elapsed Time', r.elapsedStr, i++));
  if (r.selectedKeywords?.length) rows.push(tableRow('Keywords Used', r.selectedKeywords.join(', '), i++));
  if (r.totalApplications !== undefined) rows.push(tableRow('Total Applicants', r.totalApplications, i++));
  if (r.filteredCount !== undefined) rows.push(tableRow('After KW Filter', r.filteredCount, i++));
  if (r.unflaggedForReview !== undefined) rows.push(tableRow('For AI Review', r.unflaggedForReview, i++));
  if (r.generalFilterRejects !== undefined) rows.push(tableRow('General Rejects', r.generalFilterRejects, i++));
  if (r.labouringFilterRejects !== undefined) rows.push(tableRow('Labouring Rejects', r.labouringFilterRejects, i++));
  if (r.heavyLabouringRejects !== undefined) rows.push(tableRow('Heavy Labour Rejects', r.heavyLabouringRejects, i++));
  if (r.employmentDateRejects !== undefined) rows.push(tableRow('Employ. Date Rejects', r.employmentDateRejects, i++));
  if (r.passCount !== undefined) rows.push(tableRow('Passed AI Review', r.passCount, i++));
  if (r.skippedPreviouslyPassed !== undefined && r.skippedPreviouslyPassed > 0) {
    rows.push(tableRow('Prev Run Skipped', r.skippedPreviouslyPassed, i++));
  }
  if (r.skippedReason) rows.push(tableRow('Skip Reason', r.skippedReason, i++));
  if (r.errorMessage) rows.push(tableRow('Error', r.errorMessage, i++));

  const passingNamesHtml =
    r.passingCandidateNames && r.passingCandidateNames.length > 0
      ? `<div style="padding:10px 16px 14px;border-top:1px solid #eee;">
          <p style="margin:0 0 8px;font-size:12px;color:#555;font-weight:bold;">Passing Candidates (${r.passingCandidateNames.length}):</p>
          <ul style="margin:0;padding-left:18px;">
            ${r.passingCandidateNames.map((name) => `<li style="font-size:13px;margin-bottom:3px;">${name}</li>`).join('')}
          </ul>
        </div>`
      : '';

  return `<div style="margin-top:16px;border-left:4px solid ${borderColor};background:#fff;border-radius:0 4px 4px 0;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
  <div style="padding:10px 16px;background:#fafafa;border-bottom:1px solid #eee;">
    <strong style="font-size:14px;">${r.advertTitle}</strong>
  </div>
  <table style="width:100%;border-collapse:collapse;">
    ${rows.join('')}
  </table>
  ${passingNamesHtml}
</div>`;
}
