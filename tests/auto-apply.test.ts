import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { classifyChallenge } from "../lib/auto-apply/challenges";
import { writeBase64Pdf } from "../lib/auto-apply/files";
import { isLeverUrl, parseApplyPayload } from "../lib/auto-apply/validation";

const minimalPdfBase64 = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n").toString("base64");

test("validates Lever URLs only", () => {
  assert.equal(isLeverUrl("https://jobs.lever.co/acme/123"), true);
  assert.equal(isLeverUrl("https://acme.lever.co/apply"), true);
  assert.equal(isLeverUrl("https://example.com/acme/123"), false);
  assert.equal(isLeverUrl("file:///tmp/cv.pdf"), false);
});

test("parses the expected apply payload", () => {
  const payload = parseApplyPayload({
    jobUrl: "https://jobs.lever.co/acme/123",
    cv: {
      filename: "ada.pdf",
      base64: minimalPdfBase64,
      mimeType: "application/pdf",
    },
    options: {
      dryRun: true,
      ollamaModel: "llama3.1",
    },
  });

  assert.equal(payload.jobUrl, "https://jobs.lever.co/acme/123");
  assert.equal(payload.options?.dryRun, true);
});

test("decodes a base64 PDF into a temp file", async () => {
  const pdfPath = await writeBase64Pdf("test-run", "cv.pdf", minimalPdfBase64);
  const bytes = await readFile(pdfPath);

  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
});

test("classifies challenge and rate-limit pages", () => {
  assert.equal(
    classifyChallenge({
      url: "https://jobs.lever.co/acme/123",
      title: "One more step",
      html: "<div class='g-recaptcha'></div>",
    })?.reason,
    "captcha_required",
  );

  assert.equal(
    classifyChallenge({
      url: "https://jobs.lever.co/acme/123",
      title: "Too Many Requests",
      html: "Please slow down.",
      status: 429,
    })?.reason,
    "rate_limited",
  );

  assert.equal(
    classifyChallenge({
      url: "https://jobs.lever.co/acme/123",
      title: "Software Engineer",
      html: "<form><input name='email' /></form>",
    }),
    null,
  );
});
