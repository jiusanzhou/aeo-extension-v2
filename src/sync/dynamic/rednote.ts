import type { DynamicData, SyncData } from "../common";

/**
 * 发布点击后的错误监听器
 *
 * 覆盖三种失败信号：
 *   1. toast/alert 元素出现（文案提示）
 *   2. 发布 API 请求返回非 2xx（网络级失败）
 *   3. windowMs 内未出现任何信号 → 返回 null（假定已跳转，让 background 判定）
 */
function watchForErrors(opts: {
  windowMs: number;
  onError: (reason: string) => void;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason) opts.onError(reason);
      resolve(reason);
    };

    // 1) toast 元素观察（MutationObserver 监听整个 body 新增 toast/alert）
    const toastSelectors = ['[role="alert"]', ".toast", ".message", ".notification", ".d-toast", ".rd-toast"];
    const checkToast = (root: Element | Document = document): string | null => {
      for (const sel of toastSelectors) {
        const nodes = root.querySelectorAll(sel);
        for (const n of nodes) {
          const txt = n.textContent?.trim();
          // 排除过短（<= 2 字）和明显的非错误文案
          if (txt && txt.length > 2 && txt.length < 200) return txt;
        }
      }
      return null;
    };
    const initial = checkToast();
    if (initial) {
      finish(`小红书提示: ${initial}`);
      return;
    }

    const observer = new MutationObserver(() => {
      const found = checkToast();
      if (found) finish(`小红书提示: ${found}`);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 2) fetch 拦截 —— 发布 API 返回非 2xx 时抓
    const origFetch = window.fetch;
    const patchedFetch: typeof fetch = async (...args) => {
      const resp = await origFetch.apply(window, args as Parameters<typeof fetch>);
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
        if (/creator\.xiaohongshu\.com\/.*\/(note\/publish|publish|post)/i.test(url)) {
          if (!resp.ok) {
            finish(`发布 API 失败 ${resp.status}: ${resp.statusText}`);
          } else {
            // 读一份 clone，成功 API 里 code != 0 也算失败
            try {
              const clone = resp.clone();
              const data = await clone.json();
              if (data && (data.success === false || (typeof data.code === "number" && data.code !== 0))) {
                finish(`小红书返回错误: ${data.msg || data.message || JSON.stringify(data)}`);
              }
            } catch {
              /* 非 JSON 忽略 */
            }
          }
        }
      } catch {
        /* 拦截逻辑异常不阻塞原请求 */
      }
      return resp;
    };
    window.fetch = patchedFetch;

    // 3) 超时 → 假定成功跳转，由 background 的 publishedUrlPatterns 判断
    const timer = setTimeout(() => finish(null), opts.windowMs);

    const cleanup = () => {
      observer.disconnect();
      if (window.fetch === patchedFetch) window.fetch = origFetch;
      clearTimeout(timer);
    };
  });
}

