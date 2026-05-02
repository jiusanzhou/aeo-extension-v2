/**
 * AEO Backend Client
 *
 * 对接 AEO 后端 API（对齐 apps/extension/lib/api.ts 的真实接口）
 *
 * 职责：
 *   1. 心跳上报（POST /v1/workers/heartbeat）
 *   2. 账号上报（POST /v1/workers/{uuid}/accounts/report）
 *   3. 任务订阅（GET /v1/publish/tasks/stream via SSE）
 *   4. 任务事件（POST /v1/publish/tasks/{id}/events）
 */

import { Storage } from "@plasmohq/storage";
import { refreshAccountInfo } from "~sync/account";
import { type SyncData, createTabsForPlatforms, getPlatformInfos, infoMap } from "~sync/common";
import { autoSyncAeoToken } from "./aeo-auth";

const storage = new Storage({ area: "local" });

// AEO 后端地址（通过 PLASMO_PUBLIC_AEO_API_BASE 环境变量配置）
const AEO_API_BASE =
  (typeof process !== "undefined" && process.env?.PLASMO_PUBLIC_AEO_API_BASE) || "https://aeo-api.wencai.app";

// ================== 类型定义 ==================

interface AEOWorkerAccount {
  platform: string;
  platformUserId: string;
  displayName?: string;
  avatarUrl?: string;
  identity?: {
    platformUserId?: string;
    displayName?: string;
    avatarUrl?: string;
    extra?: Record<string, unknown>;
  };
  externalAccountId?: string;
  isActive?: boolean;
}

interface AEOTaskReadyEvent {
  taskId: string;
  platform: string;
  articleId?: string;
  workerAccountId?: string;
}

// ================== 平台名映射 ==================

/**
 * 任务下发时的平台名映射。
 *
 * AEO 后端发布任务的 task.platform 是 AEO 业务平台名（xiaohongshu/zhihu/...），
 * MultiPost 发布需要的是完整 platform key（DYNAMIC_REDNOTE/ARTICLE_ZHIHU/...）。
 * 此 map 仅用于任务下发时查表。
 *
 * ⚠️ 注意与账号上报区分：
 *   - 账号上报 / 白名单 / worker_accounts.platform 都是 MultiPost accountKey
 *     （rednote/douyin/...），不走这个映射
 *   - 只有任务下发场景（task.platform → MultiPost SyncData）用这个
 */
const AEO_PLATFORM_TO_MULTIPOST: Record<string, string> = {
  // 动态原生
  xiaohongshu: "DYNAMIC_REDNOTE",
  douyin: "DYNAMIC_DOUYIN",
  x: "DYNAMIC_X",
  bilibili: "DYNAMIC_BILIBILI",
  toutiao: "DYNAMIC_TOUTIAO",
  baijia: "DYNAMIC_BAIJIAHAO",
  weibo: "DYNAMIC_WEIBO",
  zhihu: "DYNAMIC_ZHIHU",
  kuaishou: "DYNAMIC_KUAISHOU",
  jike: "DYNAMIC_OKJIKE",
  douban: "DYNAMIC_DOUBAN",
  juejin: "DYNAMIC_JUEJIN",

  // 仅 VIDEO 类型
  tiktok: "VIDEO_TIKTOK",
  qie: "VIDEO_QIE",
  chejiahao: "VIDEO_CHEJIAHAO",
  dewu: "VIDEO_DEWU",
  vivovideo: "VIDEO_VIVOVIDEO",
  alipay: "VIDEO_ALIPAY",
  yiche: "VIDEO_YICHE",
  sohu: "VIDEO_SOHU",
  netease: "VIDEO_NETEASE",
  dayu: "VIDEO_DAYU",
  yidian: "VIDEO_YIDIAN",
  pinduoduo: "VIDEO_PINDUODUO",

  // 国际平台
  linkedin: "DYNAMIC_LINKEDIN",
  facebook: "DYNAMIC_FACEBOOK",
  instagram: "DYNAMIC_INSTAGRAM",
  threads: "DYNAMIC_THREADS",
  reddit: "DYNAMIC_REDDIT",
  bluesky: "DYNAMIC_BLUESKY",
};

