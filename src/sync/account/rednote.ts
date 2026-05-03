import type { AccountInfo } from "~sync/common";

export async function getRednoteAccountInfo(): Promise<AccountInfo | null> {
  // 主站后端 API (edith) — 直接返回 JSON，不用解析 HTML
  try {
    const res = await fetch("https://edith.xiaohongshu.com/api/sns/web/v2/user/me", {
      credentials: "include",
    });
    if (res.ok) {
      const data = (await res.json()) as {
        code?: number;
        success?: boolean;
        data?: {
          guest?: boolean;
          user_id?: string;
          red_id?: string;
          nickname?: string;
          images?: string;
          desc?: string;
        };
      };
      if (data?.success && data.data && !data.data.guest) {
        const d = data.data;
        return {
          provider: "rednote",
          accountId: d.user_id ?? d.red_id ?? "",
          username: d.nickname ?? "",
          description: d.desc,
          profileUrl: `https://www.xiaohongshu.com/user/profile/${d.user_id ?? d.red_id}`,
          avatarUrl: d.images,
          extraData: data,
        };
      }
    }
  } catch (err) {
    console.warn("[rednote] API /user/me failed:", err);
  }

  // Fallback: 创作者中心 API
  try {
    const res = await fetch("https://creator.xiaohongshu.com/api/galaxy/creator/user/info", {
      credentials: "include",
    });
    if (res.ok) {
      const data = (await res.json()) as {
        success?: boolean;
        data?: {
          userId?: string;
          redId?: string;
          nickname?: string;
          imageb?: string;
          avatar?: string;
        };
      };
      if (data?.success && data.data) {
        const d = data.data;
        return {
          provider: "rednote",
          accountId: d.userId ?? d.redId ?? "",
          username: d.nickname ?? "",
          profileUrl: `https://www.xiaohongshu.com/user/profile/${d.userId ?? d.redId}`,
          avatarUrl: d.imageb ?? d.avatar,
          extraData: data,
        };
      }
    }
  } catch (err) {
    console.warn("[rednote] API /creator/user/info failed:", err);
  }

  console.warn("[rednote] Both APIs failed or returned guest/no data");
  return null;
}
