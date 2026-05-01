import path from "node:path";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteerExtra.use(StealthPlugin());
import { type Browser, type Page } from "puppeteer";
import { answerQuestionWithOllama, mapFieldsWithOllama, type FieldMapping } from "./ollama";
import type { AgentApplyPayload, Applicant, ApplyResult, BrowserField, FailureReason, RunLogger } from "./types";

type RunnerOptions = {
  payload: AgentApplyPayload;
  pdfPath: string;
  logger: RunLogger;
  runDirectory: string;
};

type FailedResultOptions = {
  reason: FailureReason;
  detail: string;
  screenshotPath?: string;
  requiredUnfilledFields?: string[];
  customQuestionsAnswered?: number;
};

type FileUploadTarget = {
  selector: string;
  label: string;
};

const textLikeInputTypes = new Set(["", "text", "email", "tel", "url", "search"]);

async function simulateHumanInteraction(page: Page) {
  try {
    await page.mouse.move(Math.random() * 500 + 100, Math.random() * 500 + 100);
    await delay(Math.random() * 500 + 200);
    await page.evaluate(() => window.scrollBy(0, 500));
    await delay(Math.random() * 500 + 200);
    await page.mouse.move(Math.random() * 500 + 100, Math.random() * 500 + 100);
    await page.evaluate(() => window.scrollBy(0, -300));
    await delay(Math.random() * 500 + 200);
  } catch {
    // Ignore if navigation happens during movement
  }
}