// ================== 全局平台白名单 ==================

const ENABLED_PLATFORMS_STORAGE_KEY = "aeoEnabledPlatforms";
const ENABLED_PLATFORMS_FETCHED_AT_KEY = "aeoEnabledPlatformsFetchedAt";
const ENABLED_PLATFORMS_TTL_MS = 10 * 60 * 1000; // 10 分钟缓存
const DEFAULT_ENABLED_PLATFORMS = ["rednote"]; // 后端不可达时的兜底（MultiPost accountKey）

/**
 * 拉取后端下发的全局平台白名单（MultiPost accountKey 列表，如 ["rednote", "douyin"]）。
 * 10 分钟 TTL 缓存，避免每次心跳都打接口。
 */
async function getEnabledPlatforms(forceRefresh = false): Promise<string[]> {
  if (!forceRefresh) {
    const cached = await storage.get<string[]>(ENABLED_PLATFORMS_STORAGE_KEY);
    const fetchedAt = await storage.get<number>(ENABLED_PLATFORMS_FETCHED_AT_KEY);
    if (cached && cached.length > 0 && fetchedAt && Date.now() - fetchedAt < ENABLED_PLATFORMS_TTL_MS) {
      return cached;
    }
  }

  try {
    const { platforms } = await apiRequest<{ platforms: string[] }>("/v1/workers/enabled-platforms");
    if (Array.isArray(platforms) && platforms.length > 0) {
      await storage.set(ENABLED_PLATFORMS_STORAGE_KEY, platforms);
      await storage.set(ENABLED_PLATFORMS_FETCHED_AT_KEY, Date.now());
      console.log(`[AEO] Enabled platforms (from backend): ${platforms.join(", ")}`);
      return platforms;
    }
  } catch (error) {
    console.warn("[AEO] Failed to fetch enabled platforms, using cache/default:", (error as Error).message);
  }

  // 接口失败时：先用过期缓存，最后兜底默认值
  const cached = await storage.get<string[]>(ENABLED_PLATFORMS_STORAGE_KEY);
  if (cached && cached.length > 0) return cached;
  return [...DEFAULT_ENABLED_PLATFORMS];
}

// ================== 工具函数 ==================

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = await storage.get<string>("aeoApiKey");
  if (!apiKey) {
    throw new Error("[AEO] No API key configured");
  }

  const response = await fetch(`${AEO_API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`[AEO] API ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

// ================== 心跳 ==================

/**
 * Worker 心跳 — 上报扩展状态
 * 返回后端分配的 Worker UUID
 */
export async function aeoHeartbeat(): Promise<string | null> {
  const apiKey = await storage.get<string>("aeoApiKey");
  if (!apiKey) {
    console.log("[AEO] No API key, skipping heartbeat");
    return null;
  }

  const manifest = chrome.runtime.getManifest();
  const extId = chrome.runtime.id;

  try {
    const { worker_id: workerUuid } = await apiRequest<{ worker_id: string }>("/v1/workers/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        worker_type: "extension",
        worker_id: extId, // 客户端 ID（扩展自己的 ID）
        name: manifest.name,
        metadata: {
          version: manifest.version,
          browser: "chrome",
          userAgent: navigator.userAgent,
          powered_by: "multipost",
        },
      }),
    });

    await storage.set("aeoWorkerUuid", workerUuid);
    console.log(`[AEO] Heartbeat success, uuid=${workerUuid}`);

    // 上报账号
    await reportAccounts(workerUuid);

    return workerUuid;
  } catch (error) {
    console.warn("[AEO] Heartbeat failed:", (error as Error).message);
    return null;
  }
}

