import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { assertSafeUrl } from "../capabilities/web.js";

export interface BrowserManagerOptions {
  cdpEndpoint?: string;
  executablePath?: string;
  headless?: boolean;
  navigationTimeoutMs?: number;
  allowPrivateCdpEndpoint?: boolean;
}

interface ElementRef {
  selector: string;
  index: number;
  tag: string;
  role?: string;
  name?: string;
}

interface SessionBrowser {
  context: BrowserContext;
  page: Page;
  refs: Map<string, ElementRef>;
  /** P1.36: per-session action history for loop detection and effect verification. */
  history: Array<{ action: string; target: string; snapshotHash: string }>;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: Array<{ ref: string; tag: string; role?: string; name?: string; type?: string; href?: string }>;
  /**
   * P1.36 action verification: for snapshots returned by an action, whether
   * the page measurably changed versus the previous snapshot, with both
   * hashes so a caller can audit the comparison.
   */
  actionEffect?: { changed: boolean; previousHash?: string; currentHash: string };
}

export class BrowserManager {
  private browser: Browser | undefined;
  private readonly sessions = new Map<string, SessionBrowser>();

  constructor(private readonly options: BrowserManagerOptions) {}

  get configured(): boolean {
    return Boolean(this.options.cdpEndpoint || this.options.executablePath);
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.options.cdpEndpoint) {
      const endpoint = this.options.allowPrivateCdpEndpoint
        ? new URL(this.options.cdpEndpoint)
        : await assertSafeUrl(this.options.cdpEndpoint);
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:" && endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
        throw new Error("CDP endpoint must use HTTP(S) or WS(S).");
      }
      this.browser = await chromium.connectOverCDP(endpoint.toString(), { timeout: 15_000 });
    } else if (this.options.executablePath) {
      this.browser = await chromium.launch({
        executablePath: this.options.executablePath,
        headless: this.options.headless ?? true,
        args: ["--disable-dev-shm-usage", "--no-first-run", "--disable-background-networking"],
      });
    } else throw new Error("Browser automation is not configured. Set HAF_BROWSER_CDP_ENDPOINT or HAF_BROWSER_EXECUTABLE_PATH.");
    return this.browser;
  }

  private async session(sessionId: string): Promise<SessionBrowser> {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.page.isClosed()) return existing;
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: { width: 1440, height: 1000 },
    });
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        await route.continue();
        return;
      }
      try {
        await assertSafeUrl(url);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(this.options.navigationTimeoutMs ?? 30_000);
    const state: SessionBrowser = { context, page, refs: new Map(), history: [] };
    this.sessions.set(sessionId, state);
    return state;
  }

  async navigate(sessionId: string, rawUrl: string): Promise<BrowserSnapshot> {
    const url = await assertSafeUrl(rawUrl);
    const state = await this.session(sessionId);
    await state.page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    // Revalidate the final redirect URL against private-network targets.
    await assertSafeUrl(state.page.url());
    return await this.snapshot(sessionId);
  }

  async snapshot(sessionId: string, maxTextChars = 50_000, maxElements = 200): Promise<BrowserSnapshot> {
    const state = await this.session(sessionId);
    const bodyText = await state.page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    state.refs.clear();
    const selector = "a,button,input,textarea,select,[role='button'],[role='link'],[contenteditable='true']";
    const locator = state.page.locator(selector);
    const count = Math.min(await locator.count(), maxElements);
    const elements: BrowserSnapshot["elements"] = [];
    for (let index = 0; index < count; index++) {
      const item = locator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const data = await item.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || undefined,
        name: element.getAttribute("aria-label") || element.getAttribute("name") || (element.textContent || "").trim().slice(0, 200) || undefined,
        type: element.getAttribute("type") || undefined,
        href: element.getAttribute("href") || undefined,
      }));
      const ref = `e${elements.length}`;
      state.refs.set(ref, { selector, index, tag: data.tag, ...(data.role ? { role: data.role } : {}), ...(data.name ? { name: data.name } : {}) });
      elements.push({
        ref,
        tag: data.tag,
        ...(data.role ? { role: data.role } : {}),
        ...(data.name ? { name: data.name } : {}),
        ...(data.type ? { type: data.type } : {}),
        ...(data.href ? { href: data.href } : {}),
      });
    }
    return {
      url: state.page.url(),
      title: await state.page.title(),
      text: bodyText.slice(0, maxTextChars),
      truncated: bodyText.length > maxTextChars,
      elements,
    };
  }

  private async locatorFor(sessionId: string, ref: string) {
    const state = await this.session(sessionId);
    const target = state.refs.get(ref);
    if (!target) throw new Error(`Unknown or stale browser element ref ${ref}; take a fresh snapshot.`);
    return state.page.locator(target.selector).nth(target.index);
  }

  /**
   * P1.36: hash a snapshot for comparison. Covers identity (url/title), the
   * visible text and the interactive element set — the things an action could
   * change. Content outside these is not claimed.
   */
  private static hashSnapshot(snapshot: Pick<BrowserSnapshot, "url" | "title" | "text" | "elements">): string {
    const digest = createHash("sha256");
    digest.update(snapshot.url);
    digest.update("\u0000");
    digest.update(snapshot.title);
    digest.update("\u0000");
    digest.update(snapshot.text);
    digest.update("\u0000");
    digest.update(snapshot.elements.map((element) => `${element.ref}:${element.tag}:${element.name ?? ""}:${element.href ?? ""}`).join("|"));
    return digest.digest("hex").slice(0, 32);
  }

  /**
   * P1.36: wrap an action with effect verification and loop detection. The
   * returned snapshot carries whether the page changed; the session history
   * records the action, and a repeated action that never changes the page is
   * refused instead of being allowed to spin forever.
   */
  private async performAction(
    sessionId: string,
    action: string,
    target: string,
    effect: () => Promise<void>,
  ): Promise<BrowserSnapshot> {
    const state = await this.session(sessionId);
    const previous = state.history.at(-1)?.snapshotHash;
    await effect();
    const snapshot = await this.snapshot(sessionId);
    const currentHash = BrowserManager.hashSnapshot(snapshot);
    snapshot.actionEffect = { changed: previous !== undefined && previous !== currentHash, ...(previous ? { previousHash: previous } : {}), currentHash };
    state.history.push({ action, target, snapshotHash: currentHash });
    if (state.history.length > 20) state.history.shift();
    const loop = detectActionLoop(state.history);
    if (loop.loop) {
      throw new Error(`Browser action loop suspected: ${loop.reason}. Take a fresh snapshot and choose a different action.`);
    }
    return snapshot;
  }

  async click(sessionId: string, ref: string): Promise<BrowserSnapshot> {
    const locator = await this.locatorFor(sessionId, ref);
    return await this.performAction(sessionId, "click", ref, async () => {
      await locator.click();
    });
  }

  /** P1.36: choose an option on a select element by value. */
  async select(sessionId: string, ref: string, value: string): Promise<BrowserSnapshot> {
    const locator = await this.locatorFor(sessionId, ref);
    return await this.performAction(sessionId, "select", `${ref}:${value}`, async () => {
      await locator.selectOption(value);
    });
  }

  /** P1.36: upload a workspace file to a file input element. The file must exist inside the assigned workspace. */
  async upload(sessionId: string, ref: string, workspacePath: string, requestedPath: string): Promise<BrowserSnapshot> {
    const root = resolve(workspacePath);
    const target = resolve(root, requestedPath);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Upload path escapes the workspace.");
    // Resolve symlinks and re-check: an upload must not follow a link out of
    // the workspace any more than a read would.
    const real = await realpath(target).catch(() => {
      throw new Error(`Upload file "${requestedPath}" does not exist in the workspace.`);
    });
    const realRel = relative(await realpath(root), real);
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || realRel.startsWith(sep)) throw new Error("Upload path escapes the workspace.");
    const locator = await this.locatorFor(sessionId, ref);
    return await this.performAction(sessionId, "upload", `${ref}:${requestedPath}`, async () => {
      await locator.setInputFiles(real);
    });
  }

  async type(sessionId: string, ref: string, text: string, submit = false): Promise<BrowserSnapshot> {
    const locator = await this.locatorFor(sessionId, ref);
    return await this.performAction(sessionId, "type", `${ref}:${text}:${submit ? 1 : 0}`, async () => {
      await locator.fill(text);
      if (submit) await locator.press("Enter");
    });
  }

  async press(sessionId: string, key: string): Promise<BrowserSnapshot> {
    const state = await this.session(sessionId);
    return await this.performAction(sessionId, "press", key, async () => {
      await state.page.keyboard.press(key);
    });
  }

  async clickAt(sessionId: string, x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<BrowserSnapshot> {
    const state = await this.session(sessionId);
    return await this.performAction(sessionId, "clickAt", `${x},${y},${button}`, async () => {
      await state.page.mouse.click(x, y, { button });
    });
  }

  async typeText(sessionId: string, text: string, delayMs = 0): Promise<BrowserSnapshot> {
    const state = await this.session(sessionId);
    return await this.performAction(sessionId, "typeText", `${text}:${delayMs}`, async () => {
      await state.page.keyboard.type(text, { delay: delayMs });
    });
  }

  async scroll(sessionId: string, deltaX: number, deltaY: number): Promise<BrowserSnapshot> {
    const state = await this.session(sessionId);
    return await this.performAction(sessionId, "scroll", `${deltaX},${deltaY}`, async () => {
      await state.page.mouse.wheel(deltaX, deltaY);
    });
  }

  async screenshot(sessionId: string, workspacePath: string, requestedPath: string): Promise<{ path: string; bytes: number }> {
    const root = resolve(workspacePath);
    const target = resolve(root, requestedPath);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("Screenshot path escapes the workspace.");
    await mkdir(dirname(target), { recursive: true });
    const state = await this.session(sessionId);
    const bytes = await state.page.screenshot({ path: target, fullPage: true, type: "png" });
    return { path: requestedPath, bytes: bytes.length };
  }

  async closeSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    await state.context.close();
    this.sessions.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
    await this.browser?.close();
    this.browser = undefined;
  }
}

/**
 * P1.36 anti-loop: an action is a loop when the same action on the same
 * target was just repeated and the page did not change between attempts —
 * the agent is pressing a button that does nothing. A repeated action whose
 * page DID change is a retry that is doing something, and is allowed.
 */
export function detectActionLoop(
  history: ReadonlyArray<{ action: string; target: string; snapshotHash: string }>,
  lookback = 3,
): { loop: boolean; reason?: string } {
  if (history.length < lookback) return { loop: false };
  const recent = history.slice(-lookback)!;
  const first = recent[0]!;
  if (!recent.every((entry) => entry.action === first.action && entry.target === first.target)) {
    return { loop: false };
  }
  if (recent.every((entry) => entry.snapshotHash === first.snapshotHash)) {
    return { loop: true, reason: `${first.action} on ${first.target} was repeated ${lookback} times with no page change` };
  }
  return { loop: false };
}
