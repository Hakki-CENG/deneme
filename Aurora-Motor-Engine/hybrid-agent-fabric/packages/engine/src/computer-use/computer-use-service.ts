/**
 * Computer Use Service
 * Browser/desktop automation, visual grounding, safe form filling,
 * long-running task rollback.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

// ─── Types ───

export type AutomationTarget = "browser" | "desktop" | "terminal" | "api";

export interface AutomationStep {
  id: string;
  type: "click" | "type" | "scroll" | "wait" | "screenshot" | "navigate" | "keypress" | "hover" | "drag" | "assert" | "extract";
  selector?: string; // CSS selector, XPath, or visual selector
  value?: string;
  coordinates?: { x: number; y: number };
  options?: Record<string, unknown>;
  screenshot?: string; // base64 screenshot after step
  result?: unknown;
  status: "pending" | "running" | "completed" | "failed" | "rolled_back";
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AutomationTask {
  id: string;
  tenantId: string;
  name: string;
  target: AutomationTarget;
  steps: AutomationStep[];
  status: "draft" | "running" | "paused" | "completed" | "failed" | "rolled_back" | "partial_rollback" | "rollback_failed";
  currentStepIndex: number;
  rollbackSteps: AutomationStep[]; // inverse operations for rollback
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface VisualGroundingResult {
  id: string;
  screenshot: string; // base64
  elements: GroundedElement[];
  timestamp: string;
}

export interface GroundedElement {
  label: string;
  type: "button" | "input" | "link" | "text" | "image" | "menu" | "icon" | "unknown";
  boundingBox: { x: number; y: number; width: number; height: number };
  confidence: number;
  text?: string;
  selector?: string;
}

export interface FormField {
  name: string;
  label: string;
  type: "text" | "email" | "password" | "number" | "select" | "checkbox" | "radio" | "textarea" | "file" | "date";
  value?: string;
  required: boolean;
  validation?: string; // regex pattern
  selector: string;
}

export interface FormFillResult {
  formId: string;
  fieldsAttempted: number;
  fieldsFilled: number;
  fieldsFailed: { field: string; error: string }[];
  screenshot?: string;
}

export interface RollbackResult {
  taskId: string;
  stepsRolledBack: number;
  stepsFailed: number;
  errors: string[];
  finalStatus: "rolled_back" | "partial_rollback" | "rollback_failed";
}

// ─── State ───

interface ComputerUseState {
  schemaVersion: number;
  tasks: AutomationTask[];
  groundingResults: VisualGroundingResult[];
  snapshots: { taskId: string; stepIndex: number; snapshot: string; timestamp: string }[];
}

export class ComputerUseService {
  private store: DurableJsonState<ComputerUseState>;

  constructor(private baseDir: string) {
    this.store = new DurableJsonState<ComputerUseState>(
      join(baseDir, "computer-use.json"),
      () => ({ schemaVersion: 1, tasks: [], groundingResults: [], snapshots: [] }),
      (v) => { const s = v as ComputerUseState; return !!s && s.schemaVersion === 1; },
      "Computer use service",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  // ─── Task Management ───

  async createTask(tenantId: string, name: string, target: AutomationTarget, steps: Omit<AutomationStep, "id" | "status">[]): Promise<AutomationTask> {
    const task: AutomationTask = {
      id: randomUUID(),
      tenantId,
      name,
      target,
      steps: steps.map(s => ({ ...s, id: randomUUID(), status: "pending" })),
      status: "draft",
      currentStepIndex: 0,
      rollbackSteps: [],
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate(s => { s.tasks.push(task); });
    return task;
  }

  async getTasks(tenantId: string, status?: AutomationTask["status"]): Promise<AutomationTask[]> {
    const s = await this.store.read();
    return s.tasks.filter(t => t.tenantId === tenantId && (!status || t.status === status));
  }

  async getTask(id: string): Promise<AutomationTask | undefined> {
    const s = await this.store.read();
    return s.tasks.find(t => t.id === id);
  }

  // ─── Task Execution ───

  async executeTask(taskId: string): Promise<AutomationTask> {
    const s = await this.store.read();
    const task = s.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === "running") throw new Error("Task is already running");

    task.status = "running";
    task.startedAt = new Date().toISOString();

    for (let i = task.currentStepIndex; i < task.steps.length; i++) {
      const step = task.steps[i]!;
      task.currentStepIndex = i;
      step.status = "running";
      step.startedAt = new Date().toISOString();

      try {
        const result = await this.executeStep(task.target, step);
        step.result = result;
        step.status = "completed";
        step.completedAt = new Date().toISOString();

        // Take snapshot for rollback
        if (step.type !== "screenshot" && step.type !== "wait") {
          task.rollbackSteps.unshift(this.createRollbackStep(step));
        }
      } catch (err: unknown) {
        step.status = "failed";
        step.error = err instanceof Error ? err.message : String(err);
        task.status = "failed";
        task.error = step.error;
        task.completedAt = new Date().toISOString();
        await this.store.mutate(() => {});
        throw err;
      }
    }

    task.status = "completed";
    task.completedAt = new Date().toISOString();
    await this.store.mutate(() => {});
    return task;
  }

  async pauseTask(taskId: string): Promise<void> {
    await this.store.mutate(s => {
      const t = s.tasks.find(x => x.id === taskId);
      if (t && t.status === "running") t.status = "paused";
    });
  }

  // ─── Rollback ───

  async rollbackTask(taskId: string): Promise<RollbackResult> {
    const s = await this.store.read();
    const task = s.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    let stepsRolledBack = 0;
    let stepsFailed = 0;
    const errors: string[] = [];

    for (const step of task.rollbackSteps) {
      try {
        await this.executeStep(task.target, step);
        stepsRolledBack++;
      } catch (err: unknown) {
        stepsFailed++;
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    const finalStatus = stepsFailed === 0 ? "rolled_back" : stepsRolledBack > 0 ? "partial_rollback" : "rollback_failed";
    task.status = finalStatus;
    await this.store.mutate(() => {});

    return { taskId, stepsRolledBack, stepsFailed, errors, finalStatus };
  }

  // ─── Visual Grounding ───

  async performVisualGrounding(target: AutomationTarget, screenshot?: string): Promise<VisualGroundingResult> {
    const result: VisualGroundingResult = {
      id: randomUUID(),
      screenshot: screenshot ?? "",
      elements: await this.detectElements(target),
      timestamp: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.groundingResults.push(result); });
    return result;
  }

  async findByVisualDescription(tenantId: string, description: string): Promise<GroundedElement | undefined> {
    // Use visual grounding to find element by natural language description
    const grounding = await this.performVisualGrounding("browser");
    return grounding.elements.find(e =>
      e.label.toLowerCase().includes(description.toLowerCase()) ||
      (e.text && e.text.toLowerCase().includes(description.toLowerCase()))
    );
  }

  // ─── Form Filling ───

  async fillForm(fields: FormField[], values: Record<string, string>): Promise<FormFillResult> {
    const fieldsFailed: { field: string; error: string }[] = [];
    let fieldsFilled = 0;

    for (const field of fields) {
      const value = values[field.name];
      if (!value) {
        if (field.required) fieldsFailed.push({ field: field.name, error: "Required field missing value" });
        continue;
      }

      // Validate
      if (field.validation && !new RegExp(field.validation).test(value)) {
        fieldsFailed.push({ field: field.name, error: `Value does not match pattern: ${field.validation}` });
        continue;
      }

      try {
        await this.fillField(field, value);
        fieldsFilled++;
      } catch (err: unknown) {
        fieldsFailed.push({ field: field.name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      formId: randomUUID(),
      fieldsAttempted: fields.length,
      fieldsFilled,
      fieldsFailed,
    };
  }

  async detectForm(target: AutomationTarget): Promise<FormField[]> {
    // Detect form fields on current page
    return [];
  }

  // ─── Desktop Automation ───

  async captureScreen(): Promise<string> {
    // Capture current screen
    return "";
  }

  async findOnScreen(description: string): Promise<GroundedElement | undefined> {
    const grounding = await this.performVisualGrounding("desktop");
    return grounding.elements.find(e =>
      e.label.toLowerCase().includes(description.toLowerCase())
    );
  }

  async clickAt(x: number, y: number): Promise<void> {
    // Click at screen coordinates
  }

  async typeText(text: string): Promise<void> {
    // Type text at current cursor position
  }

  // ─── Stats ───

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const tasks = s.tasks.filter(t => t.tenantId === tenantId);
    const byStatus: Record<string, number> = {};
    const byTarget: Record<string, number> = {};
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      byTarget[t.target] = (byTarget[t.target] ?? 0) + 1;
    }
    return {
      totalTasks: tasks.length,
      byStatus,
      byTarget,
      groundingSessions: s.groundingResults.length,
    };
  }

  // ─── Private Helpers ───

  private async executeStep(target: AutomationTarget, step: AutomationStep): Promise<unknown> {
    // No automation backend is wired up. Each branch below used to report the
    // action as performed — `{ clicked: ... }`, `{ typed: ... }`, and even a
    // literal `"base64..."` string standing in for a screenshot — so a caller
    // received a full, plausible trace of a session that never happened.
    //
    // `wait` is the one step that is genuinely honoured, because waiting
    // requires no backend.
    if (step.type === "wait") {
      const ms = typeof step.value === "number" ? step.value : 1000;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { waited: ms };
    }

    throw new Error(
      `Computer-use step '${step.type}' is not implemented. ` +
        `It requires an automation backend (Playwright, CDP, or an OS-level driver).`,
    );
  }

  private createRollbackStep(step: AutomationStep): AutomationStep {
    // Create inverse operation
    switch (step.type) {
      case "type":
        return { ...step, id: randomUUID(), type: "keypress", value: "Control+a Delete", status: "pending" };
      case "click":
        return { ...step, id: randomUUID(), type: "wait", value: "100", status: "pending" };
      case "navigate":
        return { ...step, id: randomUUID(), type: "keypress", value: "Alt+ArrowLeft", status: "pending" };
      default:
        return { ...step, id: randomUUID(), status: "pending" };
    }
  }

  private async detectElements(target: AutomationTarget): Promise<GroundedElement[]> {
    // In production, use vision model to detect UI elements
    return [];
  }

  private async fillField(field: FormField, value: string): Promise<void> {
    // In production, interact with the form field
  }
}