export async function runLeverAutoApply({
  payload,
  pdfPath,
  logger,
  runDirectory,
}: RunnerOptions): Promise<ApplyResult> {
  const dryRun = payload.options?.dryRun ?? true;
  const ollamaModel = payload.options?.ollamaModel ?? process.env.OLLAMA_MODEL ?? "llama3.1";
  let browser: Browser | null = null;
  let screenshotPath: string | undefined;
  let customQuestionsAnswered = 0;


  try {
    logger.info("browser.launch", "Starting Puppeteer.");

    let proxyUsername = "";
    let proxyPassword = "";

    if (process.env.BRIGHTDATA_WS_URL) {
      logger.info("browser.connect", "Connecting to Bright Data Scraping Browser");
      browser = await puppeteerExtra.connect({
        browserWSEndpoint: process.env.BRIGHTDATA_WS_URL,
      });
    } else {
      const args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-zygote",
        "--single-process",
        "--disable-blink-features=AutomationControlled",
        "--disable-plugins",
        "--disable-extensions",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
      ];

      // proxy config (will check if needed)
      if (process.env.PROXY_URL) {
        try {
          const proxyUrl = new URL(process.env.PROXY_URL);
          args.push(`--proxy-server=${proxyUrl.protocol}//${proxyUrl.host}`);
          if (proxyUrl.username && proxyUrl.password) {
            proxyUsername = decodeURIComponent(proxyUrl.username);
            proxyPassword = decodeURIComponent(proxyUrl.password);
          }
        } catch {
          logger.warn("proxy.invalid", "Invalid PROXY_URL environment variable");
        }
      }

      // Launch browser
      browser = await puppeteerExtra.launch({
        headless: true,
        args,
      });
    }

    // open the page
    const page = await browser.newPage();

    // proxy config (will check if needed)
    if (proxyUsername && proxyPassword) {
      await page.authenticate({ username: proxyUsername, password: proxyPassword });
    }

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1365, height: 900, deviceScaleFactor: 1 });
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(45_000);

    // Append /apply if not already present
    const targetUrl = payload.jobUrl.endsWith("/apply")
      ? payload.jobUrl
      : `${payload.jobUrl.replace(/\/$/, "")}/apply`;

    // navigate to job url and wait for the page to load
    logger.info("navigation.start", targetUrl);
    await delay(Math.random() * 1000 + 500);

    // Random 1-3 second delay before navigation to /apply
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000, // Increased timeout to allow Bright Data to solve CAPTCHAs
    });

    await simulateHumanInteraction(page);

    await delay(Math.random() * 1000 + 500); // Random 2-5 second delay after page loads

    await simulateHumanInteraction(page);

    await revealLeverApplicationForm(page, logger);

    // Find and annotate all input, textarea, and select fields
    const fields = await annotateAndReadFields(page);
    if (fields.length === 0) {
      screenshotPath = await captureScreenshot(page, runDirectory, "form-not-found");
      logger.error("form.not_found", "No visible application fields were found.");
      return failedResult({
        payload,
        logger,
        reason: "form_not_found",
        detail: "No visible application fields were found.",
        screenshotPath,
      });
    }

    // Stage 1: Fill high-confidence identity/links
    logger.info("fields.detected", `Found ${fields.length} application fields.`);
    const usedSelectors = new Set<string>();
    let fieldMappings = await fillProfileFieldsFromLlmMap({
      page,
      fields,
      applicant: payload.applicant,
      usedSelectors,
      logger,
      model: ollamaModel,
    });

    // Upload PDF
    const uploadOk = await uploadPdf(page, {
      filename: payload.cv.filename,
      base64: payload.cv.base64,
      mimeType: payload.cv.mimeType,
    }, logger);
    if (!uploadOk) {
      screenshotPath = await captureScreenshot(page, runDirectory, "upload-failed");
      logger.error("upload.failed", "Could not verify that the PDF was attached to the form.");
      return failedResult({
        payload,
        logger,
        reason: "pdf_upload_failed",
        detail: "Could not verify that the PDF was attached to the form.",
        screenshotPath,
      });
    }
    await simulateHumanInteraction(page);

    // Stage 2: Re-scan after upload and re-fill newly revealed profile fields.
    const refreshedFields = await annotateAndReadFields(page);
    const stage2Mappings = await fillProfileFieldsFromLlmMap({
      page,
      fields: refreshedFields,
      applicant: payload.applicant,
      usedSelectors,
      logger,
      model: ollamaModel,
    });
    if (stage2Mappings.length > 0) {
      fieldMappings = stage2Mappings;
    }
    await simulateHumanInteraction(page);

    // Stage 3: Fill custom questions with LLM answers.
    customQuestionsAnswered = await fillCustomFields({
      page,
      fields: refreshedFields,
      applicant: payload.applicant,
      usedSelectors,
      logger,
      model: ollamaModel,
      fieldMappings,
    });
    await simulateHumanInteraction(page);

    const requiredUnfilledFields = await findRequiredUnfilledFields(page);
    if (requiredUnfilledFields.length > 0) {
      screenshotPath = await captureScreenshot(page, runDirectory, "validation-failed");
      logger.warn("validation.failed", `Missing required fields: ${requiredUnfilledFields.join(", ")}`);
      return failedResult({
        payload,
        logger,
        reason: "validation_failed",
        detail: "Required fields remain unfilled.",
        screenshotPath,
        requiredUnfilledFields,
        customQuestionsAnswered,
      });
    }
    await simulateHumanInteraction(page);

    screenshotPath = await captureScreenshot(page, runDirectory, "ready-to-submit");
    if (dryRun) {
      logger.info("dry_run.ready", "Form appears ready to submit. Dry-run mode stopped before final submission.");
      return {
        runId: logger.runId,
        status: "ready_to_submit",
        dryRun,
        jobUrl: payload.jobUrl,
        submitted: false,
        requiredUnfilledFields: [],
        customQuestionsAnswered,
        artifacts: { logPath: logger.logPath, screenshotPath },
        steps: logger.steps,
      };
    }

    const submitted = await submitApplication(page, logger);
    screenshotPath = await captureScreenshot(page, runDirectory, submitted ? "submitted" : "submission-failed");

    if (!submitted) {
      return failedResult({
        payload,
        logger,
        reason: "submission_failed",
        detail: "The form did not show a successful submission state.",
        screenshotPath,
        customQuestionsAnswered,
      });
    }

    return {
      runId: logger.runId,
      status: "submitted",
      dryRun,
      jobUrl: payload.jobUrl,
      submitted: true,
      requiredUnfilledFields: [],
      customQuestionsAnswered,
      artifacts: { logPath: logger.logPath, screenshotPath },
      steps: logger.steps,
    };
  } catch (error) {
    logger.error("run.failed", error instanceof Error ? error.message : "Unexpected error.");
    return failedResult({
      payload,
      logger,
      reason: "unexpected_error",
      detail: error instanceof Error ? error.message : "Unexpected error.",
      screenshotPath,
      customQuestionsAnswered,
    });
  } finally {
    await browser?.close();
  }
}