// ================== 账号上报 ==================

async function reportAccounts(workerUuid: string): Promise<void> {
  try {
    // 1. 拉取后端下发的全局平台白名单（MultiPost accountKey 列表）
    const targetAccountKeys = await getEnabledPlatforms();

    if (targetAccountKeys.length === 0) {
      console.log("[AEO] Empty whitelist, skip");
      await storage.set("aeoAccountsSnapshot", []);
      await storage.set("aeoAccountsRefreshedAt", Date.now());
      return;
    }

    console.log(`[AEO] Refreshing accounts for: ${targetAccountKeys.join(", ")}`);

    // 2. 串行刷新（并发请求各平台 API 容易触发反爬）
    const refreshResults: Array<{
      platform: string;
      status: "logged_in" | "failed";
      accountInfo?: { accountId: string; username: string; avatarUrl?: string };
    }> = [];

    for (const accountKey of targetAccountKeys) {
      try {
        const info = await refreshAccountInfo(accountKey);
        if (info) {
          refreshResults.push({ platform: accountKey, status: "logged_in", accountInfo: info });
        } else {
          refreshResults.push({ platform: accountKey, status: "failed" });
        }
      } catch {
        refreshResults.push({ platform: accountKey, status: "failed" });
      }
    }

    const loggedIn = refreshResults.filter((r) => r.status === "logged_in").length;
    const failed = refreshResults.filter((r) => r.status === "failed").length;
    console.log(`[AEO] Account refresh: ${loggedIn} logged in, ${failed} failed/not-logged-in`);

    // 3. 收集已刷新成功的账号信息上报
    const enabledSet = new Set(targetAccountKeys);
    const platformInfos = await getPlatformInfos();
    const accounts: AEOWorkerAccount[] = platformInfos
      .filter((p) => p.accountInfo && enabledSet.has(p.accountKey))
      .map((p) => ({
        platform: p.accountKey, // 直接用 MultiPost accountKey
        platformUserId: p.accountInfo!.accountId,
        displayName: p.accountInfo!.username,
        avatarUrl: p.accountInfo!.avatarUrl,
        identity: {
          platformUserId: p.accountInfo!.accountId,
          displayName: p.accountInfo!.username,
          avatarUrl: p.accountInfo!.avatarUrl,
        },
        externalAccountId: p.accountInfo!.accountId,
        isActive: true,
      }));

    if (accounts.length === 0) {
      console.log("[AEO] No accounts to report");
      await storage.set("aeoAccountsSnapshot", refreshResults);
      await storage.set("aeoAccountsRefreshedAt", Date.now());
      return;
    }

    const reportRes = await apiRequest<{
      reported: number;
      accounts: Array<{ id: string; platform: string; platformUserId: string }>;
    }>(`/v1/workers/${workerUuid}/accounts/report`, {
      method: "POST",
      body: JSON.stringify({ accounts }),
    });

    // 缓存 worker_account.id 列表 —— SSE 订阅时带上，后端据此过滤任务归属账号
    const accountIds = (reportRes.accounts || []).map((a) => a.id).filter(Boolean);
    await storage.set("aeoWorkerAccountIds", accountIds);
    // 保存账号 snapshot 给 popup 用
    await storage.set("aeoAccountsSnapshot", refreshResults);
    await storage.set("aeoAccountsRefreshedAt", Date.now());
    console.log(
      `[AEO] Reported ${accounts.length} accounts: ${accounts.map((a) => a.platform).join(", ")} (ids=${accountIds.length})`,
    );
  } catch (error) {
    console.warn("[AEO] Report accounts failed:", (error as Error).message);
  }
}

// ================== 任务订阅 (SSE) ==================

let currentSSE: { abort: () => void } | null = null;

/**
 * 启动任务订阅 — 使用 fetch streaming 实现 SSE（支持自定义 header）
 */