// 优先发布图文
export async function DynamicRednote(data: SyncData) {
  console.log("[rednote] DynamicRednote injected, data:", {
    hasTitle: !!(data.data as DynamicData).title,
    contentLength: (data.data as DynamicData).content?.length,
    imageCount: (data.data as DynamicData).images?.length,
    isAutoPublish: data.isAutoPublish,
    aeoTaskId: data.aeoTaskId,
  });
  const { title, content, images } = data.data as DynamicData;

  // 报错给 background（让 background 立刻调 reportTaskEvent failed）
  const reportError = (error: string) => {
    console.error("[rednote]", error);
    if (data.aeoTaskId) {
      try {
        chrome.runtime.sendMessage({
          type: "AEO_PUBLISH_FAILED",
          taskId: data.aeoTaskId,
          error,
        });
      } catch (e) {
        console.error("[rednote] sendMessage failed:", e);
      }
    }
  };
  // 辅助函数：等待元素出现
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

  // 辅助函数：上传文件
  async function uploadImages() {
    const fileInput = (await waitForElement('input[type="file"]')) as HTMLInputElement;
    if (!fileInput) {
      console.error("未找到文件输入元素");
      return;
    }

    const dataTransfer = new DataTransfer();

    for (const fileInfo of images) {
      try {
        const response = await fetch(fileInfo.url);
        if (!response.ok) {
          throw new Error(`HTTP 错误! 状态: ${response.status}`);
        }
        const blob = await response.blob();
        const file = new File([blob], fileInfo.name, { type: fileInfo.type });
        dataTransfer.items.add(file);
      } catch (error) {
        console.error(`上传图片 ${fileInfo.url} 失败:`, error);
      }
    }

    if (dataTransfer.files.length > 0) {
      fileInput.files = dataTransfer.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 2000)); // 等待文件处理
      console.log("文件上传操作完成");
    } else {
      console.error("没有成功添加任何文件");
    }
  }

  if (images && images.length > 0) {
    console.log(`[rednote] Starting publish flow with ${images.length} images`);
    // 等待页面加载
    await waitForElement('span[class="title"]');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 点击上传图文按钮
    const uploadButtons = document.querySelectorAll('span[class="title"]');
    const uploadButton = Array.from(uploadButtons).find((element) =>
      element.textContent?.includes("上传图文"),
    ) as HTMLElement;

    if (!uploadButton) {
      reportError("未找到上传图文按钮");
      return;
    }

    uploadButton.click();
    uploadButton.dispatchEvent(new Event("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 上传文件
    await uploadImages();
    await new Promise((resolve) => setTimeout(resolve, 5000)); // 等待图片上传完成

    // 填写标题 — 小红书硬限制 20 字，超过会触发 toast 拦截发布
    const titleInput = (await waitForElement('input[type="text"]')) as HTMLInputElement;
    if (titleInput) {
      const MAX_TITLE_LENGTH = 20;
      let titleText = title || content?.slice(0, MAX_TITLE_LENGTH) || "";
      if (titleText.length > MAX_TITLE_LENGTH) {
        titleText = titleText.slice(0, MAX_TITLE_LENGTH);
        console.log(`[rednote] Title truncated to ${MAX_TITLE_LENGTH} chars: "${titleText}"`);
      }
      titleInput.value = titleText;
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 填写内容
    const contentEditor = (await waitForElement('div[contenteditable="true"]')) as HTMLDivElement;
    if (contentEditor) {
      contentEditor.focus();
      const contentPasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      contentPasteEvent.clipboardData.setData("text/plain", content || "");
      contentEditor.dispatchEvent(contentPasteEvent);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      contentEditor.blur();
      console.log("设置内容:", content);
    }

    // 自动发布
    if (data.isAutoPublish) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const buttons = document.querySelectorAll("button");
      const publishButton = Array.from(buttons).find((button) =>
        button.textContent?.includes("发布"),
      ) as HTMLButtonElement;

      if (publishButton) {
        // 等待按钮可用
        let waitAttempts = 0;
        while (publishButton.getAttribute("aria-disabled") === "true" && waitAttempts < 30) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          waitAttempts++;
          console.log(`[rednote] 等待发布按钮可用 (${waitAttempts}/30)...`);
        }
        if (publishButton.getAttribute("aria-disabled") === "true") {
          reportError("发布按钮 30s 后仍不可点击，可能标题/内容校验未通过");
          return;
        }

        console.log("[rednote] 点击发布按钮");

        // 发布前：安装 toast 观察器 + fetch/XHR 拦截器
        // 成功：小红书直接跳 URL（由 background 的 publishedUrlPatterns 感知）
        // 失败：toast 出现 or API 返回非 2xx or 页面仍停留
        const errorPromise = watchForErrors({
          windowMs: 15000,
          onError: (reason) => reportError(reason),
        });

        publishButton.click();

        // 等 15s：要么抓到错误，要么认为已跳转（background 会检测 URL）
        const errorReason = await errorPromise;
        if (errorReason) {
          return; // reportError 已在 onError 里调过
        }

        // 不主动跳 URL — 由小红书自己跳 creator/notemanage，扩展 background
        // 监听 tab URL 跳转判断成功（publishedUrlPatterns）
      }
    }
  } else {
    reportError(`没有图片可上传，小红书发布必须有图片（received images: ${JSON.stringify(images)}）`);
  }
}
