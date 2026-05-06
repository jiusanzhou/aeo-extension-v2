import type { AccountInfo } from "../common";

/**
 * 获取知乎账户信息
 */
export async function getZhihuAccountInfo(): Promise<AccountInfo | null> {
  try {
    // 知乎自己的 API（需登录 cookie）
    const response = await fetch("https://www.zhihu.com/api/v4/me", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-requested-with": "fetch",
      },
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`HTTP错误，状态码: ${response.status}`);
    }

    const userInfo = await response.json();

    // 未登录时返回 { error: { ... } }
    if (!userInfo || userInfo.error || !userInfo.url_token) {
      console.warn("未检测到知乎登录状态");
      return null;
    }

    const result: AccountInfo = {
      provider: "zhihu",
      accountId: userInfo.id || userInfo.url_token || "unknown",
      username: userInfo.name || userInfo.url_token || "知乎用户",
      description: userInfo.headline || userInfo.description || "",
      profileUrl: userInfo.url || `https://www.zhihu.com/people/${userInfo.url_token}`,
      avatarUrl: userInfo.avatar_url || "",
      extraData: null,
    };

    return result;
  } catch (error) {
    console.error("获取知乎账户信息失败:", error);
    return null;
  }
}