export async function aeoStartTaskSubscription(): Promise<void> {
  if (currentSSE) {
    console.log("[AEO] Task subscription already running");
    return;
  }

  const apiKey = await storage.get<string>("aeoApiKey");
  const workerUuid = await storage.get<string>("aeoWorkerUuid");
  const accountIds = await storage.get<string[]>("aeoWorkerAccountIds");
  if (!apiKey || !workerUuid) {
    console.log("[AEO] Missing credentials, cannot start task subscription");
    return;
  }

  const params = new URLSearchParams({
    workerId: workerUuid,
    workerType: "extension",
  });
  if (accountIds && accountIds.length > 0) {
    params.set("accountIds", accountIds.join(","));
  }

  const url = `${AEO_API_BASE}/v1/publish/tasks/stream?${params.toString()}`;
  const controller = new AbortController();
  currentSSE = { abort: () => controller.abort() };

  console.log(`[AEO] Starting task subscription (workerId=${workerUuid}, accountIds=${accountIds?.length || 0})`);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    console.log("[AEO] Task subscription connected");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const rawEvent of events) {
        const lines = rawEvent.split("\n");
        let eventType = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;

        if (eventType === "task_ready") {
          try {
            const task: AEOTaskReadyEvent = JSON.parse(data);
            console.log("[AEO] Task ready:", task);
            await handleTaskReady(task);
          } catch (error) {
            console.error("[AEO] Parse task_ready error:", error);
          }
        } else if (eventType === "ping") {
          // 心跳，忽略
        }
      }
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      console.warn("[AEO] Task subscription error:", (error as Error).message);
    }
  } finally {
    currentSSE = null;
    // 5 秒后重连
    setTimeout(aeoStartTaskSubscription, 5000);
  }
}

// ================== 任务执行 ==================

async function handleTaskReady(task: AEOTaskReadyEvent): Promise<void> {
  const apiKey = await storage.get<string>("aeoApiKey");
  const workerUuid = await storage.get<string>("aeoWorkerUuid");
  if (!apiKey || !workerUuid) return;

  // 1. Claim 任务
  try {
    await apiRequest(`/v1/publish/tasks/${task.taskId}/claim`, {
      method: "POST",
      body: JSON.stringify({ workerId: workerUuid }),
    });
  } catch (error) {
    console.warn(`[AEO] Claim task ${task.taskId} failed:`, (error as Error).message);
    return;
  }
  await reportTaskEvent(task.taskId, workerUuid, "claimed");

  // 2. 拉取任务详情
  let taskDetail: any;
  try {
    taskDetail = await apiRequest<any>(`/v1/publish/tasks/${task.taskId}`);
  } catch (error) {
    await reportTaskEvent(task.taskId, workerUuid, "failed", {
      error: `Fetch task detail failed: ${(error as Error).message}`,
    });
    return;
  }

  // 3. 转换为 MultiPost SyncData
  const multipostPlatform = AEO_PLATFORM_TO_MULTIPOST[task.platform];
  if (!multipostPlatform) {
    await reportTaskEvent(task.taskId, workerUuid, "failed", {
      error: `Platform not mapped: ${task.platform} (need to add to AEO_PLATFORM_TO_MULTIPOST)`,
    });
    return;
  }

  const platformInfo = infoMap[multipostPlatform];
  if (!platformInfo) {
    await reportTaskEvent(task.taskId, workerUuid, "failed", {
      error: `MultiPost platform not found: ${multipostPlatform}`,
    });
    return;
  }

  const syncData: SyncData = {
    platforms: [{ name: multipostPlatform, injectUrl: platformInfo.injectUrl }],
    isAutoPublish: true,
    data: {
      title: taskDetail.title || "",
      content: taskDetail.content || taskDetail.body || "",
      images: (taskDetail.images || []).map((url: string) => ({
        name: url.split("/").pop() || "image.jpg",
        url,
        type: "image/jpeg",
      })),
      videos: [],
    },
  };

  // 4. 打开 tab 执行发布
  try {
    await reportTaskEvent(task.taskId, workerUuid, "step", { step: "open_editor" });
    await createTabsForPlatforms(syncData);

    // 监听 tab URL 变化 — 小红书发布成功后会跳转到 /explore/xxxxx
    // 其他平台类似（抖音 /video/xxx，B站 /video/BVxxx 等）
    const publishedUrlPatterns = [
      /xiaohongshu\.com\/explore\/[a-f0-9]+/i,
      /douyin\.com\/video\/\d+/i,
      /bilibili\.com\/video\/BV[a-zA-Z0-9]+/i,
      /x\.com\/[^/]+\/status\/\d+/i,
    ];

    // 30 秒超时 — 如果用户没点发布或者卡住了，上报 failed
    const timeoutMs = 30 * 1000;
    const startTime = Date.now();

    const checkPublished = setInterval(async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url) continue;
        for (const pattern of publishedUrlPatterns) {
          if (pattern.test(tab.url)) {
            clearInterval(checkPublished);
            // 调专用的 publish-detected 接口（带 publishedUrl）
            await apiRequest(`/v1/publish/tasks/${task.taskId}/publish-detected`, {
              method: "POST",
              body: JSON.stringify({ publishedUrl: tab.url }),
            });
            console.log(`[AEO] Task ${task.taskId} published: ${tab.url}`);
            return;
          }
        }
      }

      // 超时检测
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkPublished);
        await reportTaskEvent(task.taskId, workerUuid, "failed", {
          error: "Publish timeout (30s) — user may have cancelled or page stuck",
        });
        console.warn(`[AEO] Task ${task.taskId} timeout`);
      }
    }, 2000); // 每 2 秒检查一次
  } catch (error) {
    await reportTaskEvent(task.taskId, workerUuid, "failed", {
      error: (error as Error).message,
    });
  }
}

