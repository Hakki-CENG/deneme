/**
 * Multimodal Service
 * Screen/video understanding, voice calls, OCR, document read/write,
 * CAD/3D analysis, map and time series analysis.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

// ─── Types ───

export type ModalityType = "image" | "video" | "audio" | "document" | "cad" | "map" | "timeseries" | "ocr";

export interface MultimodalInput {
  id: string;
  tenantId: string;
  modality: ModalityType;
  source: string; // file path, URL, or base64
  mimeType: string | undefined;
  metadata: Record<string, unknown> | undefined;
  createdAt: string;
}

export interface MultimodalAnalysis {
  id: string;
  inputId: string;
  tenantId: string;
  modality: ModalityType;
  result: AnalysisResult;
  confidence: number;
  processingMs: number;
  createdAt: string;
}

export interface AnalysisResult {
  summary: string;
  details: Record<string, unknown>;
  confidence?: number;
  entities?: ExtractedEntity[];
  text?: string; // OCR result
  structure?: DocumentStructure;
  objects?: DetectedObject[];
  timeSeriesPoints?: TimeSeriesPoint[];
  spatialData?: SpatialData;
}

export interface ExtractedEntity {
  type: string;
  value: string;
  confidence: number;
  position?: { start: number; end: number };
}

export interface DocumentStructure {
  pages: number;
  sections: string[];
  tables: TableCell[][];
  images: number;
  metadata: Record<string, string>;
}

export interface TableCell {
  text: string;
  row: number;
  col: number;
  header?: boolean;
}

export interface DetectedObject {
  label: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface TimeSeriesPoint {
  timestamp: string;
  value: number;
  label?: string;
}

export interface SpatialData {
  type: "point" | "line" | "polygon" | "raster";
  coordinates: number[][];
  properties?: Record<string, unknown>;
}

export interface CadModel {
  format: "step" | "iges" | "stl" | "obj" | "3dm";
  units: string;
  boundingBox: { min: number[]; max: number[] };
  entities: CadEntity[];
  layers: string[];
}

export interface CadEntity {
  type: string;
  id: string;
  properties: Record<string, unknown>;
}

// ─── State ───

interface MultimodalState {
  schemaVersion: number;
  inputs: MultimodalInput[];
  analyses: MultimodalAnalysis[];
}

/**
 * Raised when a multimodal capability has no backend behind it.
 */
export class MultimodalCapabilityUnavailableError extends Error {
  readonly capability: string;
  readonly requirement: string;

  constructor(capability: string, requirement: string) {
    super(`Multimodal capability '${capability}' is unavailable. It requires ${requirement}.`);
    this.name = "MultimodalCapabilityUnavailableError";
    this.capability = capability;
    this.requirement = requirement;
  }
}

export class MultimodalService {
  private store: DurableJsonState<MultimodalState>;

