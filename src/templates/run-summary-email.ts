import { AdvertRunResult, AdvertListEntry } from '../shared/email-service';

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function buildRunSummaryHtml(
  results: AdvertRunResult[],
  allAdverts: AdvertListEntry[],
  runDate: string,
): string {
  const successCount = results.filter((r) => r.status === 'success').length;
  const skippedCount = results.filter((r) => r.status === 'skipped').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  const sorted = [...results].sort((a, b) => {
    if (!a.datePostedIso && !b.datePostedIso) return 0;
    if (!a.datePostedIso) return 1;
    if (!b.datePostedIso) return -1;
    return b.datePostedIso.localeCompare(a.datePostedIso);
  });

  const th = (label: string) =>
    `<th style="padding:9px 10px;background:#2c3e50;color:#fff;font-size:11px;font-weight:bold;text-align:left;white-space:nowrap;">${label}</th>`;

  const cell = (val: string | number | undefined | null) =>
    `<td style="padding:8px 10px;border-bottom:1px solid #e8e8e8;font-size:12px;vertical-align:top;">${val ?? '—'}</td>`;

  const processedRows = sorted.map((r, i) => {
    const bg = i % 2 === 0 ? '#f9f9f9' : '#ffffff';
    return `<tr style="background:${bg};">
      ${cell(formatDate(r.datePostedIso))}
      ${cell(r.refNumber)}
      ${cell(r.advertTitle)}
      ${cell(r.location)}
      ${cell(r.selectedKeywords?.join(', '))}
      ${cell(r.totalApplications)}
      ${cell(r.filteredCount)}
      ${cell(r.passCount ?? 0)}
      ${cell(r.answeredQuestionsCount)}
    </tr>`;
  }).join('');

  const allAdvertsSorted = [...allAdverts].sort((a, b) =>
    b.datePostedIso.localeCompare(a.datePostedIso),
  );

  const allAdvertItems = allAdvertsSorted.map((a) =>
    `<li style="padding:5px 0;border-bottom:1px solid #f0f0f0;font-size:12px;">
      <strong>${a.jobTitle}</strong> &mdash; ${a.location} &mdash; Ref: ${a.refNumber || '—'} &mdash; ${formatDate(a.datePostedIso)} &mdash; ${a.totalResponses} applicants
    </li>`,
  ).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:20px;background:#f5f5f5;font-family:Arial,sans-serif;font-size:13px;color:#333;">
  <div style="max-width:1100px;margin:0 auto;">
    <div style="background:#2c3e50;color:#fff;padding:20px 24px;border-radius:4px 4px 0 0;">
      <h1 style="margin:0;font-size:18px;font-weight:normal;">Veritone RPA — Run Summary</h1>
      <p style="margin:6px 0 0;font-size:12px;opacity:0.8;">${runDate}</p>
    </div>
    <div style="background:#fff;padding:14px 24px;border-bottom:1px solid #e0e0e0;">
      <span style="margin-right:20px;">&#10003; <strong>${successCount}</strong> processed</span>
      <span style="margin-right:20px;">&#9888; <strong>${skippedCount}</strong> skipped</span>
      <span>&#10007; <strong>${errorCount}</strong> errors</span>
    </div>
    <div style="background:#fff;padding:16px 24px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            ${th('Date job posted')}
            ${th('Job ref number')}
            ${th('Job title')}
            ${th('Location')}
            ${th('Key words used')}
            ${th('Total number of applicants')}
            ${th('Number of applicants after location and keyword check')}
            ${th('Number of passing candidates (unranked - grey flags)')}
            ${th('Number of applicants who answered questions')}
          </tr>
        </thead>
        <tbody>
          ${processedRows}
        </tbody>
      </table>
    </div>
    <div style="background:#fff;padding:16px 24px;border-top:2px solid #e0e0e0;border-radius:0 0 4px 4px;">
      <h2 style="margin:0 0 12px;font-size:14px;color:#2c3e50;">All job adverts posted in the last ${process.env.LOOKBACK_DAYS ?? '30'} days</h2>
      <ul style="margin:0;padding:0;list-style:none;">
        ${allAdvertItems}
      </ul>
    </div>
  </div>
</body>
</html>`;
}
