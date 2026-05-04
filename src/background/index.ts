import { Storage } from "@plasmohq/storage";
import { getAllAccountInfo } from "~sync/account";
import {
  // injectScriptsToTabs,
  type SyncData,
  type SyncDataPlatform,
  createTabsForPlatforms,
  getPlatformInfos,
} from "~sync/common";
import QuantumEntanglementKeepAlive from "../utils/keep-alive";
import { autoSyncAeoToken } from "./services/aeo-auth";
import { aeoHeartbeat, aeoInit, handlePublishFailedFromContent } from "./services/aeo-client";
import { linkExtensionMessageHandler, starter } from "./services/api";
import {
  addTabsManagerMessages,
  tabsManagerHandleTabRemoved,
  tabsManagerHandleTabUpdated,
  tabsManagerMessageHandler,
} from "./services/tabs";
import { trustDomainMessageHandler } from "./services/trust-domain";

const storage = new Storage({
  area: "local",
});

async function initDefaultTrustedDomains() {
  const trustedDomains = await storage.get<Array<{ id: string; domain: string }>>("trustedDomains");
  if (!trustedDomains) {
    await storage.set("trustedDomains", [
      {
        id: crypto.randomUUID(),
        domain: "multipost.app",
      },
    ]);
  }
}

chrome.runtime.onInstalled.addListener((object) => {
  if (object.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: "https://multipost.app/on-install" });
  }
  initDefaultTrustedDomains();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  // AEO: 安装时自动同步登录态
  autoSyncAeoToken().catch((e) => console.warn("[AEO] Auto-sync failed", e));
});

chrome.runtime.onStartup?.addListener(() => {
  // AEO: 浏览器启动时自动同步
  autoSyncAeoToken({ openLoginIfMissing: false }).catch((e) => console.warn("[AEO] Startup auto-sync failed", e));
});

// AEO: 监听前端 tab 完成加载 → 用户刚登录完，立即同步
chrome.webNavigation?.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const apiKey = await storage.get<string>("aeoApiKey");
  if (apiKey) return; // 已有 token，不打扰
  const frontUrl = "https://aeo.wencai.app"; // AEO 前端
  if (!details.url.startsWith(frontUrl)) return;
  // 给页面 1.5s 让 React 把 token 写进 localStorage
  setTimeout(() => {
    autoSyncAeoToken({ openLoginIfMissing: false }).catch((e) => console.warn("[AEO] Post-login auto-sync failed", e));
  }, 1500);
});

// Listen Message || 监听消息 || START
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  defaultMessageHandler(request, sender, sendResponse);
  tabsManagerMessageHandler(request, sender, sendResponse);
  trustDomainMessageHandler(request, sender, sendResponse);
  linkExtensionMessageHandler(request, sender, sendResponse);

  // AEO content script → background：发布失败提前上报
  if (request?.type === "AEO_PUBLISH_FAILED" && request?.taskId) {
    handlePublishFailedFromContent(request.taskId, request.error || "unknown error").catch((e) =>
      console.error("[AEO] handlePublishFailedFromContent threw:", e),
    );
    sendResponse({ ok: true });
  }

  return true;
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  tabsManagerHandleTabUpdated(tabId, changeInfo, tab);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabsManagerHandleTabRemoved(tabId);
});
// Listen Message || 监听消息 || END

// Message Handler || 消息处理器 || START
let currentSyncData: SyncData | null = null;
let currentPublishPopup: chrome.windows.Window | null = null;
const defaultMessageHandler = (request, _sender, sendResponse) => {
  if (request.action === "MULTIPOST_EXTENSION_CHECK_SERVICE_STATUS") {
    sendResponse({ extensionId: chrome.runtime.id });
  }
  // AEO: popup 触发手动刷新账号
  if (request.type === "TRIGGER_HEARTBEAT") {
    aeoHeartbeat()
      .then((uuid) => sendResponse({ ok: true, uuid }))
      .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true; // 异步响应
  }
  if (request.action === "MULTIPOST_EXTENSION_PUBLISH") {
    const data = request.data as SyncData;
    currentSyncData = data;
    (async () => {
      currentPublishPopup = await chrome.windows.create({
        url: chrome.runtime.getURL("tabs/publish.html"),
        type: "popup",
        width: 800,
        height: 600,
      });
    })();
  }
  if (request.action === "MULTIPOST_EXTENSION_PLATFORMS") {
    getPlatformInfos().then((platforms) => {
      sendResponse({ platforms });
    });
  }
  if (request.action === "MULTIPOST_EXTENSION_GET_ACCOUNT_INFOS") {
    getAllAccountInfo().then((accountInfo) => {
      sendResponse({ accountInfo });
    });
  }
  if (request.action === "MULTIPOST_EXTENSION_OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ extensionId: chrome.runtime.id });
  }
  if (request.action === "MULTIPOST_EXTENSION_REFRESH_ACCOUNT_INFOS") {
    chrome.windows.create({
      url: chrome.runtime.getURL("tabs/refresh-accounts.html"),
      type: "popup",
      width: 800,
      height: 600,
      focused: request.data.isFocused || false,
    });
  }
  if (request.action === "MULTIPOST_EXTENSION_PUBLISH_REQUEST_SYNC_DATA") {
    sendResponse({ syncData: currentSyncData });
  }
  if (request.action === "MULTIPOST_EXTENSION_PUBLISH_NOW") {
    const data = request.data as SyncData;
    if (Array.isArray(data.platforms) && data.platforms.length > 0) {
      (async () => {
        try {
          const tabs = await createTabsForPlatforms(data);
          // await injectScriptsToTabs(tabs, data);

          addTabsManagerMessages({
            syncData: data,
            tabs: tabs.map((t: { tab: chrome.tabs.Tab; platformInfo: SyncDataPlatform }) => ({
              tab: t.tab,
              platformInfo: t.platformInfo,
            })),
          });

          // for (const t of tabs) {
          //   if (t.tab.id) {
          //     await chrome.tabs.update(t.tab.id, { active: true });
          //     await new Promise((resolve) => setTimeout(resolve, 2000));
          //   }
          // }
          if (currentPublishPopup) {
            await chrome.windows.update(currentPublishPopup.id, { focused: true });
          }

          sendResponse({
            tabs: tabs.map((t: { tab: chrome.tabs.Tab; platformInfo: SyncDataPlatform }) => ({
              tab: t.tab,
              platformInfo: t.platformInfo,
            })),
          });
        } catch (error) {
          console.error("创建标签页或分组时出错:", error);
        }
      })();
    }
  }
};
starter(1000 * 30);
// Message Handler || 消息处理器 || END

// AEO Integration || AEO 集成 || START
aeoInit();
// AEO Integration || AEO 集成 || END

// Keep Alive || 保活机制 || START
const quantumKeepAlive = new QuantumEntanglementKeepAlive();
quantumKeepAlive.startEntanglementProcess();
// Keep Alive || 保活机制 || END
