import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  DirectoryManifest,
  LogEvent,
  ScreenshotRecord,
} from "./types.js";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const MAC_SCREENSHOT_NAME_PATTERN = /^(Screenshot|Screen Shot)\s/i;

/**
 * Emits high-signal structured logs for file-service stages.
 */
export const logEvent = <TPayload extends object>(
  event: LogEvent<TPayload>,
): void => {
  const timestamp = new Date().toISOString();
  console.log(
    `[${timestamp}] [${event.stage}] ${event.message} ${JSON.stringify(event.payload)}`,
  );
};

/**
 * Resolves the default desktop directory where Mac screenshots are stored.
 */
export const resolveDesktopDirectory = (): string =>
  path.join(os.homedir(), "Desktop");

/**
 * Returns true when a file name matches the macOS screenshot naming pattern.
 */
export const isMacScreenshot = (fileName: string): boolean =>
  MAC_SCREENSHOT_NAME_PATTERN.test(fileName);

/**
 * Returns true when the file extension is supported by the classifier pipeline.
 */
export const isSupportedImageExtension = (fileName: string): boolean =>
  SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());

/**
 * Scans a directory and returns absolute paths for files matching Mac screenshot filters.
 */
export const scanDesktopForScreenshots = async (
  desktopDirectory: string,
): Promise<ReadonlyArray<string>> => {
  logEvent({
    stage: "scan",
    message: "Scanning desktop directory for screenshot candidates",
    payload: { desktopDirectory },
  });

  const directoryEntries = await readdir(desktopDirectory, {
    withFileTypes: true,
  });

  const screenshotPaths = directoryEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => isMacScreenshot(fileName))
    .filter((fileName) => isSupportedImageExtension(fileName))
    .map((fileName) => path.join(desktopDirectory, fileName));

  logEvent({
    stage: "scan",
    message: "Completed screenshot file discovery",
    payload: { discoveredCount: screenshotPaths.length },
  });

  return screenshotPaths;
};

/**
 * Reads a file and returns its MD5 hash as a lowercase hexadecimal string.
 */
export const computeFileMd5Hash = async (absoluteFilePath: string): Promise<string> => {
  const fileBytes = await readFile(absoluteFilePath);
  const md5Hash = createHash("md5").update(fileBytes).digest("hex");

  logEvent({
    stage: "hash",
    message: "Computed screenshot hash",
    payload: { absoluteFilePath, md5Hash },
  });

  return md5Hash;
};

/**
 * Reads the file size from filesystem metadata.
 */
export const readFileSizeBytes = async (absoluteFilePath: string): Promise<number> => {
  const fileStats = await stat(absoluteFilePath);
  return fileStats.size;
};

/**
 * Reads raw image bytes for multimodal model input.
 */
export const readImageBytes = async (
  absoluteFilePath: string,
): Promise<Readonly<Buffer>> => readFile(absoluteFilePath);

/**
 * Writes the manifest JSON file to the source directory.
 */
export const writeDirectoryManifest = async (
  outputDirectory: string,
  manifest: DirectoryManifest,
): Promise<string> => {
  const outputPath = path.join(outputDirectory, "manifest.json");
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  logEvent({
    stage: "manifest",
    message: "Wrote manifest output file",
    payload: { outputPath, recordCount: manifest.files.length },
  });

  return outputPath;
};

/**
 * Creates a new immutable array with a screenshot record appended.
 */
export const appendScreenshotRecord = (
  existingRecords: ReadonlyArray<ScreenshotRecord>,
  nextRecord: ScreenshotRecord,
): ReadonlyArray<ScreenshotRecord> => [...existingRecords, nextRecord];
