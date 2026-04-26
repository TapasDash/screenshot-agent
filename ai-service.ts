import { GoogleGenerativeAI } from "@google/generative-ai";
import path from "node:path";
import { appendFile } from "node:fs/promises";
import { readImageBytes } from "./file-service.js";
import type { ApiOutcome, ClassificationResult, ProcessingError } from "./types.js";

const DEFAULT_MODEL_NAME = "gemini-1.5-flash";
const MAX_API_RETRIES = 4;
const BASE_RETRY_DELAY_MILLISECONDS = 750;
const DEBUG_ENDPOINT =
  "http://127.0.0.1:7287/ingest/b92ba26a-dbdc-4d43-8b08-41b01a806ae7";
const DEBUG_SESSION_ID = "000d40";
const DEBUG_LOG_PATH =
  "/Users/tapasdash/Documents/code/screen-shot-agent/.cursor/debug-000d40.log";

const emitDebugLog = (
  runId: string,
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
): void => {
  const payload = {
    sessionId: DEBUG_SESSION_ID,
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
  appendFile(DEBUG_LOG_PATH, `${JSON.stringify(payload)}\n`, "utf8").catch(
    () => {},
  );
  // #endregion
};

/**
 * Returns the Gemini model name from environment or the default.
 */
export const resolveModelName = (): string =>
  process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL_NAME;

/**
 * Returns a required environment variable value or throws.
 */
export const getRequiredEnvironmentVariable = (environmentVariableName: string): string => {
  const environmentValue = process.env[environmentVariableName];
  if (!environmentValue || !environmentValue.trim()) {
    throw new Error(`Missing required environment variable: ${environmentVariableName}`);
  }
  return environmentValue;
};

/**
 * Creates the strict JSON prompt used for screenshot classification.
 */
export const createClassificationPrompt = (): string =>
  [
    "You are classifying Mac desktop screenshots.",
    "Return only strict JSON with this exact shape:",
    '{"category":"string","confidence":0.0,"summary":"string"}',
    "Rules:",
    "- category: concise label (example: code_editor, terminal, browser, dashboard, chat, design, document, photo, other)",
    "- confidence: number from 0 to 1",
    "- summary: maximum 25 words",
    "- no markdown, no extra keys, no prose",
  ].join("\n");

/**
 * Parses and validates a Gemini response into a strict ClassificationResult.
 */
export const parseClassificationResponse = (rawResponseText: string): ClassificationResult => {
  const cleanedResponseText = rawResponseText
    .trim()
    .replace(/^```json\s*|```$/g, "")
    .trim();

  const parsedResponse = JSON.parse(cleanedResponseText) as
    | Record<string, unknown>
    | undefined;

  const categoryValue = parsedResponse?.category;
  const confidenceValue = parsedResponse?.confidence;
  const summaryValue = parsedResponse?.summary;

  const category =
    typeof categoryValue === "string" ? categoryValue.trim() : "";
  const confidenceNumber =
    typeof confidenceValue === "number"
      ? confidenceValue
      : Number(confidenceValue);
  const summary = typeof summaryValue === "string" ? summaryValue.trim() : "";

  if (!category || !summary || Number.isNaN(confidenceNumber)) {
    throw new Error("Gemini response is missing required classification fields");
  }

  const boundedConfidence = Math.max(0, Math.min(1, confidenceNumber));
  return {
    category,
    confidence: boundedConfidence,
    summary,
  };
};

/**
 * Converts unknown API errors into typed processing errors.
 */
export const normalizeApiError = (unknownError: unknown): ProcessingError => {
  const maybeError = unknownError as {
    readonly message?: string;
    readonly status?: number;
    readonly code?: number | string;
  };

  const message = maybeError.message ?? "Unknown Gemini API error";
  const statusOrCode = Number(maybeError.status ?? maybeError.code);
  const normalizedCode = Number.isFinite(statusOrCode)
    ? String(statusOrCode)
    : "UNKNOWN";

  const retriable =
    normalizedCode === "408" ||
    normalizedCode === "429" ||
    normalizedCode === "500" ||
    normalizedCode === "502" ||
    normalizedCode === "503" ||
    normalizedCode === "504";

  return { code: normalizedCode, message, retriable };
};

/**
 * Sleeps for a specified duration in milliseconds.
 */
export const sleepMilliseconds = async (durationMilliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMilliseconds));

/**
 * Executes a function with retry behavior for retriable API errors.
 */
export const executeWithApiRetry = async <TValue>(
  operation: () => Promise<TValue>,
  runId = "run-unknown",
): Promise<ApiOutcome<TValue>> => {
  for (let attemptIndex = 0; attemptIndex <= MAX_API_RETRIES; attemptIndex += 1) {
    try {
      const value = await operation();
      return { ok: true, value };
    } catch (unknownError) {
      const normalizedError = normalizeApiError(unknownError);
      const isTerminalError =
        normalizedError.code === "403" || normalizedError.code === "404";
      const shouldRetry =
        !isTerminalError &&
        normalizedError.retriable &&
        attemptIndex < MAX_API_RETRIES;

      // #region agent log
      emitDebugLog(runId, "H3", "ai-service.ts:executeWithApiRetry:catch", "Gemini call failed during retry wrapper", {
        attemptIndex,
        code: normalizedError.code,
        retriable: normalizedError.retriable,
        shouldRetry,
      });
      // #endregion

      if (!shouldRetry) {
        return { ok: false, error: normalizedError };
      }

      const backoffDelay =
        BASE_RETRY_DELAY_MILLISECONDS * 2 ** attemptIndex;
      await sleepMilliseconds(backoffDelay);
    }
  }

  return {
    ok: false,
    error: {
      code: "UNREACHABLE",
      message: "Retry loop ended unexpectedly",
      retriable: false,
    },
  };
};

/**
 * Classifies a screenshot image using Gemini multimodal vision.
 */
export const fetchImageClassification = async (
  absoluteImagePath: string,
  geminiApiKey: string,
  modelName: string,
  runId = "run-unknown",
): Promise<ClassificationResult> => {
  const imageBuffer = await readImageBytes(absoluteImagePath);
  const mimeType =
    path.extname(absoluteImagePath).toLowerCase() === ".png"
      ? "image/png"
      : "image/jpeg";

  const geminiClient = new GoogleGenerativeAI(geminiApiKey);
  const generativeModel = geminiClient.getGenerativeModel({ model: modelName });

  const modelResponse = await generativeModel.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: createClassificationPrompt() },
          {
            inlineData: {
              data: imageBuffer.toString("base64"),
              mimeType,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
    },
  });

  // #region agent log
  emitDebugLog(runId, "H5", "ai-service.ts:fetchImageClassification:response", "Gemini returned response text", {
    imagePathBaseName: path.basename(absoluteImagePath),
    responseLength: modelResponse.response.text().length,
  });
  // #endregion

  return parseClassificationResponse(modelResponse.response.text());
};
