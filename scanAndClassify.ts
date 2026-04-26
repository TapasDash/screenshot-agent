import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";

type ClassificationResult = {
  category: string;
  confidence: number;
  summary: string;
};

type FileRecord = {
  path: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  md5: string;
  status:
    | "classified"
    | "duplicate"
    | "api_error"
    | "read_error"
    | "parse_error";
  duplicateOf?: string;
  classification?: ClassificationResult;
  error?: {
    code: string;
    message: string;
    retriable: boolean;
  };
};

type Manifest = {
  runAt: string;
  sourceDir: string;
  model: string;
  totals: {
    scanned: number;
    unique: number;
    duplicates: number;
    classified: number;
    failed: number;
  };
  files: FileRecord[];
};

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_RETRIES = 4;
const BASE_RETRY_DELAY_MS = 750;
const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

const nowIso = (): string => new Date().toISOString();

const log = (scope: string, message: string, data?: unknown): void => {
  const line = `[${nowIso()}] [${scope}] ${message}`;
  if (data === undefined) {
    console.log(line);
    return;
  }
  console.log(`${line} ${JSON.stringify(data)}`);
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const normalizeError = (
  error: unknown,
): { code: string; message: string; retriable: boolean } => {
  const asAny = error as {
    message?: string;
    status?: number;
    code?: number | string;
  };
  const message = asAny?.message ?? "Unknown Gemini API error";
  const statusMaybe = Number(asAny?.status ?? asAny?.code);
  const normalizedCode = Number.isFinite(statusMaybe)
    ? String(statusMaybe)
    : "UNKNOWN";

  const retriable =
    normalizedCode === "429" ||
    normalizedCode === "408" ||
    normalizedCode === "500" ||
    normalizedCode === "502" ||
    normalizedCode === "503" ||
    normalizedCode === "504";

  return { code: normalizedCode, message, retriable };
};

const scanDirectoryForImages = async (sourceDir: string): Promise<string[]> => {
  log("scan", "Scanning directory for image files", { sourceDir });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase()),
    )
    .map((name) => path.join(sourceDir, name));
  log("scan", "Image discovery complete", { found: files.length });
  return files;
};

const md5OfFile = async (filePath: string): Promise<string> => {
  const bytes = await readFile(filePath);
  const digest = createHash("md5").update(bytes).digest("hex");
  log("hash", "Generated MD5", { filePath, md5: digest });
  return digest;
};

const createVisionPrompt = (): string =>
  [
    "You are a screenshot classifier.",
    "Return ONLY strict JSON with this exact shape:",
    '{"category":"string","confidence":0.0,"summary":"string"}',
    "Rules:",
    "- category: concise high-level label (e.g. code_editor, terminal, browser, design_mockup, dashboard, chat, document, photo, other)",
    "- confidence: number between 0 and 1",
    "- summary: max 25 words",
    "- no markdown fences, no extra keys, no prose",
  ].join("\n");

const parseClassificationResponse = (rawText: string): ClassificationResult => {
  const cleaned = rawText
    .trim()
    .replace(/^```json\s*|```$/g, "")
    .trim();
  const parsed = JSON.parse(cleaned) as Partial<ClassificationResult>;
  const category =
    typeof parsed.category === "string" ? parsed.category.trim() : "";
  const confidenceRaw =
    typeof parsed.confidence === "number"
      ? parsed.confidence
      : Number(parsed.confidence);
  const summary =
    typeof parsed.summary === "string" ? parsed.summary.trim() : "";

  if (!category || !summary || Number.isNaN(confidenceRaw)) {
    throw new Error(
      "Gemini response missing required keys or invalid value types",
    );
  }

  const confidence = Math.max(0, Math.min(1, confidenceRaw));
  return { category, confidence, summary };
};

const classifyWithGemini = async (
  modelName: string,
  apiKey: string,
  imagePath: string,
): Promise<ClassificationResult> => {
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
  const imageBytes = await readFile(imagePath);
  const imageBase64 = imageBytes.toString("base64");

  log("vision", "Preparing Gemini request", {
    imagePath,
    mimeType,
    sizeBytes: imageBytes.length,
    modelName,
  });

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: modelName });
  const prompt = createVisionPrompt();

  const response = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              data: imageBase64,
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

  const text = response.response.text();
  log("vision", "Gemini response received", {
    imagePath,
    rawLength: text.length,
  });
  return parseClassificationResponse(text);
};