// Wait for the application form to appear after any CAPTCHA challenges
async function revealLeverApplicationForm(page: Page, logger: RunLogger) {
  try {
    // Wait for a form with id 'application-form' to appear in the DOM
    await page.waitForSelector('form#application-form', { visible: true, timeout: 30_000 });
    logger.info("form.detected", "Application form found");
    await delay(Math.random() * 1000 + 500);
  } catch {
    logger.warn("form.not_found", "Application form not found or timed out");
  }
}

// Find and annotate all input, textarea, and select fields
async function annotateAndReadFields(page: Page): Promise<BrowserField[]> {
  const hasApplicationForm = Boolean(await page.$("form#application-form"));

  // Try to get fields from iframe first
  try {
    const frameHandle = await page.$('iframe');
    if (!hasApplicationForm && frameHandle) {
      const frame = await frameHandle.contentFrame();
      if (frame) {
        const iframeFields = (await frame.evaluate(() => {
          const controls = Array.from(document.querySelectorAll("input, textarea, select")) as Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;

          return controls.map((control, index) => {
            control.setAttribute("data-autoapply-index", String(index));
            const id = control.getAttribute("id") || control.getAttribute("name") || String(index);
            const label = Array.from(document.querySelectorAll("label"))
              .find((label) => label.getAttribute("for") === id)
              ?.textContent?.trim();

            const ariaLabel = control.getAttribute("aria-label");
            const placeholder = control.getAttribute("placeholder");
            const name = control.getAttribute("name");

            const fieldText = [label, ariaLabel, placeholder, name]
              .filter(Boolean)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();

            const style = window.getComputedStyle(control);
            const isVisible =
              style.display !== "none" && style.visibility !== "hidden" && control.getBoundingClientRect().height > 0;

            let type = "text";
            let options: Array<{ value: string; text: string }> = [];
            let checked = false;

            if (control instanceof HTMLInputElement) {
              type = control.type || "text";
              checked = control.checked;
            } else if (control instanceof HTMLTextAreaElement) {
              type = "textarea";
            } else if (control instanceof HTMLSelectElement) {
              type = "select";
              options = Array.from(control.options || []).map((option) => ({
                value: option.value,
                text: option.text,
              }));
            }

            return {
              selector: `[data-autoapply-index="${index}"]`,
              label: label || fieldText,
              name: name || "",
              id: id || "",
              placeholder: placeholder || "",
              ariaLabel: ariaLabel || "",
              type,
              options,
              tagName: control.tagName.toLowerCase() as "input" | "select" | "textarea",
              required: control.hasAttribute("required") || control.getAttribute("aria-required") === "true",
              value: control.value || "",
              visible: isVisible,
              checked,
              index,
            };
          });
        })) as BrowserField[];

        if (iframeFields.length > 0) {
          return iframeFields.map((field) => ({
            selector: field.selector,
            label: field.label,
            name: field.name || "",
            id: field.id || "",
            placeholder: field.placeholder || "",
            ariaLabel: field.ariaLabel || "",
            type: field.type,
            options: field.options,
            tagName: field.tagName,
            required: field.required,
            value: field.value,
            visible: field.visible,
            checked: false,
            index: field.index,
          }));
        }
      }
    }
  } catch {
    console.log("Could not read iframe fields, trying page fields");
  }


  // Fallback to page fields (original code)
  return page.evaluate(() => {
    const root = document.querySelector("form#application-form") ?? document;
    const controls = Array.from(root.querySelectorAll("input, textarea, select")) as Array<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >;

    return controls.map((control, index) => {
      control.setAttribute("data-autoapply-index", String(index));

      const id = control.getAttribute("id") || control.getAttribute("name") || String(index);
      const label = Array.from(document.querySelectorAll("label"))
        .find((label) => label.getAttribute("for") === id)
        ?.textContent?.trim();

      const ariaLabel = control.getAttribute("aria-label");
      const placeholder = control.getAttribute("placeholder");
      const name = control.getAttribute("name");

      const fieldText = [label, ariaLabel, placeholder, name]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      const style = window.getComputedStyle(control);
      const isVisible =
        style.display !== "none" && style.visibility !== "hidden" && control.getBoundingClientRect().height > 0;

      let type = "text";
      let options: Array<{ value: string; text: string }> = [];
      let checked = false;

      if (control instanceof HTMLInputElement) {
        type = control.type || "text";
        checked = control.checked;
      } else if (control instanceof HTMLTextAreaElement) {
        type = "textarea";
      } else if (control instanceof HTMLSelectElement) {
        type = "select";
        options = Array.from(control.options || []).map((option) => ({
          value: option.value,
          text: option.text,
        }));
      }

      return {
        selector: `[data-autoapply-index="${index}"]`,
        label: label || fieldText,
        name: name || "",
        id: id || "",
        placeholder: placeholder || "",
        ariaLabel: ariaLabel || "",
        type,
        options,
        tagName: control.tagName.toLowerCase() as "input" | "select" | "textarea",
        required: control.hasAttribute("required") || control.getAttribute("aria-required") === "true",
        value: control.value || "",
        visible: isVisible,
        checked: checked,
        index: index,
      };
    });
  });
}

