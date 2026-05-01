import type { FailureReason } from "./types";

export type ChallengeDetection = {
  reason: FailureReason;
  detail: string;
};

// It is called by the detectChallenge function, to classify what type of challenge the bot has encountered.
export function classifyChallenge(input: {
  url: string;
  title: string;
  html: string;
  status?: number;
}): ChallengeDetection | null {
  const haystack = `${input.url}\n${input.title}\n${input.html}`.toLowerCase();

  if (input.status === 429 || hasAny(haystack, ["too many requests", "rate limit", "rate-limited"])) {
    return { reason: "rate_limited", detail: "The page reported a rate limit." };
  }

  if (hasAny(haystack, ["recaptcha", "g-recaptcha", "hcaptcha", "cf-chl-widget", "captcha"])) {
    return { reason: "captcha_required", detail: "The page requires CAPTCHA verification." };
  }

  if (
    hasAny(haystack, [
      "checking your browser",
      "verify you are human",
      "access denied",
      "unusual traffic",
      "bot detection",
      "automated traffic",
      "security check",
      "cloudflare",
    ])
  ) {
    return { reason: "bot_challenge_detected", detail: "The page showed an anti-bot or interstitial challenge." };
  }

  if (hasAny(haystack, ["sign in", "log in", "login required", "authentication required"])) {
    return { reason: "login_required", detail: "The application flow requires authentication." };
  }

  return null;
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
