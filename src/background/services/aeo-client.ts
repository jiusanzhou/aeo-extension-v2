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
import { type SyncData, createTabsForPlatforms, infoMap } from "~sync/common";
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
  rednote: "DYNAMIC_REDNOTE",
  xiaohongshu: "DYNAMIC_REDNOTE", // 兼容老数据
  douyin: "DYNAMIC_DOUYIN",
  x: "DYNAMIC_X",
  bilibili: "DYNAMIC_BILIBILI",
  toutiao: "DYNAMIC_TOUTIAO",
  baijiahao: "DYNAMIC_BAIJIAHAO",
  baijia: "DYNAMIC_BAIJIAHAO", // 兼容老数据
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

/**
 * 用 OffscreenCanvas 生成独特的封面图，避免 stock 图被平台风控
 */
async function generateCoverImage(title: string, seed: string): Promise<Blob> {
  const W = 1080;
  const H = 1440;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2d context on OffscreenCanvas");

  // 基于 seed 的哈希生成色相
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;

  // 渐变背景
  const gradient = ctx.createLinearGradient(0, 0, W, H);
  gradient.addColorStop(0, `hsl(${hue}, 70%, 65%)`);
  gradient.addColorStop(1, `hsl(${(hue + 60) % 360}, 70%, 45%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);

  // 装饰圆圈（增加视觉变化，降低 stock 图识别率）
  for (let i = 0; i < 8; i++) {
    const cx = ((hash >> i) & 0xff) * 4.23;
    const cy = ((hash >> (i + 3)) & 0xff) * 5.64;
    const r = 40 + (((hash >> (i + 5)) & 0xff) % 120);
    ctx.fillStyle = `hsla(${(hue + i * 30) % 360}, 80%, 80%, 0.2)`;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 标题文字（自动换行）
  ctx.fillStyle = "white";
  ctx.font = "bold 72px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;

  const maxWidth = W - 120;
  const lineHeight = 96;
  const lines: string[] = [];
  let current = "";
  for (const char of title) {
    const testLine = current + char;
    if (ctx.measureText(testLine).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = char;
    } else {
      current = testLine;
    }
  }
  if (current) lines.push(current);

  const startY = H / 2 - ((lines.length - 1) * lineHeight) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i]!, W / 2, startY + i * lineHeight);
  }

  return await canvas.convertToBlob({ type: "image/png" });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  // Service Worker 里没有 FileReader，手动用 ArrayBuffer + btoa
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // 分块 btoa 避免 stack overflow
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
}

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
    let errBody = "";
    try {
      errBody = await response.text();
    } catch {}
    throw new Error(`[AEO] API ${path} failed: ${response.status} ${response.statusText} ${errBody.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

// ================== 心跳 ==================

/**
 * Worker 心跳 — 上报扩展状态
 * 返回后端分配的 Worker UUID
 */
export async function aeoHeartbeat(): Promise<string | null> {
  let apiKey = await storage.get<string>("aeoApiKey");
  if (!apiKey) {
    console.log("[AEO] No API key, trying auto-sync first...");
    // 尝试从前端 tab 读 localStorage.aeo_token
    await autoSyncAeoToken({ openLoginIfMissing: false }).catch((e) =>
      console.warn("[AEO] Auto-sync in heartbeat failed", e),
    );
    apiKey = await storage.get<string>("aeoApiKey");
    if (!apiKey) {
      console.log("[AEO] Still no API key after sync, skipping heartbeat");
      return null;
    }
    console.log("[AEO] Auto-synced token successfully, continuing heartbeat");
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

    // 3. 收集本次刷新成功的账号上报（不依赖 platformInfos 缓存，避免传陈旧数据）
    const accounts: AEOWorkerAccount[] = refreshResults
      .filter(
        (r): r is typeof r & { accountInfo: NonNullable<typeof r.accountInfo> } =>
          r.status === "logged_in" && !!r.accountInfo,
      )
      .map((r) => ({
        platform: r.platform,
        platformUserId: r.accountInfo.accountId,
        displayName: r.accountInfo.username,
        avatarUrl: r.accountInfo.avatarUrl,
        identity: {
          platformUserId: r.accountInfo.accountId,
          displayName: r.accountInfo.username,
          avatarUrl: r.accountInfo.avatarUrl,
        },
        externalAccountId: undefined,
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
let sseRetryCount = 0;

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
    sseRetryCount = 0; // 连上了，重置退避
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
      sseRetryCount++;
    }
  } finally {
    currentSSE = null;
    // 指数退避重连：5s → 10s → 20s → 40s → max 60s
    const delay = Math.min(5000 * 2 ** Math.max(0, sseRetryCount - 1), 60000);
    setTimeout(aeoStartTaskSubscription, delay);
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

  // 小红书/抖音强制要图：若 images 为空或全是占位 URL，本地用 OffscreenCanvas 生成独特封面
  // 避免 picsum/unsplash 等 stock 图被平台风控
  const platformsRequiringImage = new Set(["DYNAMIC_REDNOTE", "DYNAMIC_DOUYIN"]);
  if (
    platformsRequiringImage.has(multipostPlatform) &&
    (syncData.data.images.length === 0 ||
      syncData.data.images.some((i) => /picsum\.photos|placeholder|placehold/i.test(i.url)))
  ) {
    try {
      const coverBlob = await generateCoverImage(taskDetail.title || "无标题", task.taskId);
      // 转 data URL（base64）以便 content script 跨 origin 使用
      const dataUrl = await blobToDataUrl(coverBlob);
      syncData.data.images = [{ name: "cover.png", url: dataUrl, type: "image/png" }];
      console.log(`[AEO] Task ${task.taskId} generated local cover image (${coverBlob.size} bytes)`);
    } catch (err) {
      console.warn("[AEO] Cover gen failed, fallback to original:", err);
    }
  }

  console.log(
    `[AEO] Task ${task.taskId} syncData:`,
    JSON.stringify({ platform: multipostPlatform, imageCount: syncData.data.images.length }),
  );

  // 4. 打开 tab 执行发布
  try {
    await reportTaskEvent(task.taskId, workerUuid, "step", { step: "open_editor" });
    console.log(`[AEO] Task ${task.taskId} opening tab with`, {
      platform: multipostPlatform,
      imageCount: syncData.data.images.length,
      contentLength: syncData.data.content?.length,
      isAutoPublish: syncData.isAutoPublish,
    });
    const openedTabs = await createTabsForPlatforms(syncData);
    console.log(`[AEO] Task ${task.taskId} opened ${openedTabs.length} tabs`);

    // 监听 tab URL 变化 — 发布成功后平台会跳到"管理页"或"成功页"
    // 参考 seed-all-builtins.ts 里各平台的 watchPublish.successPattern
    const publishedUrlPatterns = [
      // 小红书（创作者中心）
      /creator\.xiaohongshu\.com\/creator\/(notemanage|publish\/success)/i,
      /creator\.xiaohongshu\.com\/publish\/success/i,
      // 抖音
      /creator\.douyin\.com\/creator-micro\/content\/(manage|preview)/i,
      // B站
      /member\.bilibili\.com\/platform\/upload-manager/i,
      /member\.bilibili\.com\/york\/upload-finish/i,
      // X/Twitter
      /x\.com\/[^/]+\/status\/\d+/i,
      // 通用 fallback：各平台的"内容管理/列表"页
      /zhuanlan\.zhihu\.com\/p\/\d+/i,
      /mp\.toutiao\.com\/profile_v4\/(graphic|xigua)\/publish-success/i,
      /baijiahao\.baidu\.com\/builder\/rc\/(edit|publish)\?.*state=published/i,
    ];

    // 2 分钟超时 — 图片上传 + 用户点发布 + 服务端处理通常 30-90s
    const timeoutMs = 2 * 60 * 1000;
    const startTime = Date.now();

    const checkPublished = setInterval(async () => {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url) continue;
        for (const pattern of publishedUrlPatterns) {
          if (pattern.test(tab.url)) {
            clearInterval(checkPublished);
            console.log(`[AEO] Task ${task.taskId} publish detected: ${tab.url}`);
            // 调专用的 publish-detected 接口（带 publishedUrl）
            await apiRequest(`/v1/publish/tasks/${task.taskId}/publish-detected`, {
              method: "POST",
              body: JSON.stringify({ publishedUrl: tab.url }),
            });
            return;
          }
        }
      }

      // 超时检测
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkPublished);
        await reportTaskEvent(task.taskId, workerUuid, "failed", {
          error: "Publish timeout (2min) — user may have cancelled or page stuck",
        });
        console.warn(`[AEO] Task ${task.taskId} timeout after 2min`);
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
