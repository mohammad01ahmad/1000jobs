"use client";

import { useState } from "react";

type ApplyResponse = {
  runId: string;
  status: "ready_to_submit" | "submitted" | "failed";
  reason?: string;
  submitted: boolean;
  customQuestionsAnswered?: number;
  requiredUnfilledFields?: string[];
  artifacts?: {
    logPath: string;
    screenshotPath?: string;
  };
  steps?: Array<{
    at: string;
    level: "info" | "warn" | "error";
    action: string;
    detail?: string;
  }>;
};

export default function Home() {
  const [jobUrl, setJobUrl] = useState("");
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [ollamaModel, setOllamaModel] = useState("llama3.1");
  const [dryRun, setDryRun] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<ApplyResponse | null>(null);
  const [error, setError] = useState("");

  async function submitApplyRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setResult(null);

    if (!cvFile) {
      setError("Attach a PDF CV before running the dry-run.");
      return;
    }

    if (!jobUrl) {
      setError("Enter a job URL before running the dry-run.");
      return;
    }

    setIsSubmitting(true);

    const formData = new FormData();
    formData.set("jobUrl", jobUrl);
    formData.set("cv", cvFile);
    formData.set("options", JSON.stringify({
      dryRun,
      ollamaModel,
    }));

    try {
      const response = await fetch("/api/apply", {
        method: "POST",
        body: formData,
      });

      const data = (await response.json()) as ApplyResponse;
      setResult(data);

      if (!response.ok) {
        setError(data.reason ? `Run failed: ${data.reason}` : "Run failed.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start the run.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8 lg:px-8">
        <header className="flex flex-col gap-2 border-b border-neutral-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-300">AutoApply Lever MVP</p>
          <h1 className="max-w-4xl text-3xl font-semibold tracking-normal text-white md:text-4xl">
            Dry-run a Lever application with PDF upload and Ollama-assisted custom answers.
          </h1>
        </header>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
          <form className="flex flex-col gap-6" onSubmit={submitApplyRequest}>
            <section className="grid gap-4">
              <h2 className="text-lg font-semibold text-white">Job</h2>
              <label className="grid gap-2 text-sm text-neutral-300">
                Lever job URL
                <input
                  required
                  type="url"
                  value={jobUrl}
                  onChange={(event) => setJobUrl(event.target.value)}
                  className="h-11 rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-base text-white outline-none transition focus:border-emerald-400"
                  placeholder="https://jobs.lever.co/company/job-id"
                />
              </label>
            </section>

            <section className="grid gap-4">
              <h2 className="text-lg font-semibold text-white">Run</h2>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-2 text-sm text-neutral-300">
                  PDF CV
                  <input
                    required
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(event) => setCvFile(event.target.files?.[0] ?? null)}
                    className="block h-11 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-white file:mr-4 file:border-0 file:bg-emerald-400 file:px-3 file:py-1 file:text-sm file:font-semibold file:text-neutral-950 file:rounded-lg"
                  />
                </label>
                <TextField label="Ollama model" value={ollamaModel} onChange={setOllamaModel} required />
              </div>
              <label className="flex items-center gap-3 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  checked={dryRun}
                  onChange={(event) => setDryRun(event.target.checked)}
                  className="size-4 accent-emerald-400"
                />
                Dry-run mode
              </label>
              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="h-11 rounded-lg bg-emerald-400 px-5 text-sm font-semibold text-neutral-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
                >
                  {isSubmitting ? "Running dry-run..." : "Run dry-run"}
                </button>
                <span className="text-sm text-neutral-400">
                  Keep dry-run enabled to stop before final submission.
                </span>
              </div>
            </section>
          </form>

          <aside className="flex flex-col gap-4 border-l border-neutral-800 pl-0 lg:pl-8">
            <h2 className="text-lg font-semibold text-white">Result</h2>
            {error ? <p className="border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-100">{error}</p> : null}
            {result ? (
              <div className="grid gap-4 text-sm text-neutral-300">
                <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-2">
                  <dt className="text-neutral-500">Run ID</dt>
                  <dd className="break-all font-mono text-neutral-100">{result.runId}</dd>
                  <dt className="text-neutral-500">Status</dt>
                  <dd className="font-semibold text-neutral-100">{result.status}</dd>
                  <dt className="text-neutral-500">Reason</dt>
                  <dd>{result.reason ?? "None"}</dd>
                  <dt className="text-neutral-500">Submitted</dt>
                  <dd>{String(result.submitted)}</dd>
                  <dt className="text-neutral-500">Custom answers</dt>
                  <dd>{result.customQuestionsAnswered ?? 0}</dd>
                  <dt className="text-neutral-500">Log</dt>
                  <dd className="break-all font-mono text-xs">{result.artifacts?.logPath ?? "Unavailable"}</dd>
                  <dt className="text-neutral-500">Screenshot</dt>
                  <dd className="break-all font-mono text-xs">{result.artifacts?.screenshotPath ?? "Unavailable"}</dd>
                </dl>

                {result.requiredUnfilledFields?.length ? (
                  <div className="grid gap-2">
                    <h3 className="font-semibold text-white">Required fields left empty</h3>
                    <ul className="list-inside list-disc text-neutral-300">
                      {result.requiredUnfilledFields.map((field) => (
                        <li key={field}>{field}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* Add numbers to each steps */}
                {result.steps?.length ? (
                  <div className="grid gap-2">
                    <h3 className="font-semibold text-white">Recent steps</h3>
                    <ol className="grid max-h-96 gap-2 overflow-auto">
                      {result.steps.slice(-16).map((step, index) => (
                        <li
                          key={`${index}-${step.at}-${step.action}`}
                          className="grid gap-1 rounded border border-neutral-800 p-2"
                        >
                          {/* Display time, level, action and detail */}
                          <span className="text-neutral-100">{index + 1}.</span>
                          <span className="font-mono text-xs text-neutral-500">{step.at}</span>
                          <span className="text-neutral-100">
                            {step.level.toUpperCase()} {step.action}
                          </span>
                          {step.detail ? <span className="text-neutral-400">{step.detail}</span> : null}
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm leading-6 text-neutral-400">
                Submit a dry-run to see the run ID, status, root cause, log path, screenshot path, and recent agent steps.
              </p>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="grid gap-2 text-sm text-neutral-300">
      {label}
      <input
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-base text-white outline-none transition focus:border-emerald-400"
      />
    </label>
  );
}