async function reportTaskEvent(
  taskId: string,
  workerUuid: string,
  eventType: "claimed" | "step" | "progress" | "completed" | "failed",
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await apiRequest(`/v1/publish/tasks/${taskId}/events`, {
      method: "POST",
      body: JSON.stringify({
        eventType,
        workerId: workerUuid,
        payload,
      }),
    });
  } catch (error) {
    console.warn("[AEO] Report event failed:", (error as Error).message);
  }
}

// ================== 初始化 ==================

let lastAccountIdsHash = "";

/**
 * 初始化 AEO 客户端
 * 启动心跳（每 30 秒）+ SSE 任务订阅
 */
export function aeoInit(): void {
  console.log(`[AEO] Initializing (backend=${AEO_API_BASE})`);

  // 自动同步登录态（从 Web localStorage）
  autoSyncAeoToken({ openLoginIfMissing: false }).then(() => {
    // 登录成功后首次心跳
    aeoHeartbeat().then(async (uuid) => {
      if (uuid) {
        // 心跳成功后启动任务订阅
        const accountIds = await storage.get<string[]>("aeoWorkerAccountIds");
        lastAccountIdsHash = (accountIds || []).sort().join(",");
        aeoStartTaskSubscription();
      }
    });
  });

  // 定期心跳 + 账号变更检测
  setInterval(async () => {
    const uuid = await aeoHeartbeat();
    if (uuid) {
      // 检查账号列表是否变化（登录/登出）
      const accountIds = await storage.get<string[]>("aeoWorkerAccountIds");
      const currentHash = (accountIds || []).sort().join(",");
      if (currentHash !== lastAccountIdsHash) {
        console.log("[AEO] Account list changed, reconnecting SSE...");
        lastAccountIdsHash = currentHash;
        // 断开旧连接，重新订阅（带新 accountIds）
        if (currentSSE) {
          currentSSE.abort();
          currentSSE = null;
        }
        aeoStartTaskSubscription();
      }
    }
  }, 30 * 1000);
}
