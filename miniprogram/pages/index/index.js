const { parseShareText, getUsageCount } = require("../../utils/api");
const { platformLabel } = require("../../utils/platform");

Page({
  data: {
    inputText: "",
    loading: false,
    savingIndex: -1,
    savingBatch: false,
    savingText: "",
    selectedCount: 0,
    allSelected: false,
    usageCount: null,
    statusText: "",
    statusType: "info",
    result: null,
  },

  onLoad() {
    this.refreshUsage();
  },

  async refreshUsage() {
    try { this.setData({ usageCount: await getUsageCount() }); }
    catch (_) { /* 计数读取失败不影响解析和保存 */ }
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  onClear() {
    if (this.data.loading || this.data.savingBatch || this.data.savingIndex >= 0) return;
    this.setData({
      inputText: "",
      statusText: "",
      statusType: "info",
      result: null,
      savingIndex: -1,
      selectedCount: 0,
      allSelected: false,
    });
  },

  setStatus(text, type = "info") {
    this.setData({ statusText: text, statusType: type });
  },

  async onPasteAndParse() {
    if (this.data.loading || this.data.savingBatch || this.data.savingIndex >= 0) return;

    this.setData({ loading: true, result: null, selectedCount: 0, allSelected: false });
    this.setStatus("正在读取剪贴板…", "info");

    try {
      let text = (this.data.inputText || "").trim();
      if (!text) {
        await this.ensurePrivacyAuth();
        const clip = await new Promise((resolve, reject) => {
          wx.getClipboardData({
            success: (res) => resolve((res && res.data) || ""),
            fail: () => reject(new Error("未能读取剪贴板，可手动粘贴链接后解析")),
          });
        });
        text = String(clip || "").trim();
        if (!text) {
          throw new Error("剪贴板为空，请先复制分享链接");
        }
        this.setData({ inputText: text });
      }

      this.setStatus("正在解析…", "info");
      const data = await parseShareText(text);
      const items = Array.isArray(data.items) ? data.items.filter((i) => i && i.url).map(item => ({ ...item, selected: false, platformLabel: platformLabel(item.platform || data.platform) })) : [];
      if (!items.length) {
        throw new Error("未解析到可下载的图片或视频");
      }

      this.setData({
        result: {
          platform: data.platform,
          platformLabel: data.batch ? "批量解析" : platformLabel(data.platform),
          title: data.title || "",
          author: data.author || "",
          items,
          errors: (data.errors || []).map(error => ({ ...error, platformLabel: platformLabel(error.platform) })),
          batch: !!data.batch,
        },
      });
      this.setStatus(data.batch
        ? `共 ${data.total} 条链接，成功 ${data.success}，失败 ${data.failed}，得到 ${items.length} 个媒体`
        : `解析成功，共 ${items.length} 个媒体`, data.failed ? "info" : "ok");
      if (Number.isSafeInteger(data.usageCount)) this.setData({ usageCount: data.usageCount });
      else this.refreshUsage();
    } catch (err) {
      this.setStatus((err && err.message) || "解析失败", "err");
    } finally {
      this.setData({ loading: false });
    }
  },

  onToggleItem(e) {
    if (!this.data.result || this.data.savingBatch || this.data.savingIndex >= 0) return;
    const index = Number(e.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !this.data.result.items[index]) return;
    const items = this.data.result.items.map((item, i) => i === index ? { ...item, selected: !item.selected } : item);
    this.updateSelection(items);
  },

  onSelectAll() {
    if (!this.data.result || this.data.savingBatch || this.data.savingIndex >= 0) return;
    const select = !this.data.allSelected;
    this.updateSelection(this.data.result.items.map(item => ({ ...item, selected: select })));
  },

  updateSelection(items) {
    const selectedCount = items.filter(item => item.selected).length;
    this.setData({ result: { ...this.data.result, items }, selectedCount, allSelected: selectedCount === items.length && items.length > 0 });
  },

  async onSaveSelected() {
    if (this.data.savingBatch || this.data.savingIndex >= 0) return;
    const picks = ((this.data.result && this.data.result.items) || []).filter(item => item.selected);
    if (!picks.length) return;
    this.setData({ savingBatch: true, savingText: "正在准备…" });
    try {
      await this.ensurePrivacyAuth();
      await this.ensureAlbumAuth();
      let saved = 0, failed = 0;
      for (let i = 0; i < picks.length; i++) {
        this.setData({ savingText: `保存中（${i + 1}/${picks.length}）` });
        try {
          const filePath = await this.downloadFile(picks[i].url);
          if (picks[i].type === "image") await this.saveImage(filePath);
          else await this.saveVideo(filePath);
          saved++;
        } catch (_) { failed++; }
      }
      this.setStatus(`已保存 ${saved} 个媒体${failed ? `，${failed} 个保存失败，可重试` : ""}`, failed ? "err" : "ok");
      wx.showToast({ title: failed ? `已保存 ${saved}，失败 ${failed}` : `已保存 ${saved} 个`, icon: "none" });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || "保存失败", icon: "none" });
    } finally {
      this.setData({ savingBatch: false, savingText: "" });
    }
  },

  async onSave(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.result && this.data.result.items[index];
    if (!item || !item.url) return;
    if (this.data.savingIndex >= 0 || this.data.savingBatch) return;

    this.setData({ savingIndex: index });
    try {
      await this.ensurePrivacyAuth();
      await this.ensureAlbumAuth();
      const filePath = await this.downloadFile(item.url);
      if (item.type === "image") {
        await this.saveImage(filePath);
      } else {
        await this.saveVideo(filePath);
      }
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (err) {
      wx.showToast({
        title: (err && err.message) || "保存失败",
        icon: "none",
      });
    } finally {
      this.setData({ savingIndex: -1 });
    }
  },

  ensurePrivacyAuth() {
    if (typeof wx.requirePrivacyAuthorize !== "function") return Promise.resolve();
    return new Promise((resolve, reject) => {
      wx.requirePrivacyAuthorize({
        success: resolve,
        fail: () => reject(new Error("请先阅读并同意隐私保护指引后使用此功能")),
      });
    });
  },

  onOpenPrivacy() {
    if (typeof wx.openPrivacyContract !== "function") {
      wx.showToast({ title: "请升级微信后查看隐私保护指引", icon: "none" });
      return;
    }
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: "隐私保护指引暂不可用", icon: "none" }) });
  },

  ensureAlbumAuth() {
    return new Promise((resolve, reject) => {
      wx.getSetting({
        success: (setting) => {
          if (setting.authSetting["scope.writePhotosAlbum"]) {
            resolve();
            return;
          }
          wx.authorize({
            scope: "scope.writePhotosAlbum",
            success: resolve,
            fail: () => {
              wx.showModal({
                title: "需要相册权限",
                content: "保存媒体到相册需要授权，请在设置中开启",
                confirmText: "去设置",
                success: (modal) => {
                  if (modal.confirm) {
                    wx.openSetting({
                      success: (res) => {
                        if (res.authSetting["scope.writePhotosAlbum"]) resolve();
                        else reject(new Error("未授予相册权限"));
                      },
                      fail: () => reject(new Error("打开设置失败")),
                    });
                  } else {
                    reject(new Error("未授予相册权限"));
                  }
                },
                fail: () => reject(new Error("未授予相册权限")),
              });
            },
          });
        },
        fail: () => reject(new Error("读取权限失败")),
      });
    });
  },

  downloadFile(url) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url,
        success: (res) => {
          if (res.statusCode === 200 && res.tempFilePath) {
            resolve(res.tempFilePath);
            return;
          }
          reject(new Error("下载文件失败"));
        },
        fail: (err) => reject(new Error((err && err.errMsg) || "下载失败")),
      });
    });
  },

  saveImage(filePath) {
    return new Promise((resolve, reject) => {
      wx.saveImageToPhotosAlbum({
        filePath,
        success: resolve,
        fail: (err) => reject(new Error((err && err.errMsg) || "保存图片失败")),
      });
    });
  },

  saveVideo(filePath) {
    return new Promise((resolve, reject) => {
      wx.saveVideoToPhotosAlbum({
        filePath,
        success: resolve,
        fail: (err) => reject(new Error((err && err.errMsg) || "保存视频失败")),
      });
    });
  },
});
