import { z } from "zod";
import type { ApplyPayload } from "./types";

const urlSchema = z.string().url().refine(isLeverUrl, {
  message: "Only Lever-hosted job URLs are supported in v1.",
});

export const applyPayloadSchema = z.object({
  jobUrl: urlSchema,
  cv: z.object({
    filename: z.string().trim().min(1).refine((value) => value.toLowerCase().endsWith(".pdf"), {
      message: "CV filename must end with .pdf.",
    }),
    base64: z.string().trim().min(1),
    mimeType: z.literal("application/pdf"),
  }),
  options: z
    .object({
      dryRun: z.boolean().optional(),
      ollamaModel: z.string().trim().min(1).optional(),
    })
    .optional(),
});

export function parseApplyPayload(input: unknown): ApplyPayload {
  return applyPayloadSchema.parse(input);
}

export function isLeverUrl(value: string): boolean {
  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    const hostname = url.hostname.toLowerCase();
    return hostname === "jobs.lever.co" || hostname.endsWith(".lever.co");
  } catch {
    return false;
  }
}
