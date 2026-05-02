import { Storage } from "@plasmohq/storage";
import { useStorage } from "@plasmohq/storage/hook";
import { useEffect, useState } from "react";

import { refreshAccountInfoMap } from "~sync/account";
import "~style.css";

const storage = new Storage({ area: "local" });

const AEO_API_BASE =
  (typeof process !== "undefined" && process.env?.PLASMO_PUBLIC_AEO_API_BASE) || "https://aeo-api.wencai.app";

/**
 * 推导 AEO 前端登录 URL
 */
function aeoFrontendUrl(apiBaseUrl: string): string {
  if (!apiBaseUrl) return "https://aeo.wencai.app";
  if (apiBaseUrl.includes("localhost")) return "http://localhost:5173";
  return apiBaseUrl.replace("aeo-api", "aeo").replace("/api", "");
}

function IndexPopup() {
  const [apiKey] = useStorage<string>({
    key: "aeoApiKey",
    instance: storage,
  });
  const [userEmail] = useStorage<string>({
    key: "aeoUserEmail",
    instance: storage,
  });
  const [workerUuid] = useStorage<string>({
    key: "aeoWorkerUuid",
    instance: storage,
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pasteToken, setPasteToken] = useState("");

  const loggedIn = !!apiKey;

  const handleOpenAeoLogin = () => {
    const frontUrl = aeoFrontendUrl(AEO_API_BASE);
    chrome.tabs.create({ url: `${frontUrl}/login`, active: true });
    window.close();
  };

  const handleLogout = async () => {
    if (!confirm("退出登录？")) return;
    await storage.remove("aeoApiKey");
    await storage.remove("aeoUserEmail");
    await storage.remove("aeoWorkerUuid");
  };

  const handlePasteToken = async () => {
    if (!pasteToken.trim()) {
      alert("请粘贴 Token");
      return;
    }
    try {
      // 验证 token
      const res = await fetch(`${AEO_API_BASE}/v1/auth/me`, {
        headers: { Authorization: `Bearer ${pasteToken.trim()}` },
      });
      if (!res.ok) {
        alert("Token 无效");
        return;
      }
      const data = await res.json();
      await storage.set("aeoApiKey", pasteToken.trim());
      await storage.set("aeoUserEmail", data.user.email);
      setPasteToken("");
      alert(`✅ 欢迎，${data.user.email}`);
    } catch (e) {
      alert(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div
      style={{
        fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
        fontSize: 13,
        padding: 12,
        width: 420,
        background: "#fafafa",
        color: "#111827",
      }}>
      <h3
        style={{
          margin: "0 0 10px",
          fontSize: 13,
          fontWeight: 600,
          color: "#374151",
        }}>
        AEO Helper
      </h3>

      <div
        style={{
          background: "white",
          borderRadius: 8,
          padding: 12,
          marginBottom: 8,
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
        }}>
        <h3
          style={{
            margin: "0 0 8px 0",
            fontSize: 13,
            fontWeight: 600,
            color: "#374151",
          }}>
          后端连接
        </h3>
        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8 }}>
          连接 AEO 后端用于同步发布任务队列。基于 MultiPost 的 50+ 平台适配器。
        </div>
        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4 }}>API 地址</div>
        <input
          value={AEO_API_BASE}
          disabled
          style={{
            width: "100%",
            padding: "5px 8px",
            border: "1px solid #e5e7eb",
            borderRadius: 5,
            fontSize: 12,
            background: "#f9fafb",
            color: "#6b7280",
            boxSizing: "border-box",
          }}
        />

        {loggedIn ? (
          <>
            <div
              style={{
                marginTop: 10,
                padding: 8,
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                borderRadius: 6,
                fontSize: 12,
                color: "#0369a1",
              }}>
              ✓ 已登录 <b>{userEmail ?? "用户"}</b>
              <div
                style={{
                  fontSize: 10,
                  color: "#64748b",
                  marginTop: 3,
                }}>
                插件自动同步 AEO 后台登录态，无需单独配置。
              </div>
              {workerUuid && (
                <div style={{ fontSize: 10, color: "#64748b", marginTop: 3 }}>
                  Worker ID: {workerUuid.slice(0, 8)}...
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
              <button
                type="button"
                onClick={handleLogout}
                style={{
                  flex: 1,
                  padding: 8,
                  background: "#fee2e2",
                  color: "#991b1b",
                  borderRadius: 6,
                  border: 0,
                  cursor: "pointer",
                  fontSize: 12,
                }}>
                退出登录
              </button>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                marginTop: 12,
                padding: 12,
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 6,
              }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#92400e",
                  marginBottom: 6,
                }}>
                ⚠️ 未登录
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "#78350f",
                  marginBottom: 10,
                  lineHeight: 1.5,
                }}>
                插件会自动从 AEO 后台同步登录态。请先打开 AEO 后台并登录。
              </div>
              <button
                type="button"
                onClick={handleOpenAeoLogin}
                style={{
                  width: "100%",
                  padding: 8,
                  background: "#10b981",
                  color: "white",
                  border: 0,
                  borderRadius: 5,
                  fontSize: 12,
                  cursor: "pointer",
                  fontWeight: 500,
                }}>
                🚀 打开 AEO 后台登录
              </button>
            </div>

            <details style={{ marginTop: 10, fontSize: 11, color: "#6b7280" }} open={showAdvanced}>
              <summary
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.preventDefault();
                  setShowAdvanced(!showAdvanced);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setShowAdvanced(!showAdvanced);
                  }
                }}>
                手动粘贴 Token（高级）
              </summary>
              <div style={{ marginTop: 6 }}>
                在 AEO 后台 Console 跑{" "}
                <code
                  style={{
                    background: "#f3f4f6",
                    padding: "1px 4px",
                    borderRadius: 3,
                  }}>
                  localStorage.aeo_token
                </code>{" "}
                拿到 token 贴这里
                <input
                  type="password"
                  placeholder="aeo_token..."
                  autoComplete="off"
                  value={pasteToken}
                  onChange={(e) => setPasteToken(e.target.value)}
                  style={{
                    width: "100%",
                    marginTop: 4,
                    padding: "5px 8px",
                    border: "1px solid #e5e7eb",
                    borderRadius: 5,
                    fontSize: 12,
                    boxSizing: "border-box",
                  }}
                />
                <button
                  type="button"
                  onClick={handlePasteToken}
                  style={{
                    width: "100%",
                    padding: 6,
                    marginTop: 4,
                    background: "#10b981",
                    color: "white",
                    border: 0,
                    borderRadius: 5,
                    fontSize: 12,
                    cursor: "pointer",
                  }}>
                  保存 Token
                </button>
              </div>
            </details>
          </>
        )}
      </div>

      {/* 平台账号卡片 */}
      {loggedIn && <PlatformAccountsCard />}

      <div
        style={{
          fontSize: 10,
          color: "#9ca3af",
          textAlign: "center",
          marginTop: 8,
        }}>
        基于 MultiPost 开源项目 · v{chrome.runtime.getManifest().version}
      </div>
    </div>
  );
}