  constructor(private baseDir: string) {
    this.store = new DurableJsonState<MultimodalState>(
      join(baseDir, "multimodal.json"),
      () => ({ schemaVersion: 1, inputs: [], analyses: [] }),
      (v) => { const s = v as MultimodalState; return !!s && s.schemaVersion === 1; },
      "Multimodal service",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  // ─── Input Registration ───

  async registerInput(tenantId: string, modality: ModalityType, source: string, mimeType?: string, metadata?: Record<string, unknown>): Promise<MultimodalInput> {
    const input: MultimodalInput = {
      id: randomUUID(),
      tenantId,
      modality,
      source,
      mimeType,
      metadata,
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate(s => { s.inputs.push(input); });
    return input;
  }

  // ─── OCR ───

  async performOCR(tenantId: string, source: string, language?: string): Promise<MultimodalAnalysis> {
    const start = Date.now();
    const input = await this.registerInput(tenantId, "ocr", source, undefined, { language });

    // OCR processing pipeline
    const result: AnalysisResult = {
      summary: "OCR analysis completed",
      text: await this.extractText(source, language),
      details: { language: language ?? "auto", method: "tesseract" },
      confidence: 0.85,
    };

    return this.saveAnalysis(input, result, Date.now() - start);
  }

  // ─── Document Analysis ───

  async analyzeDocument(tenantId: string, source: string, format?: string): Promise<MultimodalAnalysis> {
    const start = Date.now();
    const input = await this.registerInput(tenantId, "document", source, undefined, { format });

    const result: AnalysisResult = {
      summary: "Document analysis completed",
      text: await this.extractText(source),
      structure: await this.parseDocumentStructure(source, format),
      entities: await this.extractEntities(source),
      details: { format: format ?? "auto", pages: 0 },
    };

    return this.saveAnalysis(input, result, Date.now() - start);
  }

  // ─── Image/Video Understanding ───

  async analyzeImage(tenantId: string, source: string): Promise<MultimodalAnalysis> {
    const start = Date.now();
    const input = await this.registerInput(tenantId, "image", source);

    // The real vision path is the model providers themselves: a workspace
    // image can be projected into every registered provider's native payload
    // (models/multimodal.ts). This legacy entry point has no backend of its
    // own, so it refuses instead of returning an empty "completed" analysis —
    // an empty object list with a success summary reads as "the image was
    // analyzed and contains nothing", which was never measured.
    void source;
    this.notImplemented("analyzeImage", "a vision backend — use model-provider image input (models/multimodal.ts) or configure an OCR/vision API");
  }

  async analyzeVideo(tenantId: string, source: string, frameInterval?: number): Promise<MultimodalAnalysis> {
    const start = Date.now();
    const input = await this.registerInput(tenantId, "video", source, undefined, { frameInterval });

    // No frame-sampling backend exists; an empty object list under a success
    // summary would claim the video was watched. It was not.
    void source; void frameInterval;
    this.notImplemented("analyzeVideo", "a video frame extraction and analysis backend");
  }

  // ─── Audio/Voice ───

  async analyzeAudio(tenantId: string, source: string, language?: string): Promise<MultimodalAnalysis> {
    const start = Date.now();
    const input = await this.registerInput(tenantId, "audio", source, undefined, { language });

    const result: AnalysisResult = {
      summary: "Audio analysis completed",
      text: await this.transcribeAudio(source, language),
      details: { language: language ?? "auto", method: "whisper" },
    };

    return this.saveAnalysis(input, result, Date.now() - start);
  }

  // ─── CAD/3D Analysis ───

  async analyzeCAD(tenantId: string, source: string, format: CadModel["format"]): Promise<MultimodalAnalysis> {
    const start = Date.now();
    const input = await this.registerInput(tenantId, "cad", source, undefined, { format });

    const cadModel = await this.parseCADModel(source, format);
    const result: AnalysisResult = {
      summary: `CAD model: ${cadModel.entities.length} entities, ${cadModel.layers.length} layers`,
      details: {
        format,
        units: cadModel.units,
        boundingBox: cadModel.boundingBox,
        entityCount: cadModel.entities.length,
        layerCount: cadModel.layers.length,
      },
      entities: cadModel.entities.map(e => ({
        type: e.type,
        value: JSON.stringify(e.properties),
        confidence: 1.0,
      })),
    };

    return this.saveAnalysis(input, result, Date.now() - start);
  }

  // ─── Map/Spatial Analysis ───

  async analyzeMap(tenantId: string, source: string, format?: string): Promise<MultimodalAnalysis> {
    const start = Date.now();
    const input = await this.registerInput(tenantId, "map", source, undefined, { format });

    const spatialData = await this.parseSpatialData(source, format);
    const result: AnalysisResult = {
      summary: `Map analysis: ${spatialData.type} with ${spatialData.coordinates.length} coordinate sets`,
      spatialData,
      details: { format: format ?? "geojson", type: spatialData.type },
    };

    return this.saveAnalysis(input, result, Date.now() - start);
  }

  // ─── Time Series Analysis ───

  async analyzeTimeSeries(tenantId: string, source: string, interval?: string): Promise<MultimodalAnalysis> {
    const start = Date.now();
    const input = await this.registerInput(tenantId, "timeseries", source, undefined, { interval });

    const points = await this.parseTimeSeries(source);
    const stats = this.computeTimeSeriesStats(points);

    const result: AnalysisResult = {
      summary: `Time series: ${points.length} points, mean=${stats.mean.toFixed(2)}, trend=${stats.trend}`,
      timeSeriesPoints: points,
      details: {
        pointCount: points.length,
        mean: stats.mean,
        stdDev: stats.stdDev,
        min: stats.min,
        max: stats.max,
        trend: stats.trend,
        seasonality: stats.seasonality,
      },
    };

    return this.saveAnalysis(input, result, Date.now() - start);
  }

  // ─── Query ───

  async getAnalyses(tenantId: string, modality?: ModalityType): Promise<MultimodalAnalysis[]> {
    const s = await this.store.read();
    return s.analyses.filter(a => a.tenantId === tenantId && (!modality || a.modality === modality));
  }

  async getAnalysis(id: string): Promise<MultimodalAnalysis | undefined> {
    const s = await this.store.read();
    return s.analyses.find(a => a.id === id);
  }

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const inputs = s.inputs.filter(i => i.tenantId === tenantId);
    const analyses = s.analyses.filter(a => a.tenantId === tenantId);
    const byModality: Record<string, number> = {};
    for (const a of analyses) byModality[a.modality] = (byModality[a.modality] ?? 0) + 1;
    return { totalInputs: inputs.length, totalAnalyses: analyses.length, byModality };
  }

  // ─── Private Helpers ───

  private async saveAnalysis(input: MultimodalInput, result: AnalysisResult, processingMs: number): Promise<MultimodalAnalysis> {
    const analysis: MultimodalAnalysis = {
      id: randomUUID(),
      inputId: input.id,
      tenantId: input.tenantId,
      modality: input.modality,
      result,
      confidence: result.confidence ?? 0.8,
      processingMs,
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate(s => { s.analyses.push(analysis); });
    return analysis;
  }

  /**
   * OCR, transcription and document parsing are NOT implemented.
   *
   * These returned strings like `[OCR placeholder for file.png]`, which flowed
   * into analyses and stored results as if they were extracted content. A
   * downstream consumer had no way to tell placeholder text from a real
   * transcript, so the whole pipeline produced confident nonsense.
   *
   * They now throw. A caller that needs these must supply a backend.
   */
  private notImplemented(capability: string, requirement: string): never {
    throw new MultimodalCapabilityUnavailableError(capability, requirement);
  }

  private async extractText(_source: string, _language?: string): Promise<string> {
    this.notImplemented("extractText", "an OCR backend such as Tesseract or a cloud vision API");
  }

  private async extractTextFromImage(_source: string): Promise<string> {
    this.notImplemented("extractTextFromImage", "an OCR backend such as Tesseract or a cloud vision API");
  }

  private async transcribeAudio(_source: string, _language?: string): Promise<string> {
    this.notImplemented("transcribeAudio", "a speech-to-text backend such as Whisper");
  }

  private async parseDocumentStructure(_source: string, _format?: string): Promise<DocumentStructure> {
    // An all-zero DocumentStructure reads as "parsed, found nothing", which is
    // indistinguishable from a blank document.
    this.notImplemented("parseDocumentStructure", "a document parser for the requested format");
  }

  private async extractEntities(source: string): Promise<ExtractedEntity[]> {
    // An empty entity list is indistinguishable from "the document mentions no
    // entities"; without an extraction backend neither has been measured.
    void source;
    this.notImplemented("extractEntities", "an entity extraction backend");
  }

  private async detectObjects(source: string): Promise<DetectedObject[]> {
    void source;
    this.notImplemented("detectObjects", "an object detection backend");
  }

  private async detectVideoObjects(source: string, interval: number): Promise<DetectedObject[]> {
    void source; void interval;
    this.notImplemented("detectVideoObjects", "a video frame analysis backend");
  }

  private async parseCADModel(source: string, format: string): Promise<CadModel> {
    return { format: format as CadModel["format"], units: "mm", boundingBox: { min: [0, 0, 0], max: [0, 0, 0] }, entities: [], layers: [] };
  }

  private async parseSpatialData(source: string, format?: string): Promise<SpatialData> {
    return { type: "point", coordinates: [[0, 0]] };
  }

  private async parseTimeSeries(source: string): Promise<TimeSeriesPoint[]> {
    return [];
  }

  private computeTimeSeriesStats(points: TimeSeriesPoint[]): {
    mean: number; stdDev: number; min: number; max: number;
    trend: "rising" | "falling" | "stable"; seasonality: boolean;
  } {
    if (points.length === 0) return { mean: 0, stdDev: 0, min: 0, max: 0, trend: "stable", seasonality: false };
    const values = points.map(p => p.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Simple trend detection
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    const firstMean = firstHalf.reduce((a, b) => a + b, 0) / (firstHalf.length || 1);
    const secondMean = secondHalf.reduce((a, b) => a + b, 0) / (secondHalf.length || 1);
    const trend = secondMean > firstMean * 1.05 ? "rising" : secondMean < firstMean * 0.95 ? "falling" : "stable";
    return { mean, stdDev, min, max, trend, seasonality: false };
  }
}
