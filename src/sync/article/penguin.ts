import type { ArticleData, SyncData } from "~sync/common";

/**
 * 企鹅号 / 腾讯内容开放平台 (om.qq.com) — Article handler.
 *
 * 编辑器入口（最佳猜测，需真实账号校准）:
 *   https://om.qq.com/article/articlePub
 *
 * 该平台对应的 AI 引擎：腾讯元宝、QQ 浏览器、腾讯新闻系。
 *
 * Status: 🟡 skeleton — selectors 待真实账号验证。
 *   登录 om.qq.com 后 follow:
 *     · 标题输入框：常见为 input[placeholder*="标题"] 或类似 ant-input
 *     · 正文编辑器：ProseMirror / contenteditable / quill 中之一
 *     · 发布按钮：button 文本含「发布」
 */
export async function ArticlePenguin(data: SyncData) {
  console.log("Penguin (om.qq.com) Article 函数被调用");

  const articleData = data.data as ArticleData;

  function waitForElement(selector: string, timeout = 10000): Promise<Element> {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          resolve(element);
          observer.disconnect();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element with selector "${selector}" not found within ${timeout}ms`));
      }, timeout);
    });
  }

  try {
    // 标题
    const titleSelector = ['input[placeholder*="标题"]', 'textarea[placeholder*="标题"]', 'input[name="title"]'].join(
      ",",
    );

    await waitForElement(titleSelector);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const titleInput = document.querySelector(titleSelector) as HTMLInputElement | HTMLTextAreaElement;
    if (titleInput) {
      // 企鹅号标题限制约 30 字
      titleInput.value = articleData.title?.slice(0, 30) || "";
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      titleInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    console.debug("titleInput", titleInput, titleInput?.value);

    // 正文编辑器
    const editorSelector = [".ProseMirror", '[contenteditable="true"]', ".ql-editor", ".editor-content"].join(",");

    const editor = document.querySelector(editorSelector) as HTMLElement;
    if (!editor) {
      console.debug("Penguin: 未找到正文编辑器");
      return;
    }

    editor.focus();

    // 走 paste 事件，让富文本组件正常处理 HTML 内容
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    pasteEvent.clipboardData?.setData("text/html", articleData.htmlContent || "");
    pasteEvent.clipboardData?.setData("text/plain", articleData.htmlContent || "");
    editor.dispatchEvent(pasteEvent);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));

    // 等待渲染（腾讯系编辑器通常较重）
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // 自动发布
    const buttons = document.querySelectorAll("button");
    const publishButton = Array.from(buttons).find((btn) => {
      const text = btn.textContent?.trim() || "";
      return /^发\s*布$/.test(text) || text === "立即发布";
    });

    if (publishButton) {
      if (data.isAutoPublish) {
        console.debug("Penguin: 自动发布");
        publishButton.dispatchEvent(new Event("click", { bubbles: true }));
      } else {
        console.debug("Penguin: 文章准备就绪，等待手动发布");
      }
    } else {
      console.debug("Penguin: 未找到发布按钮，请手动操作");
    }
  } catch (error) {
    console.error("Penguin Article 发布过程中出错:", error);
  }
}