async function fillProfileFieldsFromLlmMap(options: {
  page: Page;
  fields: BrowserField[];
  applicant: Applicant;
  usedSelectors: Set<string>;
  logger: RunLogger;
  model: string;
}): Promise<FieldMapping[]> {
  const fieldsForMapping = options.fields.map((field) => ({
    index: field.index,
    label: field.label,
    placeholder: field.placeholder,
    type: field.type,
    name: field.name,
    id: field.id,
    required: field.required,
    options: field.options,
  }));

  options.logger.info("fields.inventory", JSON.stringify(fieldsForMapping));

  let mappings: FieldMapping[] = [];
  try {
    mappings = await mapFieldsWithOllama({
      fields: fieldsForMapping,
      applicant: options.applicant,
      model: options.model,
    });
    options.logger.info("fields.mapped", `Ollama mapped ${mappings.length} fields.`);
  } catch (error) {
    options.logger.warn(
      "fields.mapping_failed",
      error instanceof Error ? error.message : "Could not map fields with Ollama; falling back to keyword mapping.",
    );
    await fillStandardFields(options.page, options.fields, options.applicant, options.usedSelectors, options.logger);
    return mappings;
  }

  const fieldsByIndex = new Map(options.fields.map((field) => [field.index, field]));
  const orderedMappings = mappings
    .filter((mapping) => mapping.action === "fill" && mapping.confidence >= 0.82 && mapping.value.trim())
    .filter((mapping) => mapping.category !== "file" && mapping.category !== "custom")
    .filter((mapping) => isMappingValueValid(mapping))
    .sort(compareMappingsForFillOrder);

  for (const mapping of orderedMappings) {
    const field = fieldsByIndex.get(mapping.fieldIndex);
    if (!field || !field.visible || options.usedSelectors.has(field.selector)) {
      continue;
    }

    try {
      const filled = await fillControl(options.page, field, mapping.value, options.logger);
      if (filled) {
        options.usedSelectors.add(field.selector);
        options.logger.info("field.filled", `${mapping.dataPoint || field.label} (${mapping.category}, ${mapping.confidence})`);
      }
    } catch (error) {
      options.logger.warn(
        "field.error",
        `Error filling ${mapping.dataPoint || field.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return mappings;
}

function compareMappingsForFillOrder(left: FieldMapping, right: FieldMapping) {
  const leftRank = fillRank(left);
  const rightRank = fillRank(right);
  return leftRank === rightRank ? right.confidence - left.confidence : leftRank - rightRank;
}

function fillRank(mapping: FieldMapping) {
  const key = mapping.dataPoint.toLowerCase().replace(/[^a-z]/gu, "");

  if (mapping.category === "identity") {
    if (/firstname|givenname/.test(key)) return 10;
    if (/lastname|surname|familyname/.test(key)) return 11;
    if (/fullname|name/.test(key)) return 12;
    if (/email/.test(key)) return 13;
    if (/phone|mobile|telephone/.test(key)) return 14;
    if (/gender|race|ethnicity|veteran|disability/.test(key)) return 15;
    return 19;
  }

  if (mapping.category === "links") {
    if (/linkedin/.test(key)) return 20;
    if (/portfolio|website|site/.test(key)) return 21;
    if (/github/.test(key)) return 22;
    if (/twitter|xhandle|handle/.test(key)) return 23;
    return 29;
  }

  return 39;
}

async function fillStandardFields(
  page: Page,
  fields: BrowserField[],
  applicant: Applicant,
  usedSelectors: Set<string>,
  logger: RunLogger,
) {
  const fullName = [applicant.firstName, applicant.lastName].filter(Boolean).join(" ").trim();
  const firstName = findField(fields, ["first name", "firstname", "given name"]);
  const lastName = findField(fields, ["last name", "lastname", "family name", "surname"]);
  const fullNameField = findField(fields, ["full name", "your name", "name"], [firstName?.selector, lastName?.selector]);
  const mappings = [
    { field: firstName, value: applicant.firstName, label: "first_name" },
    { field: lastName, value: applicant.lastName, label: "last_name" },
    { field: firstName || lastName ? undefined : fullNameField, value: fullName, label: "name" },
    { field: findField(fields, ["email", "e-mail"]), value: applicant.email, label: "email" },
    { field: findField(fields, ["phone", "mobile", "telephone"]), value: applicant.phone, label: "phone" },
    { field: findField(fields, ["location", "city", "address"]), value: applicant.location, label: "location" },
    { field: findField(fields, ["current company", "employer", "company"]), value: applicant.currentCompany, label: "current_company" },
    { field: findField(fields, ["linkedin", "linked in"]), value: applicant.linkedinUrl, label: "linkedin" },
    { field: findField(fields, ["portfolio", "website", "personal site"]), value: applicant.portfolioUrl, label: "portfolio" },
    { field: findField(fields, ["github", "git hub"]), value: applicant.githubUrl, label: "github" },
    { field: findField(fields, ["twitter", "x profile", "x.com"]), value: applicant.twitterUrl, label: "twitter" },
  ];

  for (const mapping of mappings) {
    if (!mapping.field || !mapping.value || usedSelectors.has(mapping.field.selector)) {
      continue;
    }

    try {
      // Check if element still exists before filling
      const exists = await mapping.field.selector;
      if (!exists) {
        logger.warn("field.detached", `Field ${mapping.label} no longer attached`);
        continue;
      }

      await fillControl(page, mapping.field, mapping.value, logger);
      usedSelectors.add(mapping.field.selector);
      logger.info("field.filled", mapping.label);

      // Pause between fields to avoid detection
      await delay(Math.random() * 500 + 500);
    } catch (error) {
      logger.warn("field.error", `Error filling ${mapping.label}: ${error}`);
      // Continue with next field instead of crashing
      continue;
    }
  }
}

async function fillCustomFields(options: {
  page: Page;
  fields: BrowserField[];
  applicant: Applicant;
  usedSelectors: Set<string>;
  logger: RunLogger;
  model: string;
  fieldMappings?: FieldMapping[];
}) {
  let count = 0;
  const mappingsByIndex = new Map((options.fieldMappings ?? []).map((mapping) => [mapping.fieldIndex, mapping]));

  for (const field of options.fields) {
    if (options.usedSelectors.has(field.selector) || field.value || field.type === "file") {
      continue;
    }

    const mapping = mappingsByIndex.get(field.index);
    if (mapping?.action === "skip" && mapping.category !== "custom") {
      continue;
    }

    const prompt = customPromptForField(field, mapping?.category === "custom");
    if (!prompt) {
      continue;
    }

    try {
      const answer = await answerQuestionWithOllama({
        question: prompt,
        applicant: options.applicant,
        model: options.model,
      });

      const filled = await fillControl(options.page, field, answer, options.logger);
      if (filled) {
        options.usedSelectors.add(field.selector);
        count += 1;
        options.logger.info("custom_question.answered", prompt.slice(0, 180));
      }
    } catch (fillError) {
      const errorMsg = fillError instanceof Error ? fillError.message : "Unknown error";

      if (errorMsg.includes("detached") || errorMsg.includes("Target closed") || errorMsg.includes("not clickable")) {
        options.logger.warn("custom_question.frame_error", field.label);
        // Wait longer for page to recover
        await delay(5000);
        // Re-read form fields to get fresh selectors
        const refreshedFields = await annotateAndReadFields(options.page);
        options.logger.info("fields.refreshed", `Refreshed field list after error`);
        continue;
      }

      options.logger.warn("custom_question.fill_error", field.label);
      continue;
    }
  }

  return count;
}

async function fillControl(page: Page, field: BrowserField, value: string, logger: RunLogger): Promise<boolean> {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return false;
  }

  if (field.tagName === "select") {
    const selected = findBestOptionValue(field, normalizedValue);
    if (selected) {
      // Add human-like delay before selecting
      await delay(Math.random() * 500 + 200);
      await page.select(field.selector, selected);
      await dispatchChange(page, field.selector);
      return true;
    }

    // Fallback for custom-styled selects rendered as floating menus
    return selectFromFloatingOptions(page, field.selector, normalizedValue);
  }

  if (field.type === "checkbox" || field.type === "radio") {
    if (shouldSelectBooleanOption(field, normalizedValue)) {
      // Human-like click instead of instant
      await delay(Math.random() * 500 + 200);
      await page.click(field.selector);
      await dispatchChange(page, field.selector);
      return true;
    }

    return false;
  }

  if (field.type === "date") {
    const dateValue = normalizeDateValue(normalizedValue);
    if (!dateValue) {
      return false;
    }

    await page.$eval(
      field.selector,
      (element, value) => {
        if (element instanceof HTMLInputElement) {
          element.value = value;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      dateValue,
    );
    return true;
  }

  if (field.tagName === "textarea" || textLikeInputTypes.has(field.type)) {
    // Check if element is clickable before attempting
    const isClickable = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.pointerEvents !== "none" &&
        rect.height > 0 &&
        rect.width > 0
      );
    }, field.selector);

    if (!isClickable) {
      logger.warn("fillControl.not_clickable", `${field.label}: Element not clickable`);
      return false;
    }

    // Longer delay before clicking
    await delay(Math.random() * 600 + 400);

    try {
      await page.click(field.selector);
    } catch (error) {
      logger.warn("click_failed", field.label);
      return false;
    }

    // Wait for focus
    await delay(Math.random() * 400 + 300);

    // Clear field safely
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      if (el) el.value = "";
    }, field.selector).catch(() => { });

    await delay(Math.random() * 300 + 200);

    // Type with normal speed
    for (const char of normalizedValue) {
      try {
        await page.keyboard.type(char);
      } catch (error) {
        logger.warn("type_failed", `${field.label}: ${char}`);
        break;
      }
      // Normal typing speed
      await delay(Math.random() * 80 + 40);
    }

    await delay(Math.random() * 400 + 300);

    try {
      await dispatchChange(page, field.selector);
    } catch (error) {
      logger.warn("dispatch_failed", field.label);
    }

    return true;
  }

  return false;
}

async function dispatchChange(page: Page, selector: string) {
  await page.$eval(selector, (element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// upload resume to the form, it will find the resume/cv file input and upload the pdf file.
async function uploadPdf(
  page: Page,
  file: { filename: string; base64: string; mimeType: string },
  logger: RunLogger,
) {
  const target = await findFileUploadTarget(page);
  if (!target) {
    logger.warn("upload.input_missing", "No resume/CV file input was found.");
    return false;
  }

  const uploaded = await page.evaluate(
    ({ selector, filename, base64, mimeType }) => {
      const input = document.querySelector(selector);
      if (!(input instanceof HTMLInputElement) || input.type !== "file") {
        return false;
      }

      const normalizedBase64 = base64.replace(/^data:application\/pdf;base64,/u, "");
      const binary = atob(normalizedBase64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const browserFile = new File([bytes], filename, { type: mimeType });
      const transfer = new DataTransfer();
      transfer.items.add(browserFile);
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      return input.files?.length === 1 && input.files[0]?.name === filename;
    },
    {
      selector: target.selector,
      filename: file.filename,
      base64: file.base64,
      mimeType: file.mimeType,
    },
  );

  if (!uploaded) {
    logger.warn("upload.inject_failed", `Could not inject ${file.filename} into ${target.selector}`);
    return false;
  }

  logger.info("upload.completed", `${path.basename(file.filename)} -> ${target.label || target.selector}`);
  await delay(Math.random() * 500 + 200);

  return page.$$eval("input[type='file']", (inputs) => {
    return inputs.some((element) => element instanceof HTMLInputElement && element.files !== null && element.files.length > 0);
  });
}

async function findFileUploadTarget(page: Page): Promise<FileUploadTarget | null> {
  const targets = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input[type='file']")) as HTMLInputElement[];

    function labelText(element: HTMLInputElement) {
      const id = element.getAttribute("id");
      const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : "";
      const container = element.closest(".application-field, .posting-field, .form-field, li, div")?.textContent ?? "";
      return [
        explicit,
        container,
        element.getAttribute("name"),
        element.getAttribute("id"),
        element.getAttribute("aria-label"),
        element.getAttribute("accept"),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }

    return inputs.map((input, index) => {
      input.setAttribute("data-autoapply-file", String(index));
      return {
        selector: `[data-autoapply-file="${index}"]`,
        label: labelText(input),
      };
    });
  });

  return targets.find((target) => /resume|cv|curriculum|attachment/i.test(target.label)) ?? targets[0] ?? null;
}

async function findRequiredUnfilledFields(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("input, textarea, select")) as Array<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >;

    function isVisible(element: Element) {
      const box = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function labelText(element: Element) {
      const id = element.getAttribute("id");
      const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : "";
      const aria = element.getAttribute("aria-label") ?? "";
      const placeholder = element.getAttribute("placeholder") ?? "";
      const container = element.closest(".application-field, .posting-field, .form-field, li, div")?.textContent ?? "";
      return (explicit || aria || placeholder || container || element.getAttribute("name") || "Unnamed field")
        .replace(/\s+/g, " ")
        .trim();
    }

    function isRequired(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
      return control.required || control.getAttribute("aria-required") === "true" || labelText(control).includes("*");
    }

    const missing: string[] = [];
    const missingRadioGroups = new Set<string>();
    const checkedRadioGroups = new Set(
      controls
        .filter((control): control is HTMLInputElement => control instanceof HTMLInputElement)
        .filter((control) => control.type === "radio" && control.checked)
        .map((control) => control.name || labelText(control)),
    );

    for (const control of controls) {
      if (control.disabled || !isVisible(control) || !isRequired(control)) {
        continue;
      }

      if (control instanceof HTMLInputElement && control.type === "radio") {
        const groupName = control.name || labelText(control);
        if (!checkedRadioGroups.has(groupName) && !missingRadioGroups.has(groupName)) {
          missing.push(labelText(control));
          missingRadioGroups.add(groupName);
        }
        continue;
      }

      if (control instanceof HTMLInputElement && control.type === "checkbox") {
        if (!control.checked) {
          missing.push(labelText(control));
        }
        continue;
      }

      if (!control.value) {
        missing.push(labelText(control));
      }
    }

    return Array.from(new Set(missing)).slice(0, 20);
  });
}

async function submitApplication(page: Page, logger: RunLogger) {
  const clicked = await page.evaluate(() => {
    const submitBtn = document.querySelector("#btn-submit") ||
      document.querySelector('[data-qa="btn-submit"]') ||
      (Array.from(document.querySelectorAll("button, input[type='submit']")) as HTMLElement[]).find((button) => {
        const text = button instanceof HTMLInputElement ? button.value.toLowerCase() : button.innerText.toLowerCase();
        return text.includes("submit") || text.includes("send application") || text.includes("apply");
      });

    if (submitBtn) {
      (submitBtn as HTMLElement).click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    logger.warn("submit.button_missing", "No submit control was found.");
    return false;
  }

  logger.info("submit.clicked", "Clicked final submit.");
  await delay(3_000);

  const html = (await page.content()).toLowerCase();
  return ["thank you", "application submitted", "submitted successfully", "we received your application", "your application has been sent"].some((text) =>
    html.includes(text),
  );
}

function findField(fields: BrowserField[], keywords: string[], excludeSelectors: Array<string | undefined> = []) {
  const excluded = new Set(excludeSelectors.filter(Boolean));
  return fields.find((field) => {
    if (excluded.has(field.selector) || field.type === "file") {
      return false;
    }

    const text = fieldText(field);
    return keywords.some((keyword) => text.includes(keyword));
  });
}

function fieldText(field: BrowserField) {
  return [field.label, field.name, field.id, field.placeholder, field.ariaLabel].join(" ").toLowerCase();
}

// Need to check the arguments again
function customPromptForField(field: BrowserField, mappedAsCustom = false) {
  const text = fieldText(field)
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || /resume|cv|email|phone|name|linkedin|github|portfolio|website|location|gender|race|ethnicity|veteran|disability/.test(text)) {
    return "";
  }

  if (
    mappedAsCustom ||
    field.tagName === "textarea" ||
    field.tagName === "select" ||
    ["text", "radio", "checkbox"].includes(field.type)
  ) {
    return text;
  }

  return "";
}

function findBestOptionValue(field: BrowserField, answer: string) {
  const normalizedAnswer = answer.toLowerCase().trim();
  const nonEmptyOptions = field.options.filter((option) => option.value || option.text);

  // Exact match
  const exact = nonEmptyOptions.find((option) => option.text.toLowerCase() === normalizedAnswer);
  if (exact) return exact.value;

  // Partial match
  const partial = nonEmptyOptions.find(
    (option) => normalizedAnswer.includes(option.text.toLowerCase()) || option.text.toLowerCase().includes(normalizedAnswer),
  );
  if (partial) return partial.value;

  // For yes/no questions with yes/true/agree
  if (/^(yes|true|agree|authorized|eligible|available|willing)$/i.test(normalizedAnswer)) {
    const yesOption = nonEmptyOptions.find((o) => /^(yes|true|agree)$/i.test(o.text));
    if (yesOption) return yesOption.value;
  }

  // For no/false/disagree
  if (/^(no|false|disagree|not authorized|not eligible)$/i.test(normalizedAnswer)) {
    const noOption = nonEmptyOptions.find((o) => /^(no|false|disagree)$/i.test(o.text));
    if (noOption) return noOption.value;
  }

  const firstUsable = nonEmptyOptions.find((option) => option.value);
  return firstUsable?.value;
}

function shouldSelectBooleanOption(field: BrowserField, answer: string) {
  const text = fieldText(field);
  const normalized = answer.toLowerCase().trim();

  if (/yes|true|agree|authorized|eligible|available|willing/.test(normalized)) {
    return true;
  }

  if (/no|false|disagree|not authorized|not eligible|not available/.test(normalized)) {
    return false;
  }

  return field.required && /agree|consent|confirm|acknowledge/.test(text);
}

function isMappingValueValid(mapping: FieldMapping) {
  const key = mapping.dataPoint.toLowerCase();
  const value = mapping.value.trim();

  if (!value) {
    return false;
  }

  if (/url|linkedin|github|twitter|portfolio|website|site/.test(key)) {
    return /^https?:\/\/[^\s]+$/iu.test(value);
  }

  return true;
}

async function selectFromFloatingOptions(page: Page, selector: string, desiredValue: string): Promise<boolean> {
  await page.click(selector);
  await delay(Math.random() * 500 + 200);

  return page.evaluate((desired) => {
    const normalized = desired.toLowerCase().trim();
    const candidates = Array.from(
      document.querySelectorAll('[role="option"], [role="menuitem"], li, div[data-value], div[role="listbox"] div'),
    ) as HTMLElement[];

    const option = candidates.find((element) => {
      const text = element.innerText?.toLowerCase().trim() ?? "";
      const dataValue = element.getAttribute("data-value")?.toLowerCase().trim() ?? "";
      return (
        text === normalized ||
        text.includes(normalized) ||
        normalized.includes(text) ||
        dataValue === normalized ||
        dataValue.includes(normalized)
      );
    });

    option?.click();
    return Boolean(option);
  }, desiredValue);
}

function normalizeDateValue(input: string) {
  const iso = input.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (iso) {
    return input;
  }

  const us = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u);
  if (us) {
    const [, mm, dd, yyyy] = us;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }

  return undefined;
}

async function captureScreenshot(page: Page, runDirectory: string, name: string) {
  const screenshotPath = path.join(runDirectory, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return screenshotPath;
}

function failedResult(options: { payload: AgentApplyPayload; logger: RunLogger } & FailedResultOptions): ApplyResult {
  options.logger.error(options.reason, options.detail);
  return {
    runId: options.logger.runId,
    status: "failed",
    dryRun: options.payload.options?.dryRun ?? true,
    jobUrl: options.payload.jobUrl,
    submitted: false,
    reason: options.reason,
    requiredUnfilledFields: options.requiredUnfilledFields,
    customQuestionsAnswered: options.customQuestionsAnswered ?? 0,
    artifacts: {
      logPath: options.logger.logPath,
      screenshotPath: options.screenshotPath,
    },
    steps: options.logger.steps,
  };
}

function delay(ms: number) {
  // Add ±20% variance to delays to avoid detection
  const variance = (Math.random() - 0.5) * 0.4 * ms;
  const finalMs = Math.max(0, ms + variance);
  return new Promise((resolve) => setTimeout(resolve, finalMs));
}
