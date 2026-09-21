import {
  MediaItem,
  detectPlatform,
  proxyUrl,
  requestParse,
  saveMediaToAlbum,
} from '../../utils/parse'

Component({
  data: {
    input: '',
    loading: false,
    pasting: false,
    status: '',
    statusType: '',
    showXTip: false,
    items: [] as Array<MediaItem & { previewUrl: string }>,
    savingIndex: -1,
    savingAll: false,
  },

  methods: {
    updateXTip(text: string) {
      this.setData({ showXTip: detectPlatform(text) === 'x' })
    },

    onInput(e: WechatMiniprogram.Input) {
      const input = e.detail.value
      this.setData({ input })
      this.updateXTip(input)
    },

    onPaste() {
      this.setData({ pasting: true, status: '', statusType: '' })
      wx.getClipboardData({
        success: (res) => {
          const text = (res.data || '').trim()
          if (!text) {
            this.setData({ status: '剪贴板为空', statusType: 'err', pasting: false, showXTip: false })
            return
          }
          this.setData({ input: text, pasting: false })
          this.updateXTip(text)
        },
        fail: () => {
          this.setData({ pasting: false, status: '请长按输入框粘贴', statusType: 'err' })
        },
      })
    },

    async onParse() {
      const input = String(this.data.input || '').trim()
      if (!input) {
        this.setData({ status: '请先粘贴链接', statusType: 'err', showXTip: false })
        return
      }
      const platform = detectPlatform(input)
      if (!platform) {
        this.setData({ status: '只支持 X / 抖音 / 快手链接', statusType: 'err', showXTip: false })
        return
      }

      this.setData({
        loading: true,
        items: [],
        status: '解析中…',
        statusType: '',
        showXTip: platform === 'x',
        savingIndex: -1,
        savingAll: false,
      })

      try {
        const data = await requestParse(input)
        if (!data.ok) throw new Error(data.error || '解析失败')
        const items = (data.items || []).map((it) => ({
          ...it,
          previewUrl: proxyUrl(it.url),
        }))
        if (!items.length) throw new Error('没有可下载内容')
        this.setData({
          items,
          status: '',
          statusType: '',
        })
      } catch (err: any) {
        this.setData({
          status: err?.message || '解析失败',
          statusType: 'err',
          items: [],
        })
      } finally {
        this.setData({ loading: false })
      }
    },

    async onSave(e: WechatMiniprogram.TouchEvent) {
      const index = Number(e.currentTarget.dataset.index)
      const item = this.data.items[index]
      if (!item || this.data.savingAll) return
      this.setData({ savingIndex: index, status: '', statusType: '' })
      try {
        await saveMediaToAlbum(item)
        wx.showToast({ title: '已保存', icon: 'success' })
      } catch (err: any) {
        this.setData({ status: err?.message || '保存失败', statusType: 'err' })
      } finally {
        this.setData({ savingIndex: -1 })
      }
    },

    async onSaveAll() {
      const items = this.data.items || []
      if (!items.length || this.data.savingAll) return
      this.setData({ savingAll: true, status: '', statusType: '' })
      let ok = 0
      let fail = 0
      try {
        for (let i = 0; i < items.length; i++) {
          this.setData({ savingIndex: i })
          try {
            await saveMediaToAlbum(items[i])
            ok += 1
          } catch {
            fail += 1
          }
        }
        if (fail) {
          this.setData({ status: `保存完成：成功 ${ok}，失败 ${fail}`, statusType: 'err' })
        } else {
          wx.showToast({ title: `已保存 ${ok} 个`, icon: 'success' })
        }
      } finally {
        this.setData({ savingAll: false, savingIndex: -1 })
      }
    },
  },
})
