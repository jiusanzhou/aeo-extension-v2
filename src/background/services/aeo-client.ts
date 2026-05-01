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
import { type SyncData, createTabsForPlatforms, getPlatformInfos, infoMap } from "~sync/common";
import { autoSyncAeoToken } from "./aeo-auth";

const storage = new Storage({ area: "local" });

// AEO 后端地址（通过 PLASMO_PUBLIC_AEO_API_BASE 环境变量配置）
const AEO_API_BASE =
  (typeof process !== "undefined" && process.env?.PLASMO_PUBLIC_AEO_API_BASE) || "https://aeo-ex9.pages.dev";

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
 * AEO 后端平台名 → MultiPost 平台名
 * 
 * 当前 AEO 支持 9 个平台（见 apps/api/scripts/seed-all-builtins.ts）
 * MultiPost 覆盖其中 4 个动态图文：toutiao/baijia/douyin/xiaohongshu
 * 其余 5 个（sohu/netease/sogou/dayu/nano360）MultiPost 仅支持视频或不支持
 */
const PLATFORM_MAP: Record<string, string> = {
  // AEO 原生支持 + MultiPost 图文发布
  xiaohongshu: "DYNAMIC_REDNOTE",
  douyin: "DYNAMIC_DOUYIN",
  toutiao: "DYNAMIC_TOUTIAO",
  baijia: "DYNAMIC_BAIJIAHAO",
  
  // AEO 可扩展平台（MultiPost 支持但 AEO 后端需要加）
  weibo: "DYNAMIC_WEIBO",
  zhihu: "DYNAMIC_ZHIHU",
  bilibili: "DYNAMIC_BILIBILI",
  kuaishou: "DYNAMIC_KUAISHOU",
  jike: "DYNAMIC_OKJIKE",
  douban: "DYNAMIC_DOUBAN",
  juejin: "DYNAMIC_JUEJIN",
  
  // 国际平台
  x: "DYNAMIC_X",
  linkedin: "DYNAMIC_LINKEDIN",
  facebook: "DYNAMIC_FACEBOOK",
  instagram: "DYNAMIC_INSTAGRAM",
  threads: "DYNAMIC_THREADS",
  reddit: "DYNAMIC_REDDIT",
  bluesky: "DYNAMIC_BLUESKY",
};

/**
 * MultiPost accountKey → AEO 平台名（反向映射）
 */
const ACCOUNT_KEY_TO_AEO_PLATFORM: Record<string, string> = {
  rednote: "xiaohongshu",
  douyin: "douyin",
  toutiao: "toutiao",
  baijiahao: "baijia",
  weibo: "weibo",
  zhihu: "zhihu",
  bilibili: "bilibili",
  kuaishou: "kuaishou",
  okjike: "jike",
  douban: "douban",
  juejin: "juejin",
  x: "x",
  linkedin: "linkedin",
  facebook: "facebook",
  instagram: "instagram",
  threads: "threads",
  reddit: "reddit",
  bluesky: "bluesky",
};

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
    const platformInfos = await getPlatformInfos();
    const accounts: AEOWorkerAccount[] = platformInfos
      .filter((p) => p.accountInfo)
      .map((p) => {
        // 用 accountKey 映射到 AEO 平台名
        const aeoPlatform = ACCOUNT_KEY_TO_AEO_PLATFORM[p.accountKey] || p.accountKey;
        return {
          platform: aeoPlatform,
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
        };
      })
      // 只上报在 AEO_PLATFORM 映射里的平台
      .filter((a) => Object.values(ACCOUNT_KEY_TO_AEO_PLATFORM).includes(a.platform));

    if (accounts.length === 0) {
      console.log("[AEO] No accounts to report");
      return;
    }

    await apiRequest<{ reported: number }>(`/v1/workers/${workerUuid}/accounts/report`, {
      method: "POST",
      body: JSON.stringify({ accounts }),
    });
    console.log(`[AEO] Reported ${accounts.length} accounts`);
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
  if (!apiKey || !workerUuid) {
    console.log("[AEO] Missing credentials, cannot start task subscription");
    return;
  }

  const url = `${AEO_API_BASE}/v1/publish/tasks/stream?workerId=${encodeURIComponent(workerUuid)}&workerType=extension`;
  const controller = new AbortController();
  currentSSE = { abort: () => controller.abort() };

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
  const multipostPlatform = PLATFORM_MAP[task.platform];
  if (!multipostPlatform) {
    await reportTaskEvent(task.taskId, workerUuid, "failed", {
      error: `Platform not mapped: ${task.platform} (need to add to PLATFORM_MAP)`,
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
    await reportTaskEvent(task.taskId, workerUuid, "completed", {
      platform: task.platform,
    });
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

/**
 * 初始化 AEO 客户端
 * 启动心跳（每 30 秒）+ SSE 任务订阅
 */
export function aeoInit(): void {
  console.log(`[AEO] Initializing (backend=${AEO_API_BASE})`);

  // 自动同步登录态（从 Web localStorage）
  autoSyncAeoToken({ openLoginIfMissing: false }).then(() => {
    // 登录成功后首次心跳
    aeoHeartbeat().then((uuid) => {
      if (uuid) {
        // 心跳成功后启动任务订阅
        aeoStartTaskSubscription();
      }
    });
  });

  // 定期心跳
  setInterval(() => {
    aeoHeartbeat();
  }, 30 * 1000);
}
