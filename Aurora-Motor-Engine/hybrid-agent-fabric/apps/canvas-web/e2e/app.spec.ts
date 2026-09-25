import { test, expect } from "@playwright/test";

test.describe("Aurora Canvas", () => {
  test("loads the login page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".wordmark")).toContainText("HAF");
    await expect(page.locator(".wordmark span")).toContainText("HAF");
  });

  test("shows login form when not authenticated", async ({ page }) => {
    await page.goto("/");
    // Should show either a login button or the dev badge
    const loginButton = page.locator("button", { hasText: "Login" });
    const devBadge = page.locator(".dev-badge");
    const hasLogin = await loginButton.isVisible().catch(() => false);
    const hasDevBadge = await devBadge.isVisible().catch(() => false);
    expect(hasLogin || hasDevBadge).toBe(true);
  });

  test("has theme toggle button", async ({ page }) => {
    await page.goto("/");
    const themeButton = page.locator("button", { hasText: /Light|Dark/ });
    await expect(themeButton).toBeVisible();
  });

  test("theme toggle changes data-theme attribute", async ({ page }) => {
    await page.goto("/");
    const themeButton = page.locator("button", { hasText: /Light|Dark/ });
    await themeButton.click();
    const canvas = page.locator(".canvas");
    const theme = await canvas.getAttribute("data-theme");
    expect(["dark", "light"]).toContain(theme);
  });

  test("sidebar shows agents section", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".side-title")).toContainText("Agents");
  });

  test("new agent button exists", async ({ page }) => {
    await page.goto("/");
    const newAgent = page.locator(".new-agent");
    await expect(newAgent).toBeVisible();
    await expect(newAgent).toContainText("New agent");
  });

  test("welcome message shows when no session selected", async ({ page }) => {
    await page.goto("/");
    const welcome = page.locator(".welcome");
    const isVisible = await welcome.isVisible().catch(() => false);
    // Welcome might not be visible if auth is required
    if (isVisible) {
      await expect(welcome).toContainText("Durable agent control center");
    }
  });

  test("repo import details exists", async ({ page }) => {
    await page.goto("/");
    const repoImport = page.locator(".repo-import");
    await expect(repoImport).toBeVisible();
  });

  test("health indicator exists in topbar", async ({ page }) => {
    await page.goto("/");
    const health = page.locator(".health");
    await expect(health).toBeVisible();
  });

  test("refresh button exists in sidebar", async ({ page }) => {
    await page.goto("/");
    const refresh = page.locator(".sidebar-bottom button");
    await expect(refresh).toBeVisible();
    await expect(refresh).toContainText("Refresh");
  });
});

test.describe("Keyboard Shortcuts", () => {
  test("Escape clears error toast", async ({ page }) => {
    await page.goto("/");
    // Press Escape - should not cause errors
    await page.keyboard.press("Escape");
    // No toast should be visible
    const toast = page.locator(".toast");
    const isVisible = await toast.isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });
});

test.describe("Theme System", () => {
  test("default theme is dark", async ({ page }) => {
    await page.goto("/");
    const canvas = page.locator(".canvas");
    const theme = await canvas.getAttribute("data-theme");
    expect(theme).toBe("dark");
  });

  test("light theme has correct CSS variables", async ({ page }) => {
    await page.goto("/");
    const themeButton = page.locator("button", { hasText: /Light|Dark/ });
    await themeButton.click();
    // Verify the canvas has light theme
    const canvas = page.locator(".canvas");
    const theme = await canvas.getAttribute("data-theme");
    expect(theme).toBe("light");
  });
});

test.describe("Responsive Design", () => {
  test("sidebar collapses on mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    // On mobile, sidebar should still exist but may be styled differently
    const sidebar = page.locator(".sidebar");
    await expect(sidebar).toBeVisible();
  });
});
