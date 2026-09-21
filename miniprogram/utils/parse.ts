import { API_BASE, USE_PROXY } from './config'

export type Platform = 'x' | 'douyin' | 'kuaishou'

export interface MediaItem {
  kind: 'video' | 'image'
  url: string
  note?: string
  previewUrl?: string
}

export interface ParseResult {
  ok: boolean
  platform?: Platform
  source?: string
  title?: string
  author?: string
  kind?: string
  items?: MediaItem[]
  error?: string
}

export function detectPlatform(input: string): Platform | null {
  const s = String(input || '')
  if (/(?:v\.douyin\.com|douyin\.com\/(?:video|note)|iesdouyin\.com)/i.test(s)) return 'douyin'
  if (/(?:v\.kuaishou\.com|kuaishou\.com|gifshow\.com|chenzhongtech\.com|kuaishouapp\.com|kwai\.com)/i.test(s)) {
    return 'kuaishou'
  }
  if (/(?:twitter\.com|x\.com)\/[^/\s]+\/status\/\d+/i.test(s) || /\/status\/\d+/.test(s)) return 'x'
  if (/^\d{5,}$/.test(s.trim())) return 'x'
  return null
}

export function platformLabel(p?: string): string {
  if (p === 'douyin') return '抖音'
  if (p === 'kuaishou') return '快手'
  if (p === 'x') return 'X'
  return '未知'
}

export function proxyUrl(url: string): string {
  if (!USE_PROXY) return url
  return `${API_BASE}/api/proxy?url=${encodeURIComponent(url)}`
}

export function requestParse(text: string): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${API_BASE}/api/parse`,
      method: 'POST',
      timeout: 60000,
      header: { 'Content-Type': 'application/json' },
      data: { url: String(text || '').trim() },
      success(res) {
        const data = (res.data || {}) as ParseResult
        if (res.statusCode >= 400) {
          reject(new Error(`接口 HTTP ${res.statusCode}`))
          return
        }
        resolve(data)
      },
      fail(err) {
        reject(new Error(err.errMsg || '网络错误，请确认已启动 server/serve.py 且 API_BASE 正确'))
      },
    })
  })
}

export function ensureAlbumAuth(): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success(setting) {
        if (setting.authSetting['scope.writePhotosAlbum']) {
          resolve()
          return
        }
        wx.authorize({
          scope: 'scope.writePhotosAlbum',
          success: () => resolve(),
          fail: () => {
            wx.showModal({
              title: '需要相册权限',
              content: '保存视频/图片到相册，请在设置中允许访问相册',
              confirmText: '去设置',
              success(r) {
                if (r.confirm) {
                  wx.openSetting({
                    success(s) {
                      if (s.authSetting['scope.writePhotosAlbum']) resolve()
                      else reject(new Error('未授权相册权限'))
                    },
                    fail: () => reject(new Error('打开设置失败')),
                  })
                } else {
                  reject(new Error('未授权相册权限'))
                }
              },
            })
          },
        })
      },
      fail: () => reject(new Error('读取权限失败')),
    })
  })
}

export function saveMediaToAlbum(item: MediaItem): Promise<void> {
  const fileUrl = proxyUrl(item.url)
  const ext = item.kind === 'video' ? 'mp4' : 'jpg'
  return ensureAlbumAuth().then(
    () =>
      new Promise((resolve, reject) => {
        wx.showLoading({ title: '下载中', mask: true })
        wx.downloadFile({
          url: fileUrl,
          timeout: 180000,
          success(dl) {
            if (dl.statusCode !== 200 || !dl.tempFilePath) {
              wx.hideLoading()
              reject(new Error(dl.statusCode === 502 ? '下载失败，请确认电脑网络可访问该平台' : '下载失败'))
              return
            }
            const fs = wx.getFileSystemManager()
            const dest = `${wx.env.USER_DATA_PATH}/dl_${Date.now()}.${ext}`

            const saveAlbum = (filePath: string) => {
              const done = () => {
                wx.hideLoading()
                try {
                  fs.unlinkSync(filePath)
                } catch (_) {}
                resolve()
              }
              const fail = (e: WechatMiniprogram.GeneralCallbackResult) => {
                wx.hideLoading()
                reject(new Error(e.errMsg || '保存失败'))
              }
              if (item.kind === 'video') {
                wx.saveVideoToPhotosAlbum({ filePath, success: done, fail })
              } else {
                wx.saveImageToPhotosAlbum({ filePath, success: done, fail })
              }
            }

            // 微信要求带正确后缀，否则 iOS/安卓都可能存失败
            try {
              fs.saveFile({
                tempFilePath: dl.tempFilePath,
                filePath: dest,
                success: () => saveAlbum(dest),
                fail: () => saveAlbum(dl.tempFilePath),
              })
            } catch (_) {
              saveAlbum(dl.tempFilePath)
            }
          },
          fail(err) {
            wx.hideLoading()
            const msg = err.errMsg || '下载失败'
            if (/timeout|timed out/i.test(msg)) {
              reject(new Error('下载超时，视频较大或网络不稳，请重试'))
            } else {
              reject(new Error(msg))
            }
          },
        })
      })
  )
}
