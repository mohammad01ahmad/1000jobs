import type { Applicant } from "./types";

type OllamaGenerateResponse = {
  response?: string;
  error?: string;
};

export type FormFieldForMapping = {
  index: number;
  label: string;
  placeholder: string;
  type: string;
  name: string;
  id: string;
  required: boolean;
  options: Array<{ value: string; text: string }>;
};

export type FieldMapping = {
  fieldIndex: number;
  action: "fill" | "skip";
  dataPoint: string;
  value: string;
  confidence: number;
  category: "identity" | "links" | "file" | "custom" | "other";
  reason?: string;
};

type ApplicantExtraction = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  location?: string;
  currentCompany?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  twitterUrl?: string;
  portfolioUrl?: string;
  otherUrls?: string[];
  education?: {
    degree?: string;
    graduationYear?: string;
  };
  profileMarkdown?: string;
};

// API call to answer a custom question from the applicant's pdf
export async function answerQuestionWithOllama(options: {
  question: string;
  applicant: Applicant;
  model: string;
  signal?: AbortSignal;
}): Promise<string> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      stream: false,
      prompt: buildPrompt(options.question, options.applicant),
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}.`);
  }

  const data = (await response.json()) as OllamaGenerateResponse;

  if (data.error) {
    throw new Error(data.error);
  }

  const answer = data.response?.trim();
  if (!answer) {
    throw new Error("Ollama returned an empty answer.");
  }

  return normalizeAnswer(answer);
}

// API call to map form fields to applicant data
export async function mapFieldsWithOllama(options: {
  fields: FormFieldForMapping[];
  applicant: Applicant;
  model: string;
  signal?: AbortSignal;
}): Promise<FieldMapping[]> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      stream: false,
      format: "json",
      prompt: buildFieldMappingPrompt(options.fields, options.applicant),
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}.`);
  }

  const data = (await response.json()) as OllamaGenerateResponse;

  if (data.error) {
    throw new Error(data.error);
  }

  return parseFieldMappings(data.response ?? "");
}

