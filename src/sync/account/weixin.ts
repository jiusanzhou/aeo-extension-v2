import type { AccountInfo } from "../common";

/**
 * 获取微信公众号账户信息
 *
 * 微信公众号没有官方前端接口暴露用户信息，需要从 mp.weixin.qq.com 的
 * HTML 里解析 window.wx.commonData 全局变量（与 article/weixin.ts 里的
 * readInfo() 完全一致，已在生产验证）。
 */
export async function getWeixinAccountInfo(): Promise<AccountInfo | null> {
  try {
    const response = await fetch("https://mp.weixin.qq.com/", {
      method: "GET",
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`HTTP错误，状态码: ${response.status}`);
    }

    const html = await response.text();

    // 未登录时会被跳到扫码页，commonData 不存在
    const dataMatch = html.match(/window\.wx\.commonData\s*=\s*\{([\s\S]*?)\};/);
    if (!dataMatch) {
      console.warn("未检测到微信公众号登录状态");
      return null;
    }

    const body = dataMatch[1];
    const nicknameMatch = body.match(/nick_name:\s*["']([^"']+)["']/);
    const userNameMatch = body.match(/user_name:\s*["']([^"']+)["']/);
    const headImgMatch = body.match(/head_img:\s*["']([^"']+)["']/);
    // fakeid 是公众号对外的稳定 id
    const fakeidMatch = body.match(/fakeid:\s*["']([^"']+)["']/);

    const accountId = fakeidMatch?.[1] || userNameMatch?.[1] || "unknown";
    const username = nicknameMatch?.[1] || "公众号";

    const result: AccountInfo = {
      provider: "weixin",
      accountId,
      username,
      description: "",
      profileUrl: "https://mp.weixin.qq.com/",
      avatarUrl: headImgMatch?.[1] || "",
      extraData: null,
    };

    return result;
  } catch (error) {
    console.error("获取微信公众号账户信息失败:", error);
    return null;
  }
}
