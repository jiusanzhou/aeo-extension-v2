import type { AccountInfo } from "../common";

/**
 * 获取头条号账户信息
 */
export async function getToutiaoAccountInfo(): Promise<AccountInfo | null> {
  try {
    // 头条号创作者中心 API
    const response = await fetch("https://mp.toutiao.com/profile_v4/get_self_info", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`HTTP错误，状态码: ${response.status}`);
    }

    const responseData = await response.json();

    // 检查是否登录
    if (!responseData.data || responseData.message !== "success") {
      console.warn("未检测到头条号登录状态");
      return null;
    }

    const userInfo = responseData.data;
    const result: AccountInfo = {
      provider: "toutiao",
      accountId: userInfo.media_id || userInfo.user_id || "unknown",
      username: userInfo.name || userInfo.screen_name || "头条号用户",
      description: userInfo.description || "",
      profileUrl: `https://www.toutiao.com/c/user/token/${userInfo.user_auth_info?.user_id || userInfo.user_id}/`,
      avatarUrl: userInfo.avatar_url || userInfo.avatar || "",
      extraData: null,
    };

    return result;
  } catch (error) {
    console.error("获取头条号账户信息失败:", error);

    // fallback：从页面 DOM 获取
    try {
      const usernameElement = document.querySelector(
        '.account-name, .user-name, [class*="userName"], [class*="accountName"]',
      );
      const avatarElement = document.querySelector(
        '.avatar img, .user-avatar img, [class*="avatar"] img',
      ) as HTMLImageElement;

      if (usernameElement) {
        const result: AccountInfo = {
          provider: "toutiao",
          accountId: "unknown",
          username: usernameElement.textContent?.trim() || "头条号用户",
          description: "",
          profileUrl: "https://mp.toutiao.com/",
          avatarUrl: avatarElement?.src || "",
          extraData: null,
        };
        return result;
      }
    } catch (pageError) {
      console.error("从页面获取头条号信息也失败:", pageError);
    }

    return null;
  }
}