// API call to extract applicant information from a PDF
export async function extractApplicantWithOllama(options: {
  pdfText: string;
  model: string;
  signal?: AbortSignal;
}): Promise<ApplicantExtraction> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      model: options.model,
      stream: false,
      format: "json",
      prompt: buildExtractionPrompt(options.pdfText),
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}.`);
  }

  const data = (await response.json()) as OllamaGenerateResponse;
  if (data.error) {
    throw new Error(data.error);
  }

  return parseApplicantExtraction(data.response ?? "");
}

// Prompt to answer a custom question based on the applicant's profile
function buildPrompt(question: string, applicant: Applicant): string {
  const applicantContext = [
    [applicant.firstName, applicant.lastName].filter(Boolean).length
      ? `Name: ${[applicant.firstName, applicant.lastName].filter(Boolean).join(" ")}`
      : "",
    applicant.email ? `Email: ${applicant.email}` : "",
    applicant.phone ? `Phone: ${applicant.phone}` : "",
    applicant.location ? `Location: ${applicant.location}` : "",
    applicant.linkedinUrl ? `LinkedIn: ${applicant.linkedinUrl}` : "",
    applicant.portfolioUrl ? `Portfolio: ${applicant.portfolioUrl}` : "",
    applicant.githubUrl ? `GitHub: ${applicant.githubUrl}` : "",
    applicant.twitterUrl ? `Twitter/X: ${applicant.twitterUrl}` : "",
    applicant.currentCompany ? `Current Company: ${applicant.currentCompany}` : "",
    applicant.preferences
      ? `Diversity Preferences:\n${JSON.stringify(
        {
          gender: applicant.preferences.gender ?? "Decline to self-identify",
          race: applicant.preferences.race ?? "Decline to self-identify",
          ethnicity: applicant.preferences.ethnicity ?? "Decline to self-identify",
          veteran: applicant.preferences.veteran ?? "I do not wish to answer",
          disability: applicant.preferences.disability ?? "I do not wish to answer",
        },
        null,
        2,
      )}`
      : "",
    applicant.profileMarkdown ? `Profile/Resume:\n${applicant.profileMarkdown.slice(0, 2000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const questionLower = question.toLowerCase();

  let additionalInstructions = "";

  if (/work.?auth|legal.?right|authorized|permit|visa|sponsorship/i.test(questionLower)) {
    additionalInstructions = '\n- For work authorization questions, answer "Yes" unless visa/sponsorship is explicitly mentioned.';
  }

  if (/pronouns/i.test(questionLower)) {
    additionalInstructions = '\n- For pronouns questions, return only pronouns (e.g., "he/him", "she/her", "they/them") or skip.';
  }

  if (/available|start|notice/i.test(questionLower)) {
    additionalInstructions = '\n- For availability/start date, answer "Immediately" or "2 weeks".';
  }

  if (/salary|compensation|pay|expectation/i.test(questionLower)) {
    additionalInstructions = '\n- For salary questions, provide a competitive range based on the role and location. Be strategic but realistic.';
  }

  if (/ruby|rails|experience|skill|technology|proficiency/i.test(questionLower)) {
    additionalInstructions = '\n- For technical experience questions, provide a compelling answer highlighting relevant skills and accomplishments. If experience is missing, focus on transferable skills and learning ability.';
  }

  if (/interest|attract|appeal|excite|company|role|why/i.test(questionLower)) {
    additionalInstructions = '\n- For "why interested" questions, craft a compelling answer that shows genuine interest in the company/role and highlights how the role aligns with career goals.';
  }

  return [
    `You are the applicant, ${applicant.firstName || "the candidate"} ${applicant.lastName || ""}, filling a custom job application question.`,
    "Answer strategically to boost the application. Be professional, compelling, and authentic.",
    "Rules:",
    "- If the question asks for a URL, return only the complete absolute URL string (including https://).",
    '- For missing diversity preference data, use "Decline to self-identify" or "I do not wish to answer".',
    "- Keep answers concise, professional, and under 300 words.",
    "- Return only the answer text. Do not include markdown, labels, quotation marks, or question repetition.",
    "- For open-ended questions: Provide answers that highlight strengths, experience, and value.",
    additionalInstructions,
    "",
    applicantContext,
    "",
    `Question: ${question}`,
    "Answer:",
  ].join("\n");
}

// Prompt to map form fields to applicant data
function buildFieldMappingPrompt(fields: FormFieldForMapping[], applicant: Applicant): string {
  const applicantProfile = buildApplicantProfile(applicant);

  return [
    "You are an expert form filler. Map these job application form fields to the correct data from the candidate profile.",
    "CRITICAL RULES:",
    '1. For REQUIRED fields: ALWAYS fill with available data or sensible defaults. action="fill" for required=true, action="skip" ONLY if truly impossible.',
    '2. For URL fields (LinkedIn, GitHub, Portfolio): Return the COMPLETE URL including https://. Do NOT return domain names only.',
    '3. For work authorization / legal right to work / visa sponsorship questions:',
    '   - If the candidate profile has no explicit visa/sponsorship mention, answer "Yes"',
    '   - category: "custom"',
    "4. For pronouns: Return pronouns format only (he/him, she/her, they/them) or skip",
    "5. For diversity questions (gender, race, ethnicity, veteran, disability): Use preferences from profile or default to 'Decline to self-identify'",
    "6. For availability/start date: Default to 'Immediately' or '2 weeks notice'",
    "7. IMPORTANT - For salary/experience/interest questions: Return compelling, professional answers that boost the application. Be strategic and positive.",
    "8. Confidence should be 1.0 for identity fields with data, 0.9 for reasonable defaults, 0.7 for strategic/custom answers.",
    "9. Return only valid JSON. Do not include markdown code blocks.",
    '10. For hidden fields (type="hidden"): action="skip" always.',
    "",
    "Candidate profile:",
    JSON.stringify(applicantProfile, null, 2),
    "",
    "Form fields to fill:",
    JSON.stringify(fields, null, 2),
    "",
    "Return ONLY a JSON array. Each item must have exactly these fields:",
    "{ fieldIndex, action, dataPoint, value, confidence, category, reason }",
  ].join("\n");
}

function buildApplicantProfile(applicant: Applicant) {
  return {
    firstName: applicant.firstName || "(missing)",
    lastName: applicant.lastName || "(missing)",
    fullName: [applicant.firstName, applicant.lastName].filter(Boolean).join(" ") || "(missing)",
    email: applicant.email || "(missing)",
    phone: applicant.phone || "(missing)",
    location: applicant.location || "(missing)",
    linkedinUrl: applicant.linkedinUrl || "(not provided)",
    portfolioUrl: applicant.portfolioUrl || "(not provided)",
    githubUrl: applicant.githubUrl || "(not provided)",
    twitterUrl: applicant.twitterUrl || "(not provided)",
    currentCompany: applicant.currentCompany || "(missing)",
    otherUrls: applicant.otherUrls || [],
    education: applicant.education || { degree: "(not provided)", graduationYear: "(not provided)" },
    preferences: {
      gender: applicant.preferences?.gender ?? "Decline to self-identify",
      race: applicant.preferences?.race ?? "Decline to self-identify",
      ethnicity: applicant.preferences?.ethnicity ?? "Decline to self-identify",
      veteran: applicant.preferences?.veteran ?? "I do not wish to answer",
      disability: applicant.preferences?.disability ?? "I do not wish to answer",
    },
  };
}

// Prompt to extract applicant information from a PDF
function buildExtractionPrompt(pdfText: string): string {
  return [
    "You are a specialized HR Data Parser. Extract professional information from this CV/Resume.",
    "STRICT RULES:",
    "1. URLs: Extract the COMPLETE absolute URL including protocol (https://). Do NOT return domain names or partial URLs.",
    "   - Examples: https://www.linkedin.com/in/johndoe (NOT linkedin.com or linkedin.com/in/johndoe)",
    "   - Examples: https://github.com/johndoe (NOT github.com or github.com/johndoe)",
    "2. Current Company: Identify the MOST RECENT employer from the professional experience section.",
    "3. Distinguish between: LinkedIn, GitHub, Twitter/X, Portfolio, and Other links.",
    "4. Education: Extract degree type (Bachelor, Master, PhD) and graduation year (format: YYYY).",
    "5. Return only valid JSON with no markdown.",
    "",
    "Return format (fill with extracted data or null if not found):",
    JSON.stringify(
      {
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
        phone: "+1-555-1234",
        location: "San Francisco, CA",
        currentCompany: "Tech Company Inc",
        linkedinUrl: "https://www.linkedin.com/in/johndoe",
        githubUrl: "https://github.com/johndoe",
        twitterUrl: "https://twitter.com/johndoe",
        portfolioUrl: "https://johndoe.dev",
        otherUrls: ["https://medium.com/@johndoe"],
        education: {
          degree: "Bachelor of Science",
          graduationYear: "2020",
        },
        profileMarkdown: "Full resume text here...",
      },
      null,
      2,
    ),
    "",
    "CV Text:",
    pdfText.slice(0, 3500),
  ].join("\n");
}

// Parse the field mappings response from Ollama
function parseFieldMappings(raw: string): FieldMapping[] {
  const cleaned = normalizeAnswer(raw);
  const parsed = parseLooseJson(cleaned);
  const mappings = extractMappingArray(parsed);

  if (!mappings) {
    throw new Error("Ollama field mapping response did not contain a usable mappings array.");
  }

  return mappings
    .map((item): FieldMapping | null => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      const fieldIndex = Number(record.fieldIndex);
      const action = record.action === "fill" ? "fill" : "skip";
      const confidence = Number(record.confidence);
      const category = normalizeCategory(record.category);

      if (!Number.isInteger(fieldIndex)) {
        return null;
      }

      return {
        fieldIndex,
        action,
        dataPoint: typeof record.dataPoint === "string" ? record.dataPoint : "",
        value: typeof record.value === "string" ? record.value : "",
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
        category,
        reason: typeof record.reason === "string" ? record.reason : undefined,
      };
    })
    .filter((mapping): mapping is FieldMapping => Boolean(mapping));
}

