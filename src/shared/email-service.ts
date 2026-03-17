import nodemailer from "nodemailer";
import { DateTime } from "luxon";
import { buildRunSummaryHtml } from "../templates/run-summary-email";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

export interface AdvertRunResult {
  advertTitle: string;
  status: "success" | "skipped" | "error";
  errorMessage?: string;
  elapsedStr?: string;
  location?: string;
  selectedKeywords?: string[];
  totalApplications?: number;
  filteredCount?: number;
  unflaggedForReview?: number;
  generalFilterRejects?: number;
  labouringFilterRejects?: number;
  heavyLabouringRejects?: number;
  employmentDateRejects?: number;
  civilLabourerRejects?: number;
  productionWorkerRejects?: number;
  passCount?: number;
  skippedPreviouslyPassed?: number;
  skippedReason?: string;
  passingCandidateNames?: string[];
}

export async function sendRunSummaryEmail(
  results: AdvertRunResult[],
): Promise<void> {
  const timestamp = DateTime.now()
    .setZone("Australia/Sydney")
    .toFormat("dd/MM/yyyy HH:mm");

  const successCount = results.filter((r) => r.status === "success").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  const errorCount = results.filter((r) => r.status === "error").length;

  const html = buildRunSummaryHtml(results, timestamp);

  try {
    await transporter.sendMail({
      from: "Veritone RPA <sustdev3@gmail.com>",
      to: [
        "sustdev3@gmail.com",
        "bruce@8020green.com",
      ],
      subject: `Veritone RPA — Run Complete [${timestamp}]`,
      html,
    });
    console.log(
      `[EmailService] Run summary email sent (${successCount} success, ${skippedCount} skipped, ${errorCount} errors).`,
    );
  } catch (err) {
    console.warn(
      `[EmailService] WARNING: Failed to send run summary email: ${err}`,
    );
  }
}

export async function sendErrorReportEmail(
  errorMessage: string,
  advertTitle?: string,
): Promise<void> {
  const timestamp = DateTime.now().toFormat("dd/MM/yyyy HH:mm");

  const body = [
    `Advert: ${advertTitle ?? "unknown"}`,
    `Error: ${errorMessage}`,
    "Action required: check logs for details.",
  ].join("\n");

  try {
    await transporter.sendMail({
      from: "Veritone RPA <sustdev3@gmail.com>",
      to: [
        "sustdev3@gmail.com",
        "bruce@8020green.com",
      ],
      subject: `Veritone RPA — ERROR [${timestamp}]`,
      text: body,
    });
    console.log(`[EmailService] Error report email sent.`);
  } catch (err) {
    console.warn(
      `[EmailService] WARNING: Failed to send error report email: ${err}`,
    );
  }
}
