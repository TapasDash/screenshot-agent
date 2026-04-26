export type LogStage =
  | "bootstrap"
  | "scan"
  | "hash"
  | "dedupe"
  | "classify"
  | "manifest"
  | "pipeline"
  | "error";

export type ProcessingStatus =
  | "classified"
  | "duplicate"
  | "file_error"
  | "api_error"
  | "parse_error";

export interface ClassificationResult {
  readonly category: string;
  readonly confidence: number;
  readonly summary: string;
}

export interface ProcessingError {
  readonly code: string;
  readonly message: string;
  readonly retriable: boolean;
}

export interface ScreenshotRecord {
  readonly absolutePath: string;
  readonly fileName: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly md5Hash: string;
  readonly status: ProcessingStatus;
  readonly duplicateOf?: string;
  readonly classification?: ClassificationResult;
  readonly error?: ProcessingError;
}

export interface ManifestTotals {
  readonly scanned: number;
  readonly unique: number;
  readonly duplicates: number;
  readonly classified: number;
  readonly failed: number;
}

export interface DirectoryManifest {
  readonly generatedAtIso: string;
  readonly sourceDirectory: string;
  readonly modelName: string;
  readonly totals: ManifestTotals;
  readonly files: ReadonlyArray<ScreenshotRecord>;
}

export interface LogEvent<TPayload extends object> {
  readonly stage: LogStage;
  readonly message: string;
  readonly payload: TPayload;
}

export interface ApiResult<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

export interface ApiFailure {
  readonly ok: false;
  readonly error: ProcessingError;
}

export type ApiOutcome<TValue> = ApiResult<TValue> | ApiFailure;
