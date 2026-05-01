export type ApplyStatus = "ready_to_submit" | "submitted" | "failed";

export type FailureReason =
  | "invalid_payload"
  | "unsupported_ats"
  | "navigation_failed"
  | "form_not_found"
  | "captcha_required"
  | "bot_challenge_detected"
  | "login_required"
  | "rate_limited"
  | "pdf_upload_failed"
  | "ollama_failed"
  | "validation_failed"
  | "submission_failed"
  | "unexpected_error";

export type Applicant = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  location?: string;
  currentCompany?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  githubUrl?: string;
  twitterUrl?: string;
  otherUrls?: string[];
  education?: {
    degree?: string;
    graduationYear?: string;
  };
  preferences?: {
    gender?: string;
    race?: string;
    ethnicity?: string;
    veteran?: string;
    disability?: string;
  };
  profileMarkdown?: string;
};

export type ApplyPayload = {
  jobUrl: string;
  cv: {
    filename: string;
    base64: string;
    mimeType: "application/pdf";
  };
  options?: {
    dryRun?: boolean;
    ollamaModel?: string;
  };
};

export type AgentApplyPayload = ApplyPayload & {
  applicant: Applicant;
};

export type RunStep = {
  at: string;
  level: "info" | "warn" | "error";
  action: string;
  detail?: string;
};

export type RunArtifacts = {
  logPath: string;
  screenshotPath?: string;
};

export type ApplyResult = {
  runId: string;
  status: ApplyStatus;
  dryRun: boolean;
  jobUrl: string;
  submitted: boolean;
  reason?: FailureReason;
  requiredUnfilledFields?: string[];
  customQuestionsAnswered?: number;
  artifacts: RunArtifacts;
  steps: RunStep[];
};

export type RunLogger = {
  runId: string;
  logPath: string;
  steps: RunStep[];
  info: (action: string, detail?: string) => void;
  warn: (action: string, detail?: string) => void;
  error: (action: string, detail?: string) => void;
};

export type BrowserField = {
  index: number;
  selector: string;
  tagName: "input" | "textarea" | "select";
  type: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  required: boolean;
  value: string;
  checked: boolean;
  visible: boolean;
  options: Array<{ value: string; text: string }>;
};
