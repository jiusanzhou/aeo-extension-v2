import { Storage } from "@plasmohq/storage";
import { useStorage } from "@plasmohq/storage/hook";
import { useState } from "react";

import "~style.css";

const storage = new Storage({ area: "local" });

function IndexPopup() {
  const [apiKey, _setApiKey] = useStorage<string>({
    key: "aeoApiKey",
    instance: storage,
  });
  const [workerUuid] = useStorage<string>({
    key: "aeoWorkerUuid",
    instance: storage,
  });
  const [inputKey, setInputKey] = useState("");

  const handleLogin = async () => {
    if (!inputKey.trim()) {
      alert("请输入 API Key");
      return;
    }
    await storage.set("aeoApiKey", inputKey.trim());
    setInputKey("");
    alert("已保存 API Key，扩展将在下次心跳时连接后端");
  };

  const handleLogout = async () => {
    if (!confirm("确认退出登录？")) return;
    await storage.remove("aeoApiKey");
    await storage.remove("aeoWorkerUuid");
    alert("已退出");
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: 16,
        minWidth: 320,
        fontFamily: "system-ui, sans-serif",
      }}>
      <h2 style={{ margin: "0 0 16px 0", fontSize: 18 }}>AEO Helper (Powered by MultiPost)</h2>

      {!apiKey ? (
        <div>
          <p style={{ fontSize: 14, color: "#666", marginBottom: 12 }}>请输入 AEO API Key 登录</p>
          <input
            type="password"
            placeholder="API Key"
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "1px solid #ddd",
              borderRadius: 4,
              fontSize: 14,
              marginBottom: 12,
            }}
          />
          <button
            onClick={handleLogin}
            style={{
              width: "100%",
              padding: "8px 12px",
              background: "#007bff",
              color: "white",
              border: "none",
              borderRadius: 4,
              fontSize: 14,
              cursor: "pointer",
            }}>
            登录
          </button>
        </div>
      ) : (
        <div>
          <div
            style={{
              padding: 12,
              background: "#f0f9ff",
              border: "1px solid #bfdbfe",
              borderRadius: 4,
              marginBottom: 12,
            }}>
            <div style={{ fontSize: 12, color: "#1e40af", marginBottom: 4 }}>✓ 已登录</div>
            {workerUuid && <div style={{ fontSize: 11, color: "#64748b" }}>Worker ID: {workerUuid.slice(0, 8)}...</div>}
          </div>

          <div style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
            <p style={{ margin: "0 0 8px 0" }}>• 扩展每 30 秒自动心跳</p>
            <p style={{ margin: "0 0 8px 0" }}>• 后端推送任务时自动执行</p>
            <p style={{ margin: 0 }}>• 支持 50+ 平台（小红书、抖音、微博等）</p>
          </div>

          <button
            onClick={handleLogout}
            style={{
              width: "100%",
              padding: "8px 12px",
              background: "#dc2626",
              color: "white",
              border: "none",
              borderRadius: 4,
              fontSize: 14,
              cursor: "pointer",
            }}>
            退出登录
          </button>
        </div>
      )}

      <div
        style={{
          marginTop: 16,
          paddingTop: 16,
          borderTop: "1px solid #e5e7eb",
          fontSize: 11,
          color: "#9ca3af",
          textAlign: "center",
        }}>
        基于 MultiPost 开源项目 · v{chrome.runtime.getManifest().version}
      </div>
    </div>
  );
}

export default IndexPopup;