const withApiResilience = async <T>(
  operationName: string,
  operation: () => Promise<T>,
): Promise<
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; retriable: boolean } }
> => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      log("api", "Calling Gemini API", {
        operationName,
        attempt,
        maxRetries: MAX_RETRIES,
      });
      const value = await operation();
      return { ok: true, value };
    } catch (error) {
      const normalized = normalizeError(error);
      const terminal403Or404 =
        normalized.code === "403" || normalized.code === "404";
      const willRetry =
        !terminal403Or404 && normalized.retriable && attempt < MAX_RETRIES;
      log("api", "Gemini call failed", {
        operationName,
        attempt,
        code: normalized.code,
        retriable: normalized.retriable,
        willRetry,
        message: normalized.message,
      });
      if (!willRetry) {
        return { ok: false, error: normalized };
      }
      const delayMs = BASE_RETRY_DELAY_MS * 2 ** attempt;
      await sleep(delayMs);
    }
  }
  return {
    ok: false,
    error: {
      code: "UNREACHABLE",
      message: "Retry loop exhausted unexpectedly",
      retriable: false,
    },
  };
};

const buildManifest = (
  sourceDir: string,
  model: string,
  files: FileRecord[],
): Manifest => {
  const duplicates = files.filter((f) => f.status === "duplicate").length;
  const classified = files.filter((f) => f.status === "classified").length;
  const failed = files.filter(
    (f) =>
      f.status === "api_error" ||
      f.status === "read_error" ||
      f.status === "parse_error",
  ).length;
  const unique = files.length - duplicates;
  return {
    runAt: nowIso(),
    sourceDir,
    model,
    totals: {
      scanned: files.length,
      unique,
      duplicates,
      classified,
      failed,
    },
    files,
  };
};

const scanAndClassify = async (
  sourceDir: string,
  apiKey: string,
  model = DEFAULT_MODEL,
): Promise<Manifest> => {
  log("pipeline", "Starting scanAndClassify", { sourceDir, model });
  const imagePaths = await scanDirectoryForImages(sourceDir);
  const hashToCanonicalPath = new Map<string, string>();
  const records: FileRecord[] = [];

  for (const imagePath of imagePaths) {
    const fileName = path.basename(imagePath);
    const extension = path.extname(imagePath).toLowerCase();
    log("pipeline", "Processing file", { imagePath });

    try {
      const [fileStat, md5] = await Promise.all([
        stat(imagePath),
        md5OfFile(imagePath),
      ]);
      const existingPath = hashToCanonicalPath.get(md5);

      if (existingPath) {
        log("dedupe", "Duplicate detected, skipping Gemini", {
          imagePath,
          duplicateOf: existingPath,
          md5,
        });
        records.push({
          path: imagePath,
          fileName,
          extension,
          sizeBytes: fileStat.size,
          md5,
          status: "duplicate",
          duplicateOf: existingPath,
        });
        continue;
      }

      hashToCanonicalPath.set(md5, imagePath);

      const result = await withApiResilience("classify-image", () =>
        classifyWithGemini(model, apiKey, imagePath),
      );

      if (!result.ok) {
        records.push({
          path: imagePath,
          fileName,
          extension,
          sizeBytes: fileStat.size,
          md5,
          status: "api_error",
          error: result.error,
        });
        continue;
      }

      records.push({
        path: imagePath,
        fileName,
        extension,
        sizeBytes: fileStat.size,
        md5,
        status: "classified",
        classification: result.value,
      });
      log("pipeline", "File classified", {
        imagePath,
        classification: result.value,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown file processing error";
      log("pipeline", "File processing failed before classification", {
        imagePath,
        message,
      });
      records.push({
        path: imagePath,
        fileName,
        extension,
        sizeBytes: 0,
        md5: "",
        status: "read_error",
        error: {
          code: "READ_ERROR",
          message,
          retriable: false,
        },
      });
    }
  }

  const manifest = buildManifest(sourceDir, model, records);
  const manifestPath = path.join(sourceDir, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  log("pipeline", "Manifest written", {
    manifestPath,
    totals: manifest.totals,
  });
  return manifest;
};

const getRequiredEnv = (key: string): string => {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

const main = async (): Promise<void> => {
  const sourceDirArg = process.argv[2]
    ? path.resolve(process.argv[2])
    : process.cwd();
  const apiKey = getRequiredEnv("GEMINI_API_KEY");
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const manifest = await scanAndClassify(sourceDirArg, apiKey, model);
  log("main", "Pipeline completed", manifest.totals);
};

main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Unknown fatal error";
  log("fatal", "Unhandled pipeline failure", { message });
  process.exitCode = 1;
});
