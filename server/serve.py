#!/usr/bin/env python3
"""统一解析服务：抖音 / 快手 / X，供微信小程序调用。

用法：
  py -3 serve.py

开发阶段：微信开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名」
并把小程序里 config.API_BASE 改成电脑局域网地址，例如 http://192.168.1.8:8787
"""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8787"))
DEMO_BASE = "https://demo.douyin.wtf"
UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 "
    "Mobile/15E148 Safari/604.1"
)

_session_lock = threading.Lock()
_cookie = ""


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def detect_platform(text: str) -> str | None:
    s = text or ""
    if re.search(r"(?:v\.douyin\.com|douyin\.com/(?:video|note)|iesdouyin\.com)", s, re.I):
        return "douyin"
    if re.search(
        r"(?:v\.kuaishou\.com|kuaishou\.com|gifshow\.com|chenzhongtech\.com|kuaishouapp\.com|kwai\.com)",
        s,
        re.I,
    ):
        return "kuaishou"
    if re.search(r"(?:twitter\.com|x\.com)/[^/\s]+/status/\d+", s, re.I) or re.search(
        r"/status/\d+", s
    ):
        return "x"
    if re.match(r"^\d{5,}$", s.strip()):
        return "x"
    return None


def extract_url(text: str, platform: str) -> str | None:
    s = (text or "").strip()
    patterns = {
        "douyin": [
            r"https?://v\.douyin\.com/[A-Za-z0-9._\-]+/?",
            r"https?://(?:www\.)?douyin\.com/(?:video|note)/\d+[^\s]*",
            r"https?://(?:www\.)?iesdouyin\.com/share/(?:video|slides)/\d+[^\s]*",
        ],
        "kuaishou": [
            r"https?://v\.kuaishou\.com/[A-Za-z0-9._\-]+/?",
            r"https?://(?:www\.)?kuaishou\.com/[^\s]+",
            r"https?://(?:www\.)?chenzhongtech\.com/[^\s]+",
            r"https?://(?:www\.)?gifshow\.com/[^\s]+",
            r"https?://(?:www\.)?kuaishouapp\.com/[^\s]+",
            r"https?://(?:www\.)?kwai\.com/[^\s]+",
        ],
        "x": [
            r"https?://(?:twitter\.com|x\.com)/[^/\s]+/status/\d+[^\s]*",
            r"https?://t\.co/[A-Za-z0-9]+",
        ],
    }
    for pat in patterns.get(platform, []):
        m = re.search(pat, s, re.I)
        if m:
            return m.group(0).rstrip(")，。,.】」'\"")
    if platform == "x" and re.match(r"^\d{5,}$", s):
        return s
    return None


def extract_tweet_id(text: str) -> str | None:
    s = (text or "").strip()
    m = (
        re.search(r"(?:twitter\.com|x\.com)/[^/\s]+/status/(\d+)", s, re.I)
        or re.search(r"/status/(\d+)", s)
        or re.match(r"^(\d{5,})$", s)
    )
    return m.group(1) if m else None


def http_json(method: str, url: str, body: dict | None = None, cookie: str = "") -> tuple[dict, str]:
    data = None
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=45) as res:
        raw = res.read().decode("utf-8", "ignore")
        set_cookie = res.headers.get_all("Set-Cookie") or []
        jar = cookie
        for sc in set_cookie:
            part = sc.split(";", 1)[0].strip()
            if not part or "=" not in part:
                continue
            name, val = part.split("=", 1)
            bits = [b for b in jar.split(";") if b.strip()] if jar else []
            new_bits = []
            found = False
            for b in bits:
                if b.strip().startswith(name + "="):
                    new_bits.append(f"{name}={val}")
                    found = True
                else:
                    new_bits.append(b.strip())
            if not found:
                new_bits.append(f"{name}={val}")
            jar = "; ".join(new_bits)
        return json.loads(raw), jar


def ensure_demo_session() -> str:
    global _cookie
    with _session_lock:
        if _cookie:
            return _cookie
        demo, _ = http_json("GET", f"{DEMO_BASE}/api/v1/auth/demo")
        password = (demo.get("data") or {}).get("password")
        if not password:
            raise RuntimeError("无法获取解析服务登录密码")
        login, jar = http_json(
            "POST",
            f"{DEMO_BASE}/api/v1/auth/login",
            {"username": "demo", "password": password},
        )
        if not login.get("success") or not jar:
            raise RuntimeError("解析服务登录失败")
        _cookie = jar
        return _cookie


