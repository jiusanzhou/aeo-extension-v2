/**
 * AEO Auto-Login
 * 
 * 自动同步 AEO 后台登录态（从 Web localStorage）
 * 
 * 流程：
 *   1. 已有 apiKey → 验证 /v1/auth/me
 *   2. 从 AEO 前端 tab 读 localStorage.aeo_token
 *   3. 引导用户登录（打开前端登录页）
 */

import { Storage } from "@plasmohq/storage";

const storage = new Storage({ area: "local" });

const AEO_API_BASE =
  (typeof process !== "undefined" && process.env?.PLASMO_PUBLIC_AEO_API_BASE) ||
  "https://aeo-ex9.pages.dev";

interface MeResponse {
  user: {
    id: string;
    email: string;
    name?: string;
  };
}

/**
 * 推导 AEO 前端 URL
 */
function aeoFrontendUrl(apiBaseUrl: string): string {
  if (!apiBaseUrl) return "https://aeo-ex9.pages.dev";
  if (apiBaseUrl.includes("localhost")) return "http://localhost:5173";
  return apiBaseUrl.replace("aeo-api", "aeo").replace("/api", "");
}

/**
 * 验证 token
 */
async function fetchMe(apiBaseUrl: string, token: string): Promise<MeResponse> {
  const response = await fetch(`${apiBaseUrl}/v1/auth/me`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Auth failed: ${response.status}`);
  }
  return response.json();
}

/**
 * 自动同步 AEO 登录态
 */
export async function autoSyncAeoToken(
  opts: { openLoginIfMissing?: boolean } = { openLoginIfMissing: true },
): Promise<void> {
  const apiBaseUrl = AEO_API_BASE;

  // Step 1: 验证已有 token
  const existingKey = await storage.get<string>("aeoApiKey");
  if (existingKey) {
    try {
      const me = await fetchMe(apiBaseUrl, existingKey);
      console.log(`[AEO] Auto-sync: existing token valid for ${me.user.email}`);
      return;
    } catch (e) {
      console.warn("[AEO] Auto-sync: existing token invalid, clearing");
      await storage.remove("aeoApiKey");
      await storage.remove("aeoWorkerUuid");
    }
  }

  // Step 2: 从 AEO 前端 tab 读 localStorage
  const frontUrl = aeoFrontendUrl(apiBaseUrl);
  const allTabs = await chrome.tabs.query({});
  const webTab = allTabs.find((t) => t.url?.startsWith(frontUrl));
  
  if (webTab?.id) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: webTab.id },
        world: "MAIN",
        func: () => {
          try {
            return localStorage.getItem("aeo_token");
          } catch {
            return null;
          }
        },
      });
      
      const token = results[0]?.result;
      if (token) {
        const me = await fetchMe(apiBaseUrl, token);
        await storage.set("aeoApiKey", token);
        await storage.set("aeoUserEmail", me.user.email);
        
        console.log(`[AEO] Auto-sync: synced from web → ${me.user.email}`);
        
        // 通知用户
        try {
          chrome.notifications?.create({
            type: "basic",
            iconUrl: chrome.runtime.getURL("icon48.plasmo.png"),
            title: "AEO Helper",
            message: `已自动登录：${me.user.email}`,
          });
        } catch {
          /* notifications optional */
        }
        return;
      }
    } catch (e) {
      console.warn("[AEO] Auto-sync: read localStorage failed", e);
    }
  }

  // Step 3: 引导登录
  if (opts.openLoginIfMissing) {
    console.log(`[AEO] Auto-sync: no login found, opening ${frontUrl}/login`);
    await chrome.tabs.create({ url: `${frontUrl}/login`, active: true });
  } else {
    console.log("[AEO] Auto-sync: no login found (silent mode)");
  }
}
