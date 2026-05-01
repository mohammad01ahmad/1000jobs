import { randomUUID } from "node:crypto";
import { runLeverAutoApply } from "@/lib/auto-apply/agent";
import { buildErrorResult, extractApplicantFromPdf, readApplyPayload } from "@/lib/auto-apply/applicant-extractor";
import { createRunDirectory, writeBase64Pdf } from "@/lib/auto-apply/files";
import { createRunLogger } from "@/lib/auto-apply/logger";
import type { Applicant } from "@/lib/auto-apply/types";

// Force node runtime to run this API endpoint.
export const runtime = "nodejs";

export async function POST(request: Request) {
  const runId = randomUUID();
  const runDirectory = await createRunDirectory(runId);
  const logger = createRunLogger(runId, runDirectory);

  try {
    logger.info("request.received", "Parsing /api/apply payload.");
    const payload = await readApplyPayload(request);
    logger.info("payload.validated", payload.jobUrl);

    const pdfPath = await writeBase64Pdf(runId, payload.cv.filename, payload.cv.base64);
    logger.info("pdf.decoded", payload.cv.filename);
    const applicant: Applicant = await extractApplicantFromPdf(
      pdfPath,
      payload.options?.ollamaModel ?? process.env.OLLAMA_MODEL ?? "llama3.1",
    ).catch((error: unknown) => {
      logger.warn(
        "applicant.extraction_failed",
        error instanceof Error ? error.message : "Could not extract text from the PDF.",
      );
      return {};
    });
    logger.info(
      "applicant.extracted",
      [applicant.email ? "email" : "", applicant.phone ? "phone" : "", applicant.firstName ? "name" : ""]
        .filter(Boolean)
        .join(", ") || "No structured fields detected; CV text will still be used as context.",
    );

    const result = await runLeverAutoApply({
      payload: { ...payload, applicant },
      pdfPath,
      logger,
      runDirectory,
    });

    return Response.json(result, { status: result.status === "failed" ? 422 : 200 });
  } catch (error) {
    const result = buildErrorResult(runId, logger.logPath, logger.steps, error);
    logger.error(result.reason ?? "unexpected_error", result.reason === "invalid_payload" ? "Invalid request payload." : result.reason);

    return Response.json(result, { status: result.reason === "invalid_payload" ? 400 : 500 });
  }
}