def first_url(node) -> str | None:
    if isinstance(node, str) and node.startswith("http"):
        return node
    if isinstance(node, dict):
        for key in ("url", "play", "nwm_video_url", "download_url", "no_watermark", "photoUrl"):
            v = node.get(key)
            if isinstance(v, str) and v.startswith("http"):
                return v
        for key in ("urls", "url_list"):
            arr = node.get(key)
            if isinstance(arr, list):
                for u in arr:
                    if isinstance(u, str) and u.startswith("http"):
                        return u
    if isinstance(node, list):
        for item in node:
            u = first_url(item)
            if u:
                return u
    return None


def media_key(url: str) -> str:
    try:
        u = urllib.parse.urlparse(url)
        return u.scheme + "://" + u.netloc + u.path
    except Exception:
        return url.split("?")[0]


def dedupe_items(items: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for it in items:
        key = media_key(it.get("url") or "")
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def normalize_demo_payload(data: dict, source_url: str, platform: str) -> dict:
    items: list[dict] = []
    media = data.get("media") or {}
    kind = str(data.get("kind") or "").lower()

    video = media.get("video") or data.get("video")
    vurl = first_url(video)
    if vurl:
        vurl = vurl.replace("/playwm/", "/play/")
        items.append({"kind": "video", "url": vurl, "note": "无水印"})

    images = media.get("images") or media.get("image_list") or data.get("images") or []
    if isinstance(images, list):
        for img in images:
            iurl = first_url(img) if not isinstance(img, str) else img
            if iurl and iurl.startswith("http"):
                items.append({"kind": "image", "url": iurl})

    if not items:
        blob = json.dumps(data, ensure_ascii=False)
        m = re.search(
            r"https://[^\"'\\s]+(?:\.mp4|/video/tos/|/aweme/v1/play/|/bs2/)[^\"'\\s]*",
            blob,
        )
        if m:
            items.append(
                {
                    "kind": "video",
                    "url": m.group(0).replace("/playwm/", "/play/"),
                    "note": "无水印",
                }
            )

    items = dedupe_items(items)
    if not items:
        raise RuntimeError("解析成功但没有可下载内容（可能是私密或已删除）")

    title = data.get("description") or data.get("title") or ""
    author = ""
    if isinstance(data.get("author"), dict):
        author = data["author"].get("nickname") or data["author"].get("name") or ""
    return {
        "ok": True,
        "platform": platform,
        "source": source_url,
        "title": title,
        "author": author,
        "kind": kind or items[0]["kind"],
        "items": items,
    }


def parse_via_demo(share_text: str, platform: str) -> dict:
    url = extract_url(share_text, platform) or share_text.strip()
    if not url:
        raise ValueError("未找到有效链接")

    last_err: Exception | None = None
    for attempt in range(2):
        try:
            cookie = ensure_demo_session()
            data, _ = http_json(
                "POST",
                f"{DEMO_BASE}/api/v1/parse?wait=30",
                {"url": url},
                cookie=cookie,
            )
            if data.get("success"):
                return normalize_demo_payload(data.get("data") or {}, url, platform)
            err = data.get("error") or {}
            code = str(err.get("code") or "")
            if code in {"UNAUTHORIZED", "FORBIDDEN", "AUTH_REQUIRED"} and attempt == 0:
                with _session_lock:
                    global _cookie
                    _cookie = ""
                continue
            raise RuntimeError(err.get("message") or "解析失败")
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt == 0:
                with _session_lock:
                    _cookie = ""
                continue
            raise
    raise RuntimeError(str(last_err) if last_err else "解析失败")


def fetch_text(url: str, referer: str = "https://www.kuaishou.com/") -> tuple[str, str]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": referer,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        final = res.geturl()
        html = res.read().decode("utf-8", "ignore")
        return final, html


def extract_json_array_after(html: str, key: str) -> list:
    """从 HTML 里抠 "key":[ ... ] 数组。"""
    token = f'"{key}"'
    idx = html.find(token)
    if idx < 0:
        return []
    start = html.find("[", idx)
    if start < 0:
        return []
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(html)):
        ch = html[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                blob = html[start : i + 1]
                try:
                    return json.loads(blob)
                except json.JSONDecodeError:
                    return []
    return []


def parse_kuaishou(text: str) -> dict:
    """本地解析快手分享页（demo 上游不支持快手）。"""
    url = extract_url(text, "kuaishou")
    if not url:
        raise ValueError("未找到快手链接，请粘贴分享文案或 https://v.kuaishou.com/…")

    final, html = fetch_text(url)
    items: list[dict] = []

    # 视频直链
    for key in ("mainMvUrls", "main_mv_urls", "videoUrls", "mp4Urls"):
        arr = extract_json_array_after(html, key)
        for node in arr:
            u = first_url(node)
            if u and (".mp4" in u or "kwimgs.com" in u or "yximgs.com" in u):
                items.append({"kind": "video", "url": u, "note": "无水印"})
                break
        if items:
            break

    # 图集：尽量把全部图片都拿出来
    if not items:
        image_keys = (
            "atlas",
            "images",
            "photoUrls",
            "imgUrls",
            "jpegImages",
            "imageUrls",
            "pics",
            "pictureUrls",
        )
        for key in image_keys:
            arr = extract_json_array_after(html, key)
            for node in arr:
                # 可能是字符串，也可能是 {url: ...} / 嵌套 list
                candidates = []
                if isinstance(node, str):
                    candidates = [node]
                elif isinstance(node, dict):
                    u = first_url(node)
                    if u:
                        candidates = [u]
                    for sub in ("url", "urls", "urlList", "cdnUrl"):
                        v = node.get(sub)
                        if isinstance(v, str):
                            candidates.append(v)
                        elif isinstance(v, list):
                            candidates.extend([x for x in v if isinstance(x, str)])
                elif isinstance(node, list):
                    candidates = [x for x in node if isinstance(x, str)]
                for u in candidates:
                    if (
                        isinstance(u, str)
                        and u.startswith("http")
                        and ".mp4" not in u
                        and "hls" not in u
                    ):
                        items.append({"kind": "image", "url": u})
            if items:
                break

        # 再扫常见图片 CDN（去重后全收）
        if not items:
            found = re.findall(
                r"https://(?:[\w.-]+\.)?(?:yximgs|kwimgs|kuaishou)\.com/[^\"'\\s]+\.(?:jpg|jpeg|png|webp)[^\"'\\s]*",
                html,
                flags=re.I,
            )
            for u in found:
                u = u.replace("\\u002F", "/").replace("\\/", "/")
                # 过滤明显是小图标/表情
                if any(x in u.lower() for x in ("emoji", "emotion", "avatar", "icon", "logo")):
                    continue
                items.append({"kind": "image", "url": u})

    # 兜底：页面里直接扫 mp4（排除 hls ts 分片）
    if not items:
        candidates = re.findall(r"https://[^\"'\\s]+\.mp4[^\"'\\s]*", html)
        for u in candidates:
            u = u.replace("\\u002F", "/").replace("\\/", "/")
            if "hls" in u or ".ts" in u:
                continue
            items.append({"kind": "video", "url": u, "note": "无水印"})
            break

    items = dedupe_items(items)
    if not items:
        raise RuntimeError("快手解析失败：未找到可下载视频/图片（可能已删除或需登录）")

    author = ""
    m_user = re.search(r'"userName"\s*:\s*"([^"]+)"', html)
    if m_user:
        author = m_user.group(1)
    title = ""
    m_cap = re.search(r'"caption"\s*:\s*"((?:\\.|[^"\\])*)"', html)
    if m_cap:
        try:
            title = json.loads(f'"{m_cap.group(1)}"')
        except json.JSONDecodeError:
            title = m_cap.group(1)

    return {
        "ok": True,
        "platform": "kuaishou",
        "source": final or url,
        "title": title,
        "author": author,
        "kind": items[0]["kind"],
        "items": items,
    }


def media_blocks(tweet: dict) -> list:
    if isinstance(tweet.get("media_extended"), list) and tweet["media_extended"]:
        return tweet["media_extended"]
    media = tweet.get("media") or {}
    return list(media.get("videos") or []) + list(media.get("photos") or []) + list(
        media.get("all") or []
    )


def to_orig_image(url: str) -> str:
    try:
        u = urllib.parse.urlparse(url)
        if "pbs.twimg.com/media/" not in u.geturl():
            return url
        path = re.sub(r"\.(jpg|jpeg|png|webp)$", "", u.path, flags=re.I)
        qs = urllib.parse.parse_qs(u.query)
        fmt = (qs.get("format") or [None])[0]
        if not fmt:
            m = re.search(r"\.(jpg|jpeg|png|webp)(?:\?|$)", url, re.I)
            fmt = (m.group(1).lower().replace("jpeg", "jpg") if m else "jpg")
        q = urllib.parse.urlencode({"format": fmt, "name": "orig"})
        return urllib.parse.urlunparse((u.scheme, u.netloc, path, "", q, ""))
    except Exception:
        return url


def parse_x(text: str) -> dict:
    tweet_id = extract_tweet_id(text)
    if not tweet_id:
        raise ValueError("请粘贴有效的 X / Twitter 推文链接")

    tweet = None
    last_err: Exception | None = None

    # 1) fxtwitter
    try:
        data, _ = http_json("GET", f"https://api.fxtwitter.com/status/{tweet_id}")
        tweet = data.get("tweet") or data
        if not tweet or data.get("code") == 404:
            raise RuntimeError("推文不存在、已删除，或账号被封禁")
    except urllib.error.HTTPError as e:
        last_err = e
        if e.code == 404:
            # 再确认是否封禁 tombstone
            try:
                syn, _ = http_json(
                    "GET",
                    f"https://cdn.syndication.twimg.com/tweet-result?id={tweet_id}&lang=en&token=1",
                )
                if syn.get("__typename") == "TweetTombstone" or "suspended" in json.dumps(
                    syn
                ).lower():
                    raise RuntimeError("该账号已被封禁，无法解析此推文")
            except RuntimeError:
                raise
            except Exception:
                pass
            raise RuntimeError("推文不存在、已删除，或账号被封禁")
        last_err = e
    except Exception as e:  # noqa: BLE001
        last_err = e

    # 2) syndication 兜底
    if not tweet:
        try:
            syn, _ = http_json(
                "GET",
                f"https://cdn.syndication.twimg.com/tweet-result?id={tweet_id}&lang=en&token=1",
            )
            if syn.get("__typename") == "TweetTombstone" or "suspended" in json.dumps(syn).lower():
                raise RuntimeError("该账号已被封禁，无法解析此推文")
            tweet = syn
        except RuntimeError:
            raise
        except Exception as e:  # noqa: BLE001
            last_err = e

    if not tweet:
        if isinstance(last_err, urllib.error.HTTPError):
            raise RuntimeError(f"X 解析失败（HTTP {last_err.code}）")
        raise RuntimeError(str(last_err) if last_err else "X 解析失败")

    items: list[dict] = []
    for item in media_blocks(tweet):
        if not item:
            continue
        typ = str(item.get("type") or "").lower()
        if typ in {"photo", "image"}:
            raw = item.get("url") or item.get("thumbnail_url") or item.get("preview_url")
            if raw and "twimg.com" in raw and ".mp4" not in raw:
                items.append({"kind": "image", "url": to_orig_image(raw)})
            continue
        best = None
        best_score = -1
        for v in item.get("variants") or []:
            url = v.get("url")
            if not url or not re.search(r"\.mp4(?:\?|$)", url, re.I):
                continue
            score = int(v.get("bitrate") or 0)
            dim = re.search(r"/(\d+)x(\d+)/", url)
            if dim:
                score += int(dim.group(1)) * int(dim.group(2))
            if score > best_score:
                best_score = score
                best = url
        if not best and item.get("url") and ".mp4" in str(item.get("url")):
            best = item["url"]
        if best:
            items.append({"kind": "video", "url": best})

    # syndication 结构兜底
    if not items:
        media_details = tweet.get("mediaDetails") or tweet.get("photos") or []
        if isinstance(media_details, list):
            for m in media_details:
                if not isinstance(m, dict):
                    continue
                if m.get("type") == "photo" and m.get("media_url_https"):
                    items.append({"kind": "image", "url": to_orig_image(m["media_url_https"])})
                video_info = m.get("video_info") or {}
                for v in video_info.get("variants") or []:
                    url = v.get("url")
                    if url and ".mp4" in url:
                        items.append({"kind": "video", "url": url})
                        break

    items = dedupe_items(items)
    if not items:
        raise RuntimeError("这条推文没有可下载的公开视频/图片")
    return {
        "ok": True,
        "platform": "x",
        "source": f"https://x.com/i/status/{tweet_id}",
        "title": tweet.get("text") or tweet.get("full_text") or "",
        "author": ((tweet.get("author") or {}) if isinstance(tweet.get("author"), dict) else {}).get(
            "name"
        )
        or ((tweet.get("user") or {}) if isinstance(tweet.get("user"), dict) else {}).get("name")
        or "",
        "kind": items[0]["kind"],
        "items": items,
    }


def parse_any(text: str) -> dict:
    platform = detect_platform(text)
    if not platform:
        raise ValueError("请粘贴 X / 抖音 / 快手 的分享链接或文案")
    if platform == "x":
        return parse_x(text)
    if platform == "kuaishou":
        return parse_kuaishou(text)
    return parse_via_demo(text, platform)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _json(self, code: int, payload: dict) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/health":
            return self._json(200, {"ok": True, "service": "media-parse"})
        if parsed.path == "/api/parse":
            qs = urllib.parse.parse_qs(parsed.query)
            text = (qs.get("url") or qs.get("text") or [""])[0]
            return self._handle_parse(text)
        if parsed.path == "/api/proxy":
            return self._handle_proxy(parsed)
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/parse":
            return self._json(404, {"ok": False, "error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            body = {"url": raw.decode("utf-8", "ignore")}
        text = body.get("url") or body.get("text") or ""
        return self._handle_parse(str(text))

    def _handle_parse(self, text: str) -> None:
        try:
            payload = parse_any(text)
            self._json(200, payload)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or "解析失败"
            if isinstance(e, urllib.error.HTTPError):
                msg = f"上游 HTTP {e.code}"
            self._json(200, {"ok": False, "error": msg})

    def _handle_proxy(self, parsed: urllib.parse.ParseResult) -> None:
        qs = urllib.parse.parse_qs(parsed.query)
        target = (qs.get("url") or [""])[0]
        if not target.startswith("http"):
            return self._json(400, {"ok": False, "error": "缺少 url"})
        try:
            referer = "https://www.douyin.com/"
            if "twimg.com" in target or "video.twimg.com" in target:
                referer = "https://x.com/"
            elif any(
                x in target
                for x in ("kuaishou", "kwai", "gifshow", "kwimgs.com", "yximgs.com", "chenzhongtech")
            ):
                referer = "https://www.kuaishou.com/"

            # 根据链接猜扩展名，方便微信 downloadFile / 存相册
            ext = ".bin"
            low = target.lower()
            if ".mp4" in low:
                ext = ".mp4"
            elif any(x in low for x in (".jpg", "format=jpg", "name=orig")):
                ext = ".jpg"
            elif ".png" in low:
                ext = ".png"
            elif ".webp" in low:
                ext = ".webp"

            req = urllib.request.Request(
                target,
                headers={
                    "User-Agent": UA,
                    "Referer": referer,
                    "Accept": "*/*",
                },
            )
            with urllib.request.urlopen(req, timeout=120) as res:
                ctype = res.headers.get("Content-Type") or "application/octet-stream"
                if "video" in ctype or ext == ".mp4":
                    ctype = "video/mp4"
                    ext = ".mp4"
                elif "image/jpeg" in ctype:
                    ext = ".jpg"
                elif "image/png" in ctype:
                    ext = ".png"
                clen = res.headers.get("Content-Length")
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                if clen:
                    self.send_header("Content-Length", clen)
                self.send_header(
                    "Content-Disposition",
                    f'inline; filename="media{ext}"',
                )
                self._cors()
                self.end_headers()
                while True:
                    chunk = res.read(256 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except Exception as e:  # noqa: BLE001
            try:
                self._json(502, {"ok": False, "error": f"代理失败: {e}"})
            except Exception:
                pass


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ip = lan_ip()
    for line in [
        "媒体解析服务已启动（抖音 / 快手 / X）",
        f"  本机: http://127.0.0.1:{PORT}/api/health",
        f"  手机/小程序请把 API_BASE 设为: http://{ip}:{PORT}",
        "Ctrl+C 结束",
    ]:
        print(line, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)


if __name__ == "__main__":
    main()
