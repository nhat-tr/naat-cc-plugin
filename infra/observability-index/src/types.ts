// Output schema for observability index files.
//
// logs.json example entry:
// {
//   "file": "Hoffmann.Calibration.Core.Extensions.Tec/Sap/SapSyncService.cs",
//   "line": 87,
//   "namespace": "Hoffmann.Calibration.Core.Extensions.Tec.Sap",
//   "class": "SapSyncService",
//   "method": "SynchronizeOrderItems",
//   "level": "Information",
//   "template": "SAP Sync is not necessary for a calibration order (ID: {CustomerOrderId} SAP Order: {CustomerOrderSapCalibrationOrderId}",
//   "structured": true,
//   "properties": ["CustomerOrderId", "CustomerOrderSapCalibrationOrderId"],
//   "hasTraceContext": true,
//   "pattern": "ILogger structured"
// }
//
// traces.json example entry:
// {
//   "file": "Hoffmann.Calibration.Core.ClientsDI/ProductClient.cs",
//   "line": 246,
//   "namespace": "Hoffmann.Calibration.Core.ClientsDI",
//   "class": "ProductClient",
//   "method": "SendAsync",
//   "spanName": "ProductClient.GetProduct",
//   "pattern": "RunInActivity"
// }

export interface LogEntry {
  file: string;
  line: number;
  namespace: string;
  class: string;
  method: string;
  level: string;
  template: string;
  structured: boolean;
  properties: string[];
  hasTraceContext: boolean;
  pattern: string;
  // Tier 2 enrichment (optional)
  callers?: string[];
  callees?: string[];
}

export interface TraceEntry {
  file: string;
  line: number;
  namespace: string;
  class: string;
  method: string;
  spanName: string;
  pattern: string;
  eventType?: string;
  // Tier 2 enrichment (optional)
  callers?: string[];
  callees?: string[];
}

export interface IndexMetadata {
  generated: string;   // ISO 8601 timestamp
  commit: string;      // git short hash
  config: string;      // config file path used (relative to toolkit root)
  tier: 1 | 2;
}

export interface IndexFile<T> {
  metadata: IndexMetadata;
  entries: T[];
}

// Config types — mirrors the YAML structure in configs/dotnet.yaml

export type StructuredMode = true | false | 'detect';

export interface PatternConfig {
  name: string;
  category: 'log' | 'trace';
  regex: string;
  structured?: StructuredMode;
  capture_groups?: Record<string, string>;
}

export interface ExtractorConfig {
  file_globs: string[];
  exclude_globs: string[];
  include_submodules: boolean;
  patterns: PatternConfig[];
  extends?: string;
}
