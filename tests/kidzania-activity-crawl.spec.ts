import { test, expect } from "@playwright/test";

const START_URL = "https://www.kidzania.jp/tokyo/activity";
const ORIGIN = new URL(START_URL).origin;
const PATH_PREFIX = "/tokyo/activity";

// スモークなので軽量
const SAMPLE_LINKS = 3;

function isSameOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === ORIGIN;
  } catch {
    return false;
  }
}

function normalizeActivityUrl(raw: string): string | null {
  try {
    const u = new URL(raw, ORIGIN);
    if (u.origin !== ORIGIN) return null;
    if (!u.pathname.startsWith(PATH_PREFIX)) return null;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

test.describe("KidZania Activity 完全スモーク（外部除外）", () => {
  test("表示 + 同一ドメインリソース健全性", async ({ page }) => {
    const failures: {
      url: string;
      status?: number;
      type?: string;
      kind: string;
    }[] = [];

    page.on("response", (res) => {
      const url = res.url();

      // 外部は完全除外
      if (!isSameOrigin(url)) return;

      const status = res.status();
      if (status >= 400) {
        failures.push({
          url,
          status,
          type: res.request().resourceType(),
          kind: "http-error",
        });
      }
    });

    page.on("requestfailed", (req) => {
      const url = req.url();

      // 外部は完全除外
      if (!isSameOrigin(url)) return;

      failures.push({
        url,
        type: req.resourceType(),
        kind: `request-failed:${req.failure()?.errorText ?? "unknown"}`,
      });
    });

    // ① メインページ
    await page.goto(START_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await expect(page).toHaveTitle(/.+/);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText.trim().length).toBeGreaterThan(50);

    await page.waitForTimeout(1500);

    // ② 配下リンクを少数だけ確認
    const hrefs = await page.$$eval("a[href]", (as) =>
      as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
    );

    const sampleTargets: string[] = [];

    for (const h of hrefs) {
      const n = normalizeActivityUrl(h);
      if (!n) continue;
      if (!sampleTargets.includes(n)) sampleTargets.push(n);
      if (sampleTargets.length >= SAMPLE_LINKS) break;
    }

    for (const target of sampleTargets) {
      await page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await expect(page).toHaveTitle(/.+/);

      const text = await page.locator("body").innerText();
      expect(text.trim().length).toBeGreaterThan(50);

      await page.waitForTimeout(800);
    }

    // ③ 失敗があればログ出力
    if (failures.length) {
      console.log("==== INTERNAL RESOURCE FAILURES ====");
      for (const f of failures.slice(0, 50)) {
        console.log(
          `- ${f.kind} status=${f.status ?? ""} type=${f.type ?? ""} url=${f.url}`
        );
      }
    }

    expect(failures, `内部リソースエラーが ${failures.length} 件あります`)
      .toHaveLength(0);
  });
});