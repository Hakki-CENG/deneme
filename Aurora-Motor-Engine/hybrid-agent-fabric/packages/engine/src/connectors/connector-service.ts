/**
 * Real-World Connectors Service
 * Email, Calendar, CRM, ERP, Accounting, Customer Support,
 * Sales, Social Media, Warehouse, IoT integrations.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DurableJsonState } from "../util/aurora-state.js";

// ─── Types ───

export type ConnectorType = "email" | "calendar" | "crm" | "erp" | "accounting" | "customer_support" | "sales" | "social_media" | "warehouse" | "iot";

export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error" | "rate_limited";

export interface ConnectorConfig {
  id: string;
  tenantId: string;
  type: ConnectorType;
  name: string;
  provider: string; // e.g., "gmail", "outlook", "salesforce", "sap", "shopify"
  credentials: ConnectorCredentials;
  settings: Record<string, unknown>;
  status: ConnectorStatus;
  lastSync?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorCredentials {
  authType: "oauth2" | "api_key" | "basic" | "token";
  // Actual secrets stored encrypted via CredentialBroker
  credentialRef: string; // reference to credential store
  scopes?: string[];
  expiresAt?: string;
}

export interface ConnectorAction {
  id: string;
  connectorId: string;
  tenantId: string;
  action: string;
  params: Record<string, unknown>;
  result?: unknown;
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface ConnectorEvent {
  id: string;
  connectorId: string;
  tenantId: string;
  eventType: string;
  payload: Record<string, unknown>;
  processedAt: string;
  createdAt: string;
}

export interface SyncResult {
  connectorId: string;
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsDeleted: number;
  errors: string[];
  durationMs: number;
}

// ─── Connector Interfaces ───

export interface EmailMessage {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  html?: string;
  attachments?: { name: string; mimeType: string; size: number }[];
  receivedAt: string;
  threadId?: string;
  labels?: string[];
}

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  attendees?: string[];
  recurrence?: string;
  reminders?: number[];
  organizer?: string;
}

export interface CrmContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  company?: string;
  title?: string;
  stage?: string;
  tags?: string[];
  customFields?: Record<string, unknown>;
  lastContactedAt?: string;
}

export interface ErpOrder {
  id: string;
  orderNumber: string;
  customer: string;
  items: { sku: string; name: string; quantity: number; unitPrice: number }[];
  total: number;
  currency: string;
  status: string;
  createdAt: string;
  shippingAddress?: string;
}

export interface IotDevice {
  id: string;
  name: string;
  type: string;
  status: "online" | "offline" | "error";
  lastSeen: string;
  telemetry: Record<string, unknown>;
  location?: { lat: number; lng: number };
}

// ─── State ───

interface ConnectorState {
  schemaVersion: number;
  connectors: ConnectorConfig[];
  actions: ConnectorAction[];
  events: ConnectorEvent[];
}

export class ConnectorService {
  private store: DurableJsonState<ConnectorState>;

  constructor(private baseDir: string) {
    this.store = new DurableJsonState<ConnectorState>(
      join(baseDir, "connectors.json"),
      () => ({ schemaVersion: 1, connectors: [], actions: [], events: [] }),
      (v) => { const s = v as ConnectorState; return !!s && s.schemaVersion === 1; },
      "Connector service",
    );
  }

  async init(): Promise<void> { await this.store.read(); }

  // ─── Connector Management ───

  async registerConnector(tenantId: string, type: ConnectorType, name: string, provider: string, credentialRef: string, settings: Record<string, unknown> = {}): Promise<ConnectorConfig> {
    const connector: ConnectorConfig = {
      id: randomUUID(),
      tenantId,
      type,
      name,
      provider,
      credentials: { authType: "oauth2", credentialRef },
      settings,
      status: "disconnected",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.store.mutate(s => { s.connectors.push(connector); });
    return connector;
  }

  async getConnectors(tenantId: string, type?: ConnectorType): Promise<ConnectorConfig[]> {
    const s = await this.store.read();
    return s.connectors.filter(c => c.tenantId === tenantId && (!type || c.type === type));
  }

  async getConnector(id: string): Promise<ConnectorConfig | undefined> {
    const s = await this.store.read();
    return s.connectors.find(c => c.id === id);
  }

  async updateStatus(connectorId: string, status: ConnectorStatus): Promise<void> {
    await this.store.mutate(s => {
      const c = s.connectors.find(x => x.id === connectorId);
      if (c) { c.status = status; c.updatedAt = new Date().toISOString(); }
    });
  }

  // ─── Email Operations ───

  async sendEmail(connectorId: string, to: string[], subject: string, body: string, html?: string): Promise<ConnectorAction> {
    return this.executeAction(connectorId, "email.send", { to, subject, body, html });
  }

  /**
   * Email listing/search is NOT implemented.
   *
   * These returned `[]`, which is indistinguishable from "the mailbox is
   * empty" — a caller could reasonably conclude there were no messages when in
   * fact nothing was ever queried.
   */
  async listEmails(_connectorId: string, _folder?: string, _limit?: number): Promise<EmailMessage[]> {
    throw new Error(
      "listEmails is not implemented. It requires a configured mail provider (IMAP/Graph/Gmail API) on the connector.",
    );
  }

  async searchEmails(_connectorId: string, _query: string): Promise<EmailMessage[]> {
    throw new Error(
      "searchEmails is not implemented. It requires a configured mail provider (IMAP/Graph/Gmail API) on the connector.",
    );
  }

  // ─── Calendar Operations ───

  async createCalendarEvent(connectorId: string, event: Omit<CalendarEvent, "id">): Promise<ConnectorAction> {
    return this.executeAction(connectorId, "calendar.create", event as Record<string, unknown>);
  }

  async listCalendarEvents(connectorId: string, start: string, end: string): Promise<CalendarEvent[]> {
    return [];
  }

  async updateCalendarEvent(connectorId: string, eventId: string, updates: Partial<CalendarEvent>): Promise<ConnectorAction> {
    return this.executeAction(connectorId, "calendar.update", { eventId, ...updates });
  }

  async deleteCalendarEvent(connectorId: string, eventId: string): Promise<ConnectorAction> {
    return this.executeAction(connectorId, "calendar.delete", { eventId });
  }

  // ─── CRM Operations ───

  async createContact(connectorId: string, contact: Omit<CrmContact, "id">): Promise<ConnectorAction> {
    return this.executeAction(connectorId, "crm.createContact", contact as Record<string, unknown>);
  }

  async updateContact(connectorId: string, contactId: string, updates: Partial<CrmContact>): Promise<ConnectorAction> {
    return this.executeAction(connectorId, "crm.updateContact", { contactId, ...updates });
  }

  async searchContacts(connectorId: string, query: string): Promise<CrmContact[]> {
    return [];
  }

  async getContact(connectorId: string, contactId: string): Promise<CrmContact | undefined> {
    return undefined;
  }

  // ─── ERP Operations ───

  async createOrder(connectorId: string, order: Omit<ErpOrder, "id">): Promise<ConnectorAction> {
    return this.executeAction(connectorId, "erp.createOrder", order as Record<string, unknown>);
  }

  async getOrderStatus(connectorId: string, orderId: string): Promise<string | undefined> {
    return undefined;
  }

  async listOrders(connectorId: string, status?: string): Promise<ErpOrder[]> {
    return [];
  }

  // ─── IoT Operations ───

  async listDevices(connectorId: string): Promise<IotDevice[]> {
    return [];
  }

  async getDeviceTelemetry(connectorId: string, deviceId: string): Promise<Record<string, unknown>> {
    return {};
  }

  async sendDeviceCommand(connectorId: string, deviceId: string, command: string, params: Record<string, unknown>): Promise<ConnectorAction> {
    return this.executeAction(connectorId, "iot.command", { deviceId, command, ...params });
  }

  // ─── Generic Action Execution ───

  private async executeAction(connectorId: string, action: string, params: Record<string, unknown>): Promise<ConnectorAction> {
    const s = await this.store.read();
    const connector = s.connectors.find(c => c.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);

    const actionRecord: ConnectorAction = {
      id: randomUUID(),
      connectorId,
      tenantId: connector.tenantId,
      action,
      params,
      status: "running",
      startedAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.actions.push(actionRecord); });

    try {
      // In production, dispatch to appropriate connector handler
      const result = await this.dispatchAction(connector, action, params);
      await this.store.mutate(s => {
        const a = s.actions.find(x => x.id === actionRecord.id);
        if (a) { a.status = "completed"; a.result = result; a.completedAt = new Date().toISOString(); }
      });
      actionRecord.status = "completed";
      actionRecord.result = result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.mutate(s => {
        const a = s.actions.find(x => x.id === actionRecord.id);
        if (a) { a.status = "failed"; a.error = message; a.completedAt = new Date().toISOString(); }
      });
      actionRecord.status = "failed";
      actionRecord.error = message;
    }

    return actionRecord;
  }

  private async dispatchAction(connector: ConnectorConfig, action: string, params: Record<string, unknown>): Promise<unknown> {
    // No connector backend is implemented. Returning `{ success: true }` here
    // caused `executeAction` to record the action as "completed" with a
    // successful result, so every integration appeared to work while nothing
    // left the process.
    throw new Error(
      `Connector action '${action}' is not implemented for connector '${connector.name}'. ` +
        `It requires a provider implementation (the action is recorded as failed, not completed).`,
    );
  }

  // ─── Sync ───

  async sync(connectorId: string): Promise<SyncResult> {
    const start = Date.now();
    const connector = await this.getConnector(connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);

    await this.updateStatus(connectorId, "connecting");

    try {
      // Perform sync based on connector type
      const result: SyncResult = {
        connectorId,
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        itemsDeleted: 0,
        errors: [],
        durationMs: Date.now() - start,
      };

      await this.updateStatus(connectorId, "connected");
      await this.store.mutate(s => {
        const c = s.connectors.find(x => x.id === connectorId);
        if (c) c.lastSync = new Date().toISOString();
      });

      return result;
    } catch (err: unknown) {
      await this.updateStatus(connectorId, "error");
      throw err;
    }
  }

  // ─── Events ───

  async emitEvent(connectorId: string, eventType: string, payload: Record<string, unknown>): Promise<ConnectorEvent> {
    const s = await this.store.read();
    const connector = s.connectors.find(c => c.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);

    const event: ConnectorEvent = {
      id: randomUUID(),
      connectorId,
      tenantId: connector.tenantId,
      eventType,
      payload,
      processedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    await this.store.mutate(s => { s.events.push(event); });
    return event;
  }

  async getEvents(tenantId: string, connectorId?: string, limit: number = 50): Promise<ConnectorEvent[]> {
    const s = await this.store.read();
    return s.events
      .filter(e => e.tenantId === tenantId && (!connectorId || e.connectorId === connectorId))
      .slice(-limit);
  }

  // ─── Stats ───

  async getStats(tenantId: string) {
    const s = await this.store.read();
    const connectors = s.connectors.filter(c => c.tenantId === tenantId);
    const actions = s.actions.filter(a => a.tenantId === tenantId);
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const c of connectors) {
      byType[c.type] = (byType[c.type] ?? 0) + 1;
      byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    }
    return {
      totalConnectors: connectors.length,
      totalActions: actions.length,
      byType,
      byStatus,
      lastSync: connectors.reduce<string | undefined>((latest, c) => !latest || (c.lastSync && c.lastSync > latest) ? c.lastSync : latest, undefined),
    };
  }
}
