# X视频下载（微信小程序）

支持 **X / 抖音 / 快手** 链接解析，预览后保存到相册，**iOS / 安卓** 通用。

## 目录

- `miniprogram/` 微信小程序前端
- `server/serve.py` 解析 + 下载代理后端（抖音/快手必需）

## 快速开始

### 1. 启动后端

```bat
cd D:\project\demo1\server
py -3 serve.py
```

终端会打印局域网地址，例如 `http://192.168.1.8:8787`。

### 2. 配置小程序 API

编辑 `miniprogram/utils/config.ts`：

```ts
export const API_BASE = 'http://192.168.1.8:8787'  // 改成你的电脑局域网 IP
```

真机预览时，手机和电脑必须同一 WiFi。

### 3. 开发者工具

1. 用微信开发者工具打开 `D:\project\demo1`
2. 详情 → 本地设置 → 勾选 **不校验合法域名、web-view、TLS 版本及 HTTPS 证书**
3. 编译运行；真机调试可测保存到相册

## 使用

1. 在 X / 抖音 / 快手 App 复制分享链接  
2. 回到小程序点「粘贴」→「解析下载」  
3. 下方预览，点「保存」写入系统相册（iOS / 安卓）

## 正式上线注意

微信要求配置 **request / downloadFile 合法域名**（必须 HTTPS）。

可选方案：

1. 把 `server/serve.py` 部署到你的 HTTPS 服务器  
2. `API_BASE` 改成该域名  
3. 公众平台后台把该域名加入 request、downloadFile 合法域名  

开发阶段用「不校验合法域名」即可调试。

## 说明

- 仅支持公开内容  
- 请遵守各平台规则与版权  
- 抖音一般为无水印地址  
