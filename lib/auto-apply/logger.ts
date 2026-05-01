import pino from "pino";
import path from "node:path";
import type { RunLogger, RunStep } from "./types";

export function createRunLogger(runId: string, runDirectory: string): RunLogger {
  const logPath = path.join(runDirectory, "run.jsonl");
  const logger = pino(
    { base: { runId }, timestamp: pino.stdTimeFunctions.isoTime },
    pino.destination({ dest: logPath, sync: true }),
  );
  const steps: RunStep[] = [];

  function record(level: RunStep["level"], action: string, detail?: string) {
    const step: RunStep = {
      at: new Date().toISOString(),
      level,
      action,
      detail,
    };

    steps.push(step);
    logger[level](detail ? { action, detail } : { action });
  }

  return {
    runId,
    logPath,
    steps,
    info: (action, detail) => record("info", action, detail),
    warn: (action, detail) => record("warn", action, detail),
    error: (action, detail) => record("error", action, detail),
  };
}
