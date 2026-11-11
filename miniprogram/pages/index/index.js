const { parseShareText, getUsageCount } = require("../../utils/api");
const { platformLabel } = require("../../utils/platform");

function sizeText(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

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
    previewItem: null,
    downloadVisible: false,
    downloadProgress: 0,
    downloadSummary: "",
    downloadRows: [],
  },

  onLoad() {
    this._disposed = false;
    this.refreshUsage();
  },

  onHide() {
    this.onClosePreview();
  },

  onUnload() {
    this._disposed = true;
    this.pausePreview();
    for (const task of this._downloadTasks || []) task.abort();
  },

  pausePreview() {
    if (this.data.previewItem && typeof wx.createVideoContext === "function") {
      wx.createVideoContext("media-preview", this).pause();
    }
  },

  onClosePreview() {
    this.pausePreview();
    if (!this._disposed) this.setData({ previewItem: null });
  },

  onPreviewItem(e) {
    if (this.data.savingBatch || this.data.savingIndex >= 0) return;
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.result && this.data.result.items[index];
    if (!item) return;
    if (item.type === "video") {
      this.onClosePreview();
      this.setData({ previewItem: item });
    } else if (typeof wx.previewImage === "function") {
      wx.previewImage({ current: item.url, urls: this.data.result.items.filter(row => row.type === "image").map(row => row.url) });
    }
  },

  onPreviewError() {
    wx.showToast({ title: "视频暂时无法播放，可尝试保存后观看", icon: "none" });
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
    this.onClosePreview();
    this.setData({
      inputText: "",
      statusText: "",
      statusType: "info",
      result: null,
      savingIndex: -1,
      selectedCount: 0,
      allSelected: false,
      downloadVisible: false,
    });
  },

  setStatus(text, type = "info") {
    this.setData({ statusText: text, statusType: type });
  },

  async onPasteAndParse() {
    if (this.data.loading || this.data.savingBatch || this.data.savingIndex >= 0) return;

    this.onClosePreview();
    this.setData({ loading: true, result: null, selectedCount: 0, allSelected: false, downloadVisible: false });
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

  beginTransfer(total) {
    this.onClosePreview();
    this._transferRows = Array.from({ length: total }, (_, index) => ({
      id: index, label: `文件 ${index + 1}`, phase: "queued", percent: 0, known: false, detail: "等待下载",
    }));
    this._transferLastUpdate = 0;
    this.updateTransfer(0, {}, true);
  },

  updateTransfer(index, patch, force = false) {
    if (this._disposed || !this._transferRows || !this._transferRows[index]) return;
    Object.assign(this._transferRows[index], patch);
    const now = Date.now();
    if (!force && now - this._transferLastUpdate < 180) return;
    this._transferLastUpdate = now;
    const rows = this._transferRows;
    const finished = rows.filter(row => row.phase === "done" || row.phase === "failed").length;
    const fraction = row => row.phase === "done" || row.phase === "failed" ? 1 : (row.percent / 100) * 0.95;
    const progress = Math.floor(rows.reduce((sum, row) => sum + fraction(row), 0) / rows.length * 100);
    const active = rows.filter(row => row.phase === "downloading" || row.phase === "saving");
    this.setData({
      downloadVisible: true,
      downloadProgress: progress,
      downloadSummary: `已完成 ${finished} / ${rows.length}`,
      downloadRows: active.map(row => ({ ...row })),
      savingText: `保存中（${finished}/${rows.length}）`,
    });
  },

  transferProgress(index, event) {
    const written = Math.max(0, Number(event.totalBytesWritten) || 0);
    const total = Math.max(0, Number(event.totalBytesExpectedToWrite) || 0);
    const percent = total ? Math.min(100, Math.floor(written / total * 100)) : 0;
    const row = this._transferRows && this._transferRows[index];
    if (!row) return;
    const now = Date.now();
    let speed = row.speed || 0;
    if (row.lastAt && now - row.lastAt >= 500) {
      speed = Math.max(0, written - row.lastBytes) / ((now - row.lastAt) / 1000);
      row.lastAt = now;
      row.lastBytes = written;
    } else if (!row.lastAt) {
      row.lastAt = now;
      row.lastBytes = written;
    }
    const detail = sizeText(written) + (total ? " / " + sizeText(total) : "") + (speed ? " · " + sizeText(speed) + "/s" : "");
    this.updateTransfer(index, { phase: "downloading", percent, known: total > 0, detail, speed }, percent === 100);
  },

  async saveTransfer(item, index) {
    this.updateTransfer(index, { phase: "downloading", detail: "正在连接…" }, true);
    try {
      const filePath = await this.downloadFile(item.url, event => this.transferProgress(index, event));
      if (this._disposed) throw new Error("页面已关闭");
      this.updateTransfer(index, { phase: "saving", percent: 100, known: true, detail: "下载完成，正在保存到相册…" }, true);
      if (item.type === "image") await this.saveImage(filePath);
      else await this.saveVideo(filePath);
      this.updateTransfer(index, { phase: "done", percent: 100 }, true);
    } catch (error) {
      this.updateTransfer(index, { phase: "failed", detail: "保存失败" }, true);
      throw error;
    }
  },

  async onSaveSelected() {
    if (this.data.savingBatch || this.data.savingIndex >= 0) return;
    const picks = ((this.data.result && this.data.result.items) || []).filter(item => item.selected);
    if (!picks.length) return;
    this.setData({ savingBatch: true, savingText: "正在准备…" });
    try {
      await this.ensurePrivacyAuth();
      await this.ensureAlbumAuth();
      this.beginTransfer(picks.length);
      let saved = 0, failed = 0;
      let next = 0;
      const worker = async () => {
        while (next < picks.length && !this._disposed) {
          const index = next++;
          try { await this.saveTransfer(picks[index], index); saved++; }
          catch (_) { failed++; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, picks.length) }, worker));
      if (this._disposed) return;
      this.setStatus(`已保存 ${saved} 个媒体${failed ? `，${failed} 个保存失败，可重试` : ""}`, failed ? "err" : "ok");
      wx.showToast({ title: failed ? `已保存 ${saved}，失败 ${failed}` : `已保存 ${saved} 个`, icon: "none" });
    } catch (err) {
      wx.showToast({ title: (err && err.message) || "保存失败", icon: "none" });
    } finally {
      if (!this._disposed) this.setData({ savingBatch: false, savingText: "" });
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
      this.beginTransfer(1);
      await this.saveTransfer(item, 0);
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (err) {
      wx.showToast({
        title: (err && err.message) || "保存失败",
        icon: "none",
      });
    } finally {
      if (!this._disposed) this.setData({ savingIndex: -1 });
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

  downloadFile(url, onProgress) {
    return new Promise((resolve, reject) => {
      let task, settled = false;
      const listener = event => {
        if (!settled && !this._disposed && onProgress) onProgress(event);
      };
      const finish = () => {
        settled = true;
        if (this._downloadTasks && task) this._downloadTasks.delete(task);
        if (task && typeof task.offProgressUpdate === "function") task.offProgressUpdate(listener);
      };
      task = wx.downloadFile({
        url,
        timeout: 600000,
        success: (res) => {
          finish();
          if (res.statusCode === 200 && res.tempFilePath) {
            resolve(res.tempFilePath);
            return;
          }
          reject(new Error("下载文件失败"));
        },
        fail: (err) => { finish(); reject(new Error((err && err.errMsg) || "下载失败")); },
      });
      if (task && !settled) {
        if (!this._downloadTasks) this._downloadTasks = new Set();
        this._downloadTasks.add(task);
        if (typeof task.onProgressUpdate === "function") task.onProgressUpdate(listener);
      }
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
