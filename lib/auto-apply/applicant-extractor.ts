import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { ZodError } from "zod";
import { parseApplyPayload } from "@/lib/auto-apply/validation";
import { extractApplicantWithOllama } from "@/lib/auto-apply/ollama";
import type { Applicant, ApplyPayload, ApplyResult } from "@/lib/auto-apply/types";

PDFParse.setWorker(path.join(process.cwd(), "node_modules/pdf-parse/dist/pdf-parse/cjs/pdf.worker.mjs"));

// Read and Confirm apply payload from request.
export async function readApplyPayload(request: Request): Promise<ApplyPayload> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const jobUrl = formData.get("jobUrl");
    const file = formData.get("cv") ?? formData.get("pdf") ?? formData.get("file");

    if (typeof jobUrl !== "string" || !(file instanceof File)) {
      return parseApplyPayload({});
    }

    return parseApplyPayload({
      jobUrl,
      cv: {
        filename: file.name,
        base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
        mimeType: file.type || "application/pdf",
      },
      options: readOptions(formData),
    });
  }

  return parseApplyPayload(await request.json());
}

// Extract applicant information from PDF.
export async function extractApplicantFromPdf(pdfPath: string, model = process.env.OLLAMA_MODEL ?? "llama3.1"): Promise<Applicant> {
  const data = await readFile(pdfPath);
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getText({ first: 3 });
    const text = normalizeText(result.text);
    const name = extractName(text);
    const urlBuckets = extractUrlBuckets(text);
    const extracted = await extractApplicantWithOllama({
      pdfText: text.slice(0, 3000),
      model,
    }).catch(() => ({}));

    return buildApplicantProfile({
      text,
      name,
      extracted,
      urlBuckets,
    });
  } finally {
    await parser.destroy();
  }
}

export function readOptions(formData: FormData) {
  const rawOptions = formData.get("options");

  if (typeof rawOptions === "string" && rawOptions.trim()) {
    try {
      return JSON.parse(rawOptions) as unknown;
    } catch {
      return {};
    }
  }

  return {
    dryRun: formData.get("dryRun") === null ? undefined : formData.get("dryRun") !== "false",
    ollamaModel: formData.get("ollamaModel") || undefined,
  };
}

export function buildErrorResult(
  runId: string,
  logPath: string,
  steps: ApplyResult["steps"],
  error: unknown,
): ApplyResult {
  if (error instanceof ZodError) {
    return {
      runId,
      status: "failed",
      dryRun: true,
      jobUrl: "",
      submitted: false,
      reason: "invalid_payload",
      artifacts: { logPath },
      steps,
    };
  }

  return {
    runId,
    status: "failed",
    dryRun: true,
    jobUrl: "",
    submitted: false,
    reason: "unexpected_error",
    artifacts: { logPath },
    steps,
  };
}

function normalizeText(text: string) {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractName(text: string): Pick<Applicant, "firstName" | "lastName"> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);

  const candidate = lines.find((line) => {
    if (line.length > 80 || /@|http|www\.|resume|curriculum|vitae|\d/iu.test(line)) {
      return false;
    }

    return /^[\p{L}][\p{L}' .-]+$/u.test(line) && line.split(/\s+/u).length >= 2;
  });

  if (!candidate) {
    return {};
  }

  const parts = candidate.split(/\s+/u);
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function matchFirst(text: string, pattern: RegExp) {
  return text.match(pattern)?.[0]?.trim();
}

// Improved URL normalization - validate and return full URLs
function normalizeUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  // Remove trailing punctuation
  let cleaned = value.replace(/[.,;:)]+$/u, "").trim();

  // If it already has a protocol, return as-is
  if (/^https?:\/\//iu.test(cleaned)) {
    return cleaned;
  }

  // If it looks like a domain/path (has dots or slashes), add https://
  if (/\./u.test(cleaned) || cleaned.includes("/")) {
    // Avoid adding https:// twice
    if (!cleaned.startsWith("https://") && !cleaned.startsWith("http://")) {
      return `https://${cleaned}`;
    }
    return cleaned;
  }

  // Single word without domain - skip
  return undefined;
}

function extractUrlBuckets(text: string) {
  // Extract markdown links first [text](url)
  const markdownLinks = Array.from(text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g))
    .map((match) => normalizeUrl(match[2]))
    .filter((url): url is string => Boolean(url));

  // Extract plain URLs
  const plainUrls = Array.from(
    text.matchAll(/(?:https?:\/\/)?(?:www\.)?[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}(?:\/[^\s)]*)?/giu)
  )
    .map((match) => normalizeUrl(match[0]))
    .filter((url): url is string => Boolean(url) && url!.length > 15);

  const allUrls = [...markdownLinks, ...plainUrls];
  const deduped = Array.from(new Set(allUrls));

  // Categorize URLs - check both URL and surrounding text context
  const linkedinUrl = deduped.find((url) => /linkedin\.com/iu.test(url)) ||
    findUrlNearKeyword(text, /linkedin/iu, deduped);

  const githubUrl = deduped.find((url) => /github\.com/iu.test(url)) ||
    findUrlNearKeyword(text, /github/iu, deduped);

  const twitterUrl = deduped.find((url) => /(?:twitter\.com|x\.com)\//iu.test(url)) ||
    findUrlNearKeyword(text, /twitter|x\.com/iu, deduped);

  const portfolioCandidates = deduped.filter(
    (url) => !/linkedin\.com|github\.com|twitter\.com|x\.com/iu.test(url)
  );

  return {
    linkedinUrl: linkedinUrl || undefined,
    githubUrl: githubUrl || undefined,
    twitterUrl: twitterUrl || undefined,
    portfolioUrl: portfolioCandidates[0] || undefined,
    otherUrls: portfolioCandidates.slice(1),
  };
}

