import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Create artifact directory for the run.
const artifactRoot = path.join(process.cwd(), ".autoapply", "runs");

export async function createRunDirectory(runId: string): Promise<string> {
  const runDirectory = path.join(artifactRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  return runDirectory;
}

// Converts base64 string from payload, convert into Buffer, and write into the OS temp file, for other functions to access.
export async function writeBase64Pdf(runId: string, filename: string, base64: string): Promise<string> {
  const tempDirectory = path.join(tmpdir(), "autoapply", runId);
  await mkdir(tempDirectory, { recursive: true });

  const pdfPath = path.join(tempDirectory, sanitizePdfFilename(filename));
  const normalized = base64.replace(/^data:application\/pdf;base64,/, "");
  const bytes = Buffer.from(normalized, "base64");

  if (bytes.length === 0 || !bytes.subarray(0, 4).equals(Buffer.from("%PDF"))) {
    throw new Error("Uploaded CV is not a valid PDF payload.");
  }

  await writeFile(pdfPath, bytes);
  return pdfPath;
}

function sanitizePdfFilename(filename: string): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
}
