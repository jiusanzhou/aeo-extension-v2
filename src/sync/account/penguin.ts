import type { AccountInfo } from "../common";

/**
 * 获取企鹅号 / 腾讯内容开放平台账户信息
 *
 * 入口：https://om.qq.com
 * AI 受益方：腾讯元宝、QQ 浏览器、腾讯新闻系
 *
 * Status: 🟡 skeleton — 接口字段需真实账号校准
 *   主接口猜测：om.qq.com/userAuth/getUserInfo（uin/nick/head_url）
 */
export async function getPenguinAccountInfo(): Promise<AccountInfo | null> {
  try {
    const response = await fetch("https://om.qq.com/userAuth/getUserInfo", {
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

    // ret/code 任一非 0 视为未登录
    const errCode = responseData.ret ?? responseData.code;
    if ((errCode != null && errCode !== 0) || !responseData.data) {
      console.warn("未检测到企鹅号登录状态");
      return null;
    }

    const userInfo = responseData.data;
    const accountId = userInfo.chid ?? userInfo.uin ?? userInfo.uid ?? "unknown";
    const username = userInfo.nick ?? userInfo.name ?? "企鹅号用户";
    const avatar = userInfo.head_url ?? userInfo.avatar ?? "";

    return {
      provider: "penguin",
      accountId: String(accountId),
      username,
      description: userInfo.description || "",
      profileUrl: "https://om.qq.com/userAuth/index",
      avatarUrl: avatar,
      extraData: null,
    };
  } catch (error) {
    console.error("获取企鹅号账户信息失败:", error);

    // fallback：从页面 DOM 抓
    try {
      const usernameElement = document.querySelector(
        '.author-name, .user-name, [class*="userName"], [class*="userInfo"] [class*="name"]',
      );
      const avatarElement = document.querySelector(
        '.avatar img, .user-avatar img, [class*="avatar"] img',
      ) as HTMLImageElement;

      if (usernameElement) {
        return {
          provider: "penguin",
          accountId: "unknown",
          username: usernameElement.textContent?.trim() || "企鹅号用户",
          description: "",
          profileUrl: "https://om.qq.com/",
          avatarUrl: avatarElement?.src || "",
          extraData: null,
        };
      }
    } catch (pageError) {
      console.error("从页面获取企鹅号信息也失败:", pageError);
    }

    return null;
  }
}
