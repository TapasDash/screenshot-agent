import path from "node:path";
import { appendFile } from "node:fs/promises";
import {
  executeWithApiRetry,
  fetchImageClassification,
  getRequiredEnvironmentVariable,
  resolveModelName,
} from "./ai-service.js";
import {
  appendScreenshotRecord,
  computeFileMd5Hash,
  logEvent,
  readFileSizeBytes,
  resolveDesktopDirectory,
  scanDesktopForScreenshots,
  writeDirectoryManifest,
} from "./file-service.js";
import type {
  DirectoryManifest,
  ManifestTotals,
  ScreenshotRecord,
} from "./types.js";

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
 * Builds aggregate totals from screenshot records.
 */
export const buildManifestTotals = (
  records: ReadonlyArray<ScreenshotRecord>,
): ManifestTotals => {
  const duplicates = records.filter((record) => record.status === "duplicate").length;
  const classified = records.filter((record) => record.status === "classified").length;
  const failed = records.filter((record) =>
    record.status === "api_error" ||
    record.status === "file_error" ||
    record.status === "parse_error",
  ).length;

  return {
    scanned: records.length,
    unique: records.length - duplicates,
    duplicates,
    classified,
    failed,
  };
};

/**
 * Builds the final typed directory manifest object.
 */
export const buildDirectoryManifest = (
  sourceDirectory: string,
  modelName: string,
  records: ReadonlyArray<ScreenshotRecord>,
): DirectoryManifest => ({
  generatedAtIso: new Date().toISOString(),
  sourceDirectory,
  modelName,
  totals: buildManifestTotals(records),
  files: records,
});

/**
 * Classifies a screenshot path and returns an immutable record.
 */
export const classifyScreenshotPath = async (
  absoluteScreenshotPath: string,
  geminiApiKey: string,
  modelName: string,
  existingHashToPathIndex: ReadonlyMap<string, string>,
  runId: string,
  queueIndex: number,
  queueTotal: number,
): Promise<{
  readonly nextRecord: ScreenshotRecord;
  readonly nextHashToPathIndex: ReadonlyMap<string, string>;
}> => {
  const fileName = path.basename(absoluteScreenshotPath);
  const extension = path.extname(absoluteScreenshotPath).toLowerCase();
  const startedAt = Date.now();
  // #region agent log
  emitDebugLog(runId, "H2", "main.ts:classifyScreenshotPath:start", "Started processing screenshot", {
    queueIndex,
    queueTotal,
    fileName,
  });
  // #endregion

  try {
    const [md5Hash, sizeBytes] = await Promise.all([
      computeFileMd5Hash(absoluteScreenshotPath),
      readFileSizeBytes(absoluteScreenshotPath),
    ]);

    const canonicalPath = existingHashToPathIndex.get(md5Hash);
    if (canonicalPath) {
      logEvent({
        stage: "dedupe",
        message: "Detected duplicate screenshot and skipped model call",
        payload: { absoluteScreenshotPath, canonicalPath, md5Hash },
      });

      return {
        nextRecord: {
          absolutePath: absoluteScreenshotPath,
          fileName,
          extension,
          sizeBytes,
          md5Hash,
          status: "duplicate",
          duplicateOf: canonicalPath,
        },
        nextHashToPathIndex: existingHashToPathIndex,
      };
    }

    logEvent({
      stage: "classify",
      message: "Calling Gemini for screenshot classification",
      payload: { absoluteScreenshotPath, modelName },
    });

    const apiOutcome = await executeWithApiRetry(() =>
      fetchImageClassification(
        absoluteScreenshotPath,
        geminiApiKey,
        modelName,
        runId,
      ),
      runId,
    );

    if (!apiOutcome.ok) {
      // #region agent log
      emitDebugLog(runId, "H3", "main.ts:classifyScreenshotPath:api_error", "Gemini classification returned API error", {
        queueIndex,
        fileName,
        errorCode: apiOutcome.error.code,
        retriable: apiOutcome.error.retriable,
        durationMs: Date.now() - startedAt,
      });
      // #endregion
      return {
        nextRecord: {
          absolutePath: absoluteScreenshotPath,
          fileName,
          extension,
          sizeBytes,
          md5Hash,
          status: "api_error",
          error: apiOutcome.error,
        },
        nextHashToPathIndex: new Map(existingHashToPathIndex).set(
          md5Hash,
          absoluteScreenshotPath,
        ),
      };
    }

    return {
      nextRecord: {
        absolutePath: absoluteScreenshotPath,
        fileName,
        extension,
        sizeBytes,
        md5Hash,
        status: "classified",
        classification: apiOutcome.value,
      },
      nextHashToPathIndex: new Map(existingHashToPathIndex).set(
        md5Hash,
        absoluteScreenshotPath,
      ),
    };
  } catch (unknownError) {
    const message =
      unknownError instanceof Error ? unknownError.message : "Unknown file error";

    return {
      nextRecord: {
        absolutePath: absoluteScreenshotPath,
        fileName,
        extension,
        sizeBytes: 0,
        md5Hash: "",
        status: "file_error",
        error: {
          code: "FILE_ERROR",
          message,
          retriable: false,
        },
      },
      nextHashToPathIndex: existingHashToPathIndex,
    };
  } finally {
    // #region agent log
    emitDebugLog(runId, "H2", "main.ts:classifyScreenshotPath:end", "Finished processing screenshot", {
      queueIndex,
      queueTotal,
      fileName,
      durationMs: Date.now() - startedAt,
    });
    // #endregion
  }
};

