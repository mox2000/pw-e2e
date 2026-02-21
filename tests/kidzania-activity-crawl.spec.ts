import { test, expect } from "@playwright/test";

const START_URL = "https://www.kidzania.jp/tokyo/activity";
const ORIGIN = new URL(START_URL).origin;
const PATH_PREFIX = "/tokyo/activity";

// サイト負荷を考慮した安全装置（必要なら調整）
const MAX_PAGES = 120;       // 最大巡回ページ数
const MAX_FAILURES = 30;     // これ以上失敗が出たら打ち切り
const PAGE_TIMEOUT_MS = 45_000;
const AFTER_LOAD_WAIT_MS = 1500;

type Failure = {
  pageUrl: string;
  resourceUrl: string;
  kind: "http-error" | "request-failed" | "timeout";
  status?: number;
  resourceType?: string;
  errorText?: string;
};

function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw, ORIGIN);

    // 同一オリジンのみ
    if (u.origin !== ORIGIN) return null;

    // /tokyo/activity 配下のみ
    if (!u.pathname.startsWith(PATH_PREFIX)) return null;

    // 重複削減（必要なら search は残してもOK）
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

async function extractLinks(page): Promise<string[]> {
  const hrefs: string[] = await page.$$eval("a[href]", (as) =>
    as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
  );

  const out = new Set<string>();
  for (const h of hrefs) {
    const n = normalizeUrl(h);
    if (n) out.add(n);
  }
  return [...out];
}

test.describe("Kidzania /tokyo/activity 配下の表示（リソース含む）", () => {
  test("配下ページ巡回 + 主要リソースがエラー無しで取得できる", async ({ page }) => {
    const queue: string[] = [START_URL];
    const visited = new Set<string>();
    const failures: Failure[] = [];

    while (queue.length && visited.size < MAX_PAGES && failures.length < MAX_FAILURES) {
      const url = queue.shift()!;
      const normalized = normalizeUrl(url) ?? url;
      if (visited.has(normalized)) continue;
      visited.add(normalized);

      const pageFailures: Failure[] = [];

      const onRequestFailed = (req) => {
        pageFailures.push({
          pageUrl: normalized,
          resourceUrl: req.url(),
          kind: "request-failed",
          resourceType: req.resourceType(),
          errorText: req.failure()?.errorText,
        });
      };

      const onResponse = (res) => {
        const status = res.status();
        if (status >= 400) {
          pageFailures.push({
            pageUrl: normalized,
            resourceUrl: res.url(),
            status,
            kind: "http-error",
            resourceType: res.request().resourceType(),
          });
        }
      };

      page.on("requestfailed", onRequestFailed);
      page.on("response", onResponse);

      try {
        await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
        // 画像など遅延読み込み対策で少し待つ（必要なら調整）
        await page.waitForTimeout(AFTER_LOAD_WAIT_MS);

        const links = await extractLinks(page);
        for (const l of links) if (!visited.has(l)) queue.push(l);
      } catch (e: any) {
        pageFailures.push({
          pageUrl: normalized,
          resourceUrl: normalized,
          kind: "timeout",
          errorText: String(e?.message ?? e),
        });
      } finally {
        page.off("requestfailed", onRequestFailed);
        page.off("response", onResponse);
      }

      failures.push(...pageFailures);

      // 進捗ログ（CodeBuildログで追える）
      console.log(
        `[crawl] visited=${visited.size}/${MAX_PAGES} queue=${queue.length} newFailures=${pageFailures.length} totalFailures=${failures.length} url=${normalized}`
      );
    }

    // 失敗があればテスト失敗にする（失敗一覧を出す）
    if (failures.length) {
      console.log("==== FAILURES (first 200) ====");
      for (const f of failures.slice(0, 200)) {
        console.log(
          `- [${f.kind}] page=${f.pageUrl}\n  resource=${f.resourceUrl}\n  status=${f.status ?? ""} type=${f.resourceType ?? ""} err=${f.errorText ?? ""}\n`
        );
      }
    }

    expect(failures, `リソース取得エラーが ${failures.length} 件あります`).toHaveLength(0);
  });
});