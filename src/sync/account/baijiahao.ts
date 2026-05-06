import type { AccountInfo } from "../common";

/**
 * 获取百家号账户信息
 */
export async function getBaijiahaoAccountInfo(): Promise<AccountInfo | null> {
  try {
    // 百家号创作者中心 API（尝试获取用户信息）
    const response = await fetch("https://baijiahao.baidu.com/builder/rc/get_user_info", {
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
    if (!responseData.data || responseData.errno !== 0) {
      console.warn("未检测到百家号登录状态");
      return null;
    }

    const userInfo = responseData.data;
    const result: AccountInfo = {
      provider: "baijiahao",
      accountId: userInfo.app_id || userInfo.author_id || "unknown",
      username: userInfo.author_name || userInfo.name || "百家号用户",
      description: userInfo.description || "",
      profileUrl: `https://baijiahao.baidu.com/u?app_id=${userInfo.app_id || ""}`,
      avatarUrl: userInfo.avatar || userInfo.author_avatar || "",
      extraData: null,
    };

    return result;
  } catch (error) {
    console.error("获取百家号账户信息失败:", error);

    // fallback：从页面 DOM 获取
    try {
      const usernameElement = document.querySelector(
        '.author-name, .user-name, [class*="userName"], [class*="authorName"]',
      );
      const avatarElement = document.querySelector(
        '.avatar img, .user-avatar img, [class*="avatar"] img',
      ) as HTMLImageElement;

      if (usernameElement) {
        const result: AccountInfo = {
          provider: "baijiahao",
          accountId: "unknown",
          username: usernameElement.textContent?.trim() || "百家号用户",
          description: "",
          profileUrl: "https://baijiahao.baidu.com/builder/rc/home",
          avatarUrl: avatarElement?.src || "",
          extraData: null,
        };
        return result;
      }
    } catch (pageError) {
      console.error("从页面获取百家号信息也失败:", pageError);
    }

    return null;
  }
}