/**
 * Processes screenshot paths into immutable output records.
 */
export const processScreenshotQueue = async (
  screenshotPaths: ReadonlyArray<string>,
  geminiApiKey: string,
  modelName: string,
  runId: string,
): Promise<ReadonlyArray<ScreenshotRecord>> => {
  type QueueAccumulator = {
    readonly records: ReadonlyArray<ScreenshotRecord>;
    readonly hashToPathIndex: ReadonlyMap<string, string>;
  };

  let accumulator: QueueAccumulator = {
    records: [],
    hashToPathIndex: new Map<string, string>(),
  };

  for (const [index, absoluteScreenshotPath] of screenshotPaths.entries()) {
    const { nextRecord, nextHashToPathIndex } = await classifyScreenshotPath(
      absoluteScreenshotPath,
      geminiApiKey,
      modelName,
      accumulator.hashToPathIndex,
      runId,
      index + 1,
      screenshotPaths.length,
    );

    accumulator = {
      records: appendScreenshotRecord(accumulator.records, nextRecord),
      hashToPathIndex: nextHashToPathIndex,
    };
  }

  return accumulator.records;
};

/**
 * Runs the end-to-end screenshot scanning and classification pipeline.
 */
export const runScreenshotAgent = async (): Promise<DirectoryManifest> => {
  const runId = `run-${Date.now()}`;
  const desktopDirectory = resolveDesktopDirectory();
  const modelName = resolveModelName();
  const geminiApiKey = getRequiredEnvironmentVariable("GEMINI_API_KEY");

  logEvent({
    stage: "bootstrap",
    message: "Initialized screenshot agent runtime",
    payload: { desktopDirectory, modelName },
  });

  // #region agent log
  emitDebugLog(runId, "H1", "main.ts:runScreenshotAgent:env", "Runtime bootstrap state", {
    hasGeminiApiKey: Boolean(geminiApiKey),
    modelName,
    desktopDirectory,
  });
  // #endregion

  const screenshotPaths = await scanDesktopForScreenshots(desktopDirectory);
  // #region agent log
  emitDebugLog(runId, "H1", "main.ts:runScreenshotAgent:scan", "Scan completed with queue size", {
    screenshotCount: screenshotPaths.length,
  });
  // #endregion
  const records = await processScreenshotQueue(
    screenshotPaths,
    geminiApiKey,
    modelName,
    runId,
  );
  const manifest = buildDirectoryManifest(desktopDirectory, modelName, records);

  // #region agent log
  emitDebugLog(runId, "H4", "main.ts:runScreenshotAgent:manifest_before_write", "About to write manifest", {
    totals: manifest.totals,
  });
  // #endregion
  await writeDirectoryManifest(desktopDirectory, manifest);
  // #region agent log
  emitDebugLog(runId, "H4", "main.ts:runScreenshotAgent:manifest_after_write", "Manifest write completed", {
    totals: manifest.totals,
  });
  // #endregion
  logEvent({
    stage: "pipeline",
    message: "Completed screenshot agent pipeline",
    payload: manifest.totals,
  });

  return manifest;
};

runScreenshotAgent().catch((unknownError) => {
  const message =
    unknownError instanceof Error ? unknownError.message : "Unknown fatal pipeline error";
  logEvent({
    stage: "error",
    message: "Unhandled screenshot agent failure",
    payload: { message },
  });
  process.exitCode = 1;
});