/**
 * 平台账号卡片 — 展示启用平台 + 登录账号状态
 */
function PlatformAccountsCard() {
  const [accountsSnapshot, setAccountsSnapshot] = useState<
    Array<{
      platform: string;
      status: "logged_in" | "failed";
      accountInfo?: { accountId: string; username: string; avatarUrl?: string };
    }>
  >([]);
  const [refreshedAt, setRefreshedAt] = useState<number>(0);
  const [refreshing, setRefreshing] = useState(false);

  const loadSnapshot = async () => {
    const snapshot = await storage.get<typeof accountsSnapshot>("aeoAccountsSnapshot");
    const ts = await storage.get<number>("aeoAccountsRefreshedAt");
    setAccountsSnapshot(snapshot || []);
    setRefreshedAt(ts || 0);
  };

  useEffect(() => {
    loadSnapshot();
    // 每 5 秒轮询一次（心跳会更新 snapshot）
    const interval = setInterval(loadSnapshot, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      // 触发 background 的 heartbeat（会刷新账号）
      await chrome.runtime.sendMessage({ type: "TRIGGER_HEARTBEAT" });
      // 等 2 秒让 background 完成刷新
      await new Promise((r) => setTimeout(r, 2000));
      await loadSnapshot();
    } finally {
      setRefreshing(false);
    }
  };

  const loggedInCount = accountsSnapshot.filter((a) => a.status === "logged_in").length;
  const failedCount = accountsSnapshot.filter((a) => a.status === "failed").length;

  return (
    <div
      style={{
        background: "white",
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
        boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
      }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#374151" }}>
          平台账号 ({loggedInCount}/{accountsSnapshot.length})
        </h3>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          style={{
            padding: "4px 8px",
            background: refreshing ? "#e5e7eb" : "#10b981",
            color: refreshing ? "#6b7280" : "white",
            border: 0,
            borderRadius: 5,
            fontSize: 11,
            cursor: refreshing ? "not-allowed" : "pointer",
          }}>
          {refreshing ? "刷新中..." : "🔄 刷新"}
        </button>
      </div>

      {refreshedAt > 0 && (
        <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 8 }}>
          上次刷新: {new Date(refreshedAt).toLocaleTimeString("zh-CN")}
        </div>
      )}

      {accountsSnapshot.length === 0 ? (
        <div style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", padding: "12px 0" }}>
          暂无启用平台，请在后台配置 worker_enabled_platforms
        </div>
      ) : (
        <div>
          {accountsSnapshot.map((acc) => {
            const meta = refreshAccountInfoMap[acc.platform];
            const platformLabel = meta?.platformName || acc.platform;
            const faviconUrl = meta?.faviconUrl;

            return (
              <div
                key={acc.platform}
                style={{
                  padding: "8px 0",
                  borderTop: "1px solid #f3f4f6",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: acc.status === "logged_in" ? "#10b981" : "#d1d5db",
                      flexShrink: 0,
                    }}
                  />
                  {faviconUrl && (
                    <img
                      src={faviconUrl}
                      alt=""
                      style={{ width: 16, height: 16, borderRadius: 3, objectFit: "contain" }}
                    />
                  )}
                  <span style={{ fontWeight: 600, fontSize: 12, color: "#374151" }}>{platformLabel}</span>
                </div>

                {acc.status === "logged_in" && acc.accountInfo ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      background: "#f0fdf4",
                      borderLeft: "3px solid #10b981",
                      borderRadius: 4,
                    }}>
                    {acc.accountInfo.avatarUrl ? (
                      <img
                        src={acc.accountInfo.avatarUrl}
                        alt=""
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: "50%",
                          objectFit: "cover",
                          flexShrink: 0,
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: "50%",
                          background: "#e5e7eb",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 500,
                          color: "#065f46",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}>
                        {acc.accountInfo.username}
                      </div>
                      <div
                        style={{
                          fontSize: 9,
                          color: "#6b7280",
                          fontFamily: "'SF Mono', Monaco, monospace",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}>
                        UID: {acc.accountInfo.accountId}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: "6px 8px",
                      background: "#f9fafb",
                      borderRadius: 4,
                      fontSize: 11,
                      color: "#6b7280",
                    }}>
                    未检测到登录 —{" "}
                    <a
                      href={meta?.homeUrl || "#"}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#0ea5e9", textDecoration: "none" }}>
                      打开登录页
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {failedCount > 0 && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: 6,
            fontSize: 11,
            color: "#92400e",
          }}>
          ⚠️ {failedCount} 个平台未登录，请先登录对应平台后点击刷新
        </div>
      )}
    </div>
  );
}

export default IndexPopup;
