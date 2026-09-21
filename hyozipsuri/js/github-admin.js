window.HyoRemote = (function () {
  const TOKEN_KEY = "hyo.gh";
  const SITE_URL = "https://hyosungmwk.github.io/hyozipsuri/";
  let mode = "server";
  let vault = null;
  let token = "";
  let siteCache = null;

  function useGithub() {
    return mode === "github";
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToB64(input) {
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : input instanceof Uint8Array
          ? input
          : new TextEncoder().encode(String(input));
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function decryptSecret(password, pack) {
    const enc = new TextEncoder();
    const salt = b64ToBytes(pack.salt);
    const iv = b64ToBytes(pack.iv);
    const data = b64ToBytes(pack.data);
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: Number(pack.iter) || 120000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new TextDecoder().decode(plain);
  }

  async function loadVault() {
    token = sessionStorage.getItem(TOKEN_KEY) || "";
    try {
      const res = await fetch("js/admin-vault.json", { cache: "no-store" });
      if (res.ok) vault = await res.json();
    } catch (_err) {}
  }

  async function detect() {
    if (/\.github\.io$/i.test(location.hostname)) {
      mode = "github";
      await loadVault();
      return;
    }
    try {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      const type = res.headers.get("content-type") || "";
      if (res.ok && type.includes("json")) {
        const data = await res.json();
        if (data && typeof data.admin === "boolean") {
          mode = "server";
          return;
        }
      }
    } catch (_err) {}
    mode = "github";
    await loadVault();
  }

  function requireToken() {
    if (!token) throw new Error("로그인이 필요합니다.");
  }

  function ghHeaders() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function filePath(rel) {
    const dir = String(vault.dir || "hyozipsuri").replace(/^\/+|\/+$/g, "");
    return `${dir}/${String(rel).replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  }

  function contentsUrl(relPath) {
    return `https://api.github.com/repos/${vault.repo}/contents/${filePath(relPath)}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isShaConflict(status, message) {
    return status === 409 || status === 422 || /does not match|sha/i.test(String(message || ""));
  }

  async function githubGetFile(relPath) {
    requireToken();
    if (!vault || !vault.repo) throw new Error("이 페이지에서 저장할 수 있는 설정이 없습니다.");
    const branch = vault.branch || "main";
    const res = await fetch(`${contentsUrl(relPath)}?ref=${encodeURIComponent(branch)}`, {
      headers: ghHeaders(),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("GitHub에서 파일을 읽지 못했습니다.");
    return res.json();
  }

  async function githubPut(relPath, bytes, message, attempt) {
    requireToken();
    if (!vault || !vault.repo) throw new Error("이 페이지에서 저장할 수 있는 설정이 없습니다.");
    const tryNo = Number(attempt) || 0;
    const branch = vault.branch || "main";
    const existing = await githubGetFile(relPath);
    const sha = existing && !Array.isArray(existing) ? existing.sha : undefined;
    const res = await fetch(contentsUrl(relPath), {
      method: "PUT",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message || "효성집수리 홈페이지 수정",
        content: bytesToB64(bytes),
        branch,
        sha,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const conflict = isShaConflict(res.status, err.message);
      if (conflict && relPath !== "site.json" && tryNo < 5) {
        await sleep(400 * (tryNo + 1));
        return githubPut(relPath, bytes, message, tryNo + 1);
      }
      if (conflict) {
        throw new Error("저장이 겹쳤습니다. 잠시 후 다시 저장해 주세요.");
      }
      throw new Error(err.message || "GitHub 저장에 실패했습니다.");
    }
    return res.json();
  }

  function normalizeSite(data) {
    const site = data && typeof data === "object" ? data : {};
    site.settings = site.settings || {};
    if (!Array.isArray(site.notices)) site.notices = [];
    if (!Array.isArray(site.works)) site.works = [];
    return site;
  }

  async function loadSite() {
    const file = await githubGetFile("site.json");
    if (file && file.content) {
      const text = new TextDecoder().decode(b64ToBytes(String(file.content).replace(/\s/g, "")));
      siteCache = normalizeSite(JSON.parse(text));
      return siteCache;
    }
    const res = await fetch("site.json", { cache: "no-store" });
    if (!res.ok) throw new Error("내용을 불러오지 못했습니다.");
    siteCache = normalizeSite(await res.json());
    return siteCache;
  }

  async function saveSite(site, message) {
    await githubPut("site.json", JSON.stringify(site, null, 2), message);
    siteCache = site;
  }

  async function mutateSite(mutator, message) {
    let lastErr;
    for (let i = 0; i < 5; i += 1) {
      const site = await loadSite();
      await mutator(site);
      try {
        await saveSite(site, message);
        return site;
      } catch (err) {
        lastErr = err;
        if (!/겹쳤|match|sha/i.test(String(err.message || "")) || i === 4) throw err;
        await sleep(400 * (i + 1));
      }
    }
    throw lastErr;
  }

  function mediaUrl(src) {
    const path = String(src || "").replace(/^\//, "");
    if (!path) return "";
    if (mode === "github" && vault && vault.repo && (path.startsWith("uploads/") || path.startsWith("images/"))) {
      const branch = vault.branch || "main";
      return `https://raw.githubusercontent.com/${vault.repo}/${branch}/${filePath(path)}`;
    }
    return path;
  }

  function formValue(body, key) {
    if (body instanceof FormData) return body.get(key);
    if (body && typeof body === "object") return body[key];
    return "";
  }

  function parsePinned(value) {
    return value === true || value === "true" || value === "on" || value === "1";
  }

  function newId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function extOf(file) {
    const name = String(file && file.name ? file.name : "");
    const match = name.match(/\.[a-zA-Z0-9]+$/);
    if (match) return match[0].toLowerCase();
    if (file && file.type === "image/png") return ".png";
    if (file && file.type === "image/webp") return ".webp";
    return ".jpg";
  }

  async function prepareImage(file) {
    if (window.HyoImage) return HyoImage.prepare(file, 1400);
    return { bytes: await file.arrayBuffer(), ext: extOf(file) };
  }

  async function uploadOne(file) {
    if (!file || !file.size) throw new Error("이미지 파일을 올려 주세요.");
    const prepared = await prepareImage(file);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${prepared.ext || ".jpg"}`;
    const rel = `uploads/${name}`;
    await githubPut(rel, prepared.bytes, "효성집수리 사진 추가");
    return `/${rel}`;
  }

  async function api(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body;

    if (url === "/api/login" && method === "POST") {
      const payload = typeof body === "string" ? JSON.parse(body) : body || {};
      const password = String(payload.password || "");
      if (!vault || !vault.data || !vault.salt) {
        throw new Error("이 페이지에서 저장할 수 있는 설정이 없습니다. 컴퓨터에서 한 번 저장해 올려 주세요.");
      }
      try {
        token = await decryptSecret(password, vault);
      } catch (_err) {
        throw new Error("비밀번호가 올바르지 않습니다.");
      }
      if (!token) throw new Error("비밀번호가 올바르지 않습니다.");
      sessionStorage.setItem(TOKEN_KEY, token);
      return { ok: true };
    }

    if (url === "/api/logout" && method === "POST") {
      token = "";
      sessionStorage.removeItem(TOKEN_KEY);
      return { ok: true };
    }

    if (url === "/api/me") {
      return { admin: Boolean(token) };
    }

    if (url === "/api/github") {
      return { connected: true, remote: true, siteUrl: SITE_URL };
    }

    if (url === "/api/site") {
      return loadSite();
    }

    if (url === "/api/upload" && method === "POST") {
      requireToken();
      const files = body instanceof FormData ? body.getAll("images") : [];
      const urls = [];
      for (const file of files) {
        if (file && file.size) urls.push(await uploadOne(file));
      }
      if (!urls.length) throw new Error("이미지 파일을 올려 주세요.");
      return { urls };
    }

    const noticeMatch = url.match(/^\/api\/notices(?:\/([^/?]+))?$/);
    if (noticeMatch) {
      requireToken();
      const site = await loadSite();
      const id = noticeMatch[1];
      if (method === "POST") {
        const item = {
          id: newId("n"),
          title: String(formValue(body, "title") || "").trim(),
          body: String(formValue(body, "body") || "").trim(),
          date: String(formValue(body, "date") || new Date().toISOString().slice(0, 10)),
          pinned: parsePinned(formValue(body, "pinned")),
        };
        if (!item.title) throw new Error("제목을 입력해 주세요.");
        site.notices.unshift(item);
        await saveSite(site, "효성집수리 글 저장");
        return { ...item, github: { ok: true, siteUrl: SITE_URL } };
      }
      if (method === "PUT" && id) {
        const item = site.notices.find((n) => n.id === id);
        if (!item) throw new Error("공지를 찾을 수 없습니다.");
        item.title = String(formValue(body, "title") ?? item.title).trim();
        item.body = String(formValue(body, "body") ?? item.body).trim();
        item.date = String(formValue(body, "date") ?? item.date);
        item.pinned = parsePinned(formValue(body, "pinned"));
        if (!item.title) throw new Error("제목을 입력해 주세요.");
        await saveSite(site, "효성집수리 글 수정");
        return { ...item, github: { ok: true, siteUrl: SITE_URL } };
      }
      if (method === "DELETE" && id) {
        const before = site.notices.length;
        site.notices = site.notices.filter((n) => n.id !== id);
        if (site.notices.length === before) throw new Error("공지를 찾을 수 없습니다.");
        await saveSite(site, "효성집수리 글 삭제");
        return { ok: true, github: { ok: true, siteUrl: SITE_URL } };
      }
    }

    if (url === "/api/settings" && method === "PUT") {
      requireToken();
      let photoUrl = "";
      const photo = body instanceof FormData ? body.get("photo") : null;
      if (photo && photo.size) photoUrl = await uploadOne(photo);
      const site = await mutateSite((next) => {
        next.settings = {
          ...next.settings,
          companyName: String(formValue(body, "companyName") || "").trim() || next.settings.companyName,
          ownerName: String(formValue(body, "ownerName") ?? next.settings.ownerName ?? "").trim(),
          ownerTitle: String(formValue(body, "ownerTitle") ?? next.settings.ownerTitle ?? "").trim(),
          cardHeadline: String(formValue(body, "cardHeadline") ?? next.settings.cardHeadline ?? "").trim(),
          cardTagline: String(formValue(body, "cardTagline") ?? next.settings.cardTagline ?? "").trim(),
          cardIntro: String(formValue(body, "cardIntro") ?? next.settings.cardIntro ?? "").trim(),
          phone: String(formValue(body, "phone") || "").trim(),
          area: String(formValue(body, "area") || "").trim(),
          hours: formValue(body, "hours") == null ? next.settings.hours || "" : String(formValue(body, "hours") || "").trim(),
          blogUrl: formValue(body, "blogUrl") == null ? next.settings.blogUrl || "" : String(formValue(body, "blogUrl") || "").trim(),
          blogCta: formValue(body, "blogCta") == null ? next.settings.blogCta || "" : String(formValue(body, "blogCta") || "").trim(),
        };
        if (photoUrl) next.settings.photo = photoUrl;
      }, "효성집수리 명함 수정");
      return { ...site.settings, github: { ok: true, siteUrl: SITE_URL } };
    }

    const worksMatch = url.match(/^\/api\/works(?:\/([^/?]+))?$/);
    if (worksMatch) {
      requireToken();
      const id = worksMatch[1];
      if (method === "POST") {
        const files = body instanceof FormData
          ? [...body.getAll("images"), body.get("image")].filter((file) => file && file.size)
          : [];
        if (!files.length) throw new Error("사진을 올려 주세요.");
        const current = await loadSite();
        if ((current.works || []).length >= 8) throw new Error("시공 사진은 최대 8장까지 올릴 수 있습니다.");
        const room = 8 - (current.works || []).length;
        const picked = files.slice(0, room);
        const items = [];
        for (const file of picked) {
          items.push({ id: newId("w"), src: await uploadOne(file) });
        }
        await mutateSite((site) => {
          site.works = Array.isArray(site.works) ? site.works : [];
          for (const item of items) {
            if (site.works.length >= 8) break;
            if (!site.works.some((work) => work.src === item.src)) site.works.push(item);
          }
        }, "효성집수리 시공 사진 추가");
        return { items, github: { ok: true, siteUrl: SITE_URL } };
      }
      if (method === "DELETE" && id) {
        await mutateSite((site) => {
          site.works = Array.isArray(site.works) ? site.works : [];
          const before = site.works.length;
          site.works = site.works.filter((item) => item.id !== id);
          if (site.works.length === before) throw new Error("사진을 찾을 수 없습니다.");
        }, "효성집수리 시공 사진 삭제");
        return { ok: true, github: { ok: true, siteUrl: SITE_URL } };
      }
    }

    throw new Error("요청에 실패했습니다.");
  }

  return { detect, useGithub, api, mediaUrl };
})();