function findUrlNearKeyword(text: string, keyword: RegExp, urls: string[]): string | undefined {
  // Find keyword position
  const match = text.match(keyword);
  if (!match) return undefined;

  const keywordPos = match.index || 0;
  const searchWindow = text.substring(Math.max(0, keywordPos - 100), keywordPos + 200);

  // Find URL closest to keyword
  for (const url of urls) {
    if (searchWindow.includes(url)) {
      return url;
    }
  }

  return undefined;
}

function buildExtractionPrompt(pdfText: string): string {
  return [
    "You are a specialized HR Data Parser. Extract professional information from this CV/Resume.",
    "STRICT RULES:",
    "1. URLs: Extract the COMPLETE absolute URL including protocol (https://). Do NOT return domain names or partial URLs.",
    "   - Look for both plain URLs (https://...) and markdown format [text](url)",
    "   - LinkedIn: Find URL associated with word 'LinkedIn' or 'linkedin'",
    "   - GitHub: Find URL associated with word 'GitHub' or 'github'",
    "   - Examples: https://www.linkedin.com/in/johndoe (NOT linkedin.com)",
    "   - Examples: https://github.com/johndoe (NOT github.com)",
    "2. Current Company: Identify the MOST RECENT employer from professional experience.",
    "3. Distinguish between: LinkedIn, GitHub, Twitter/X, Portfolio, and Other links.",
    "4. Education: Extract degree type and graduation year (YYYY format).",
    "5. Return only valid JSON with no markdown.",
    "",
    "Return format:",
    JSON.stringify(
      {
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
        phone: "+1-555-1234",
        location: "San Francisco, CA",
        currentCompany: "Tech Company",
        linkedinUrl: "https://www.linkedin.com/in/johndoe",
        githubUrl: "https://github.com/johndoe",
        twitterUrl: "https://twitter.com/johndoe",
        portfolioUrl: "https://johndoe.dev",
        otherUrls: [],
        education: { degree: "Bachelor of Science", graduationYear: "2020" },
        profileMarkdown: "Full resume text...",
      },
      null,
      2,
    ),
    "",
    "CV Text:",
    pdfText.slice(0, 3500),
  ].join("\n");
}

function buildApplicantProfile(options: {
  text: string;
  name: Pick<Applicant, "firstName" | "lastName">;
  extracted: Partial<Applicant>;
  urlBuckets: ReturnType<typeof extractUrlBuckets>;
}): Applicant {
  return {
    firstName: extractedName(options.extracted.firstName, options.name.firstName),
    lastName: extractedName(options.extracted.lastName, options.name.lastName),
    email: extractedName(options.extracted.email, matchFirst(options.text, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)),
    phone: extractedName(options.extracted.phone, matchFirst(options.text, /(?:\+?\d[\d().\-\s]{7,}\d)/u)),
    location: extractedName(options.extracted.location),
    currentCompany: extractedName(options.extracted.currentCompany),
    linkedinUrl: extractedName(options.extracted.linkedinUrl, options.urlBuckets.linkedinUrl),
    githubUrl: extractedName(options.extracted.githubUrl, options.urlBuckets.githubUrl),
    twitterUrl: extractedName(
      options.extracted.twitterUrl,
      normalizeUrl(matchFirst(options.text, /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/[^\s)]+/iu)),
      options.urlBuckets.twitterUrl,
    ),
    portfolioUrl: extractedName(options.extracted.portfolioUrl, options.urlBuckets.portfolioUrl),
    otherUrls: Array.from(
      new Set(
        [
          ...(Array.isArray(options.extracted.otherUrls) ? options.extracted.otherUrls : []),
          ...options.urlBuckets.otherUrls,
        ].filter(Boolean),
      ),
    ),
    education: options.extracted.education,
    preferences: {
      gender: "Decline to self-identify",
      race: "Decline to self-identify",
      ethnicity: "Decline to self-identify",
      veteran: "I do not wish to answer",
      disability: "I do not wish to answer",
    },
    profileMarkdown: extractedName(options.extracted.profileMarkdown, options.text.slice(0, 12_000)),
  };
}

function extractedName(...values: Array<string | undefined>) {
  for (const value of values) {
    if (value?.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