// Parse the loose JSON response from Ollama
function parseLooseJson(cleaned: string): unknown {
  const candidates = [
    cleaned,
    cleaned.match(/\[[\s\S]*\]/u)?.[0],
    cleaned.match(/\{[\s\S]*\}/u)?.[0],
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  throw new Error("Ollama field mapping response was not valid JSON.");
}

// Helper to extract mapping array from loose JSON
function extractMappingArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const arrayKeys = ["mappings", "fields", "items", "result", "data"];

  for (const key of arrayKeys) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }

  return null;
}

// Helper function to parse the extracted applicant data from Ollama
function parseApplicantExtraction(raw: string): ApplicantExtraction {
  const cleaned = normalizeAnswer(raw);
  const parsed = parseLooseJson(cleaned);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Applicant extraction response was not a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  return {
    firstName: asString(record.firstName),
    lastName: asString(record.lastName),
    email: asString(record.email),
    phone: asString(record.phone),
    location: asString(record.location),
    currentCompany: asString(record.currentCompany),
    linkedinUrl: asString(record.linkedinUrl),
    githubUrl: asString(record.githubUrl),
    twitterUrl: asString(record.twitterUrl),
    portfolioUrl: asString(record.portfolioUrl),
    otherUrls: Array.isArray(record.otherUrls) ? record.otherUrls.map((value) => asString(value)).filter(Boolean) as string[] : [],
    education: record.education && typeof record.education === "object"
      ? {
        degree: asString((record.education as Record<string, unknown>).degree),
        graduationYear: asString((record.education as Record<string, unknown>).graduationYear),
      }
      : undefined,
    profileMarkdown: asString(record.profileMarkdown),
  };
}

// Helper function to convert unknown value to string
function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed !== "(missing)" && trimmed !== "(not provided)" ? trimmed : undefined;
}

// Helper function to normalize the category field
function normalizeCategory(category: unknown): FieldMapping["category"] {
  if (category === "identity" || category === "links" || category === "file" || category === "custom") {
    return category;
  }

  return "other";
}

// Helper function to normalize the answer field - remove markdown code blocks
function normalizeAnswer(answer: string): string {
  return answer
    .replace(/^```(?:\w+)?\s*/u, "")
    .replace(/```$/u, "")
    .replace(/^answer:\s*/iu, "")
    .trim();
}
