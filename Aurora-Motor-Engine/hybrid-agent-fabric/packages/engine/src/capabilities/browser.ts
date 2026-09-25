import { z } from "zod";
import type { BrowserManager } from "../browser/browser-manager.js";
import { defineCapability } from "./schema.js";

export function browserCapabilities(browser: BrowserManager) {
  return [
    defineCapability(
      { id: "browser.navigate", version: "1.0.0", description: "Navigate the isolated session browser to a public HTTP(S) URL and return a bounded snapshot.", risk: "network", sideEffect: false, source: "core" },
      z.object({ url: z.string().url() }),
      async ({ url }, context) => await browser.navigate(context.sessionId, url),
    ),
    defineCapability(
      { id: "browser.snapshot", version: "1.0.0", description: "Read the current page text and interactive element refs.", risk: "pure", sideEffect: false, source: "core" },
      z.object({ maxTextChars: z.number().int().positive().max(200_000).optional() }),
      async ({ maxTextChars }, context) => await browser.snapshot(context.sessionId, maxTextChars ?? 50_000),
    ),
    defineCapability(
      { id: "browser.click", version: "1.0.0", description: "Click a fresh browser snapshot element reference. May create an external side effect.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ ref: z.string().regex(/^e\d+$/) }),
      async ({ ref }, context) => await browser.click(context.sessionId, ref),
    ),
    defineCapability(
      { id: "browser.type", version: "1.0.0", description: "Fill an element and optionally submit. May create an external side effect.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ ref: z.string().regex(/^e\d+$/), text: z.string().max(100_000), submit: z.boolean().default(false) }),
      async ({ ref, text, submit }, context) => await browser.type(context.sessionId, ref, text, submit),
    ),
    defineCapability(
      { id: "browser.select", version: "1.0.0", description: "Choose an option on a select element by value. May create an external side effect.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ ref: z.string().regex(/^e\d+$/), value: z.string().min(1).max(10_000) }),
      async ({ ref, value }, context) => await browser.select(context.sessionId, ref, value),
    ),
    defineCapability(
      { id: "browser.upload", version: "1.0.0", description: "Upload a file from the assigned workspace to a file input element. The file must exist inside the workspace; paths that escape it are refused.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ ref: z.string().regex(/^e\d+$/), path: z.string().min(1).max(1000) }),
      async ({ ref, path }, context) => await browser.upload(context.sessionId, ref, context.workspacePath, path),
    ),
    defineCapability(
      { id: "browser.press", version: "1.0.0", description: "Press a keyboard key in the isolated browser.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ key: z.string().min(1).max(100) }),
      async ({ key }, context) => await browser.press(context.sessionId, key),
    ),
    defineCapability(
      { id: "computer.click", version: "1.0.0", description: "Click browser coordinates through the computer-use backend.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ x: z.number().min(0).max(10000), y: z.number().min(0).max(10000), button: z.enum(["left", "right", "middle"]).default("left") }),
      async ({ x, y, button }, context) => await browser.clickAt(context.sessionId, x, y, button),
    ),
    defineCapability(
      { id: "computer.type", version: "1.0.0", description: "Type text at the currently focused browser control.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ text: z.string().max(100_000), delayMs: z.number().int().min(0).max(1000).default(0) }),
      async ({ text, delayMs }, context) => await browser.typeText(context.sessionId, text, delayMs),
    ),
    defineCapability(
      { id: "computer.scroll", version: "1.0.0", description: "Scroll the browser viewport by pixel deltas.", risk: "external_side_effect", sideEffect: true, source: "core" },
      z.object({ deltaX: z.number().min(-100000).max(100000).default(0), deltaY: z.number().min(-100000).max(100000) }),
      async ({ deltaX, deltaY }, context) => await browser.scroll(context.sessionId, deltaX, deltaY),
    ),
    defineCapability(
      { id: "browser.screenshot", version: "1.0.0", description: "Save a full-page PNG screenshot inside the assigned workspace.", risk: "workspace_write", sideEffect: true, source: "core" },
      z.object({ path: z.string().min(1) }),
      async ({ path }, context) => await browser.screenshot(context.sessionId, context.workspacePath, path),
    ),
  ];
}
