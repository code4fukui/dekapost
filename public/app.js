const $ = (selector) => document.querySelector(selector);
const signupView = $("#signup-view");
const loginView = $("#login-view");
const appView = $("#app-view");
const adminView = $("#admin-view");
const accountMenu = $("#account-menu");
const accountActions = $("#account-actions");
const userIdButton = $("#user-id");
const logoutButton = $("#logout");
let activeUpload;

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "処理に失敗しました");
  return data;
}

function show(view) {
  for (const item of [signupView, loginView, appView]) item.hidden = item !== view;
  const authenticated = view === appView;
  logoutButton.hidden = !authenticated;
  accountMenu.hidden = !authenticated;
  accountActions.hidden = true;
  $("#guest-nav").hidden = authenticated;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2500);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatStorage(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;
}

function encodeBase64url(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  )
    .replace(/=+$/, "");
}

function decodeBase64url(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + padding;
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function credentialJSON(credential) {
  const response = credential.response;
  const result = {
    id: credential.id,
    rawId: encodeBase64url(credential.rawId),
    type: credential.type,
    response: { clientDataJSON: encodeBase64url(response.clientDataJSON) },
  };
  if ("attestationObject" in response) {
    result.response.attestationObject = encodeBase64url(response.attestationObject);
    result.response.transports = response.getTransports?.() ?? [];
  } else {
    result.response.authenticatorData = encodeBase64url(response.authenticatorData);
    result.response.signature = encodeBase64url(response.signature);
    result.response.userHandle = response.userHandle ? encodeBase64url(response.userHandle) : null;
  }
  return result;
}

async function startPasskeyLogin() {
  if (!globalThis.PublicKeyCredential) throw new Error("このブラウザはパスキーに対応していません");
  const options = await api("/api/passkey/login/options", { method: "POST" });
  const publicKey = { ...options, challenge: decodeBase64url(options.challenge) };
  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) throw new Error("パスキーが選択されませんでした");
  return api("/api/passkey/login/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: credentialJSON(credential) }),
  });
}

async function registerPasskey(id, acceptedTerms = false) {
  if (!globalThis.PublicKeyCredential) throw new Error("このブラウザはパスキーに対応していません");
  const options = await api("/api/passkey/register/options", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, acceptedTerms, termsVersion: "NANI Terms v1.0" }),
  });
  const publicKey = {
    ...options,
    challenge: decodeBase64url(options.challenge),
    user: { ...options.user, id: decodeBase64url(options.user.id) },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: decodeBase64url(credential.id),
    })),
  };
  const credential = await navigator.credentials.create({ publicKey });
  if (!credential) throw new Error("パスキーが作成されませんでした");
  await api("/api/passkey/register/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: credentialJSON(credential) }),
  });
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

async function loadFiles() {
  const files = await api("/api/files");
  $("#empty").hidden = files.length > 0;
  const container = $("#files");
  container.replaceChildren(...files.map((file) => {
    const row = document.createElement("article");
    row.className = "file-row";
    const info = document.createElement("div");
    info.className = "file-info";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const meta = document.createElement("span");
    meta.textContent = `${formatSize(file.size)} · ${formatDate(file.createdAt)} · ${
      formatDate(file.expiresAt)
    }に削除`;
    info.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "actions";
    const copy = document.createElement("button");
    copy.textContent = "リンクをコピー";
    copy.onclick = async () => {
      await navigator.clipboard.writeText(new URL(file.url, location.origin));
      toast("共有リンクをコピーしました");
    };
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "削除";
    remove.onclick = async () => {
      if (!confirm(`「${file.name}」を削除しますか？`)) return;
      await api(`/api/files/${file.id}`, { method: "DELETE" });
      await loadFiles();
    };
    actions.append(copy, remove);
    row.append(info, actions);
    return row;
  }));
}

async function enterApp() {
  show(appView);
  const user = await api("/api/me");
  userIdButton.textContent = "ID: " + user.id;
  userIdButton.title = "この端末にパスキーを追加";
  adminView.hidden = !user.isAdmin;
  await loadFiles();
  if (user.isAdmin) await loadUsers();
}

async function loadUsers() {
  const users = await api("/api/admin/users");
  $("#users").replaceChildren(...users.map((user) => {
    const row = document.createElement("tr");
    const id = document.createElement("th");
    id.scope = "row";
    id.textContent = user.id + (user.isAdmin ? " (管理者)" : "");
    const storage = document.createElement("td");
    storage.textContent = formatStorage(user.storageBytes);
    const fileCount = document.createElement("td");
    fileCount.textContent = user.fileCount.toLocaleString("ja-JP");
    const totalFileCount = document.createElement("td");
    totalFileCount.textContent = user.totalFileCount.toLocaleString("ja-JP");
    const created = document.createElement("td");
    created.textContent = formatDate(user.createdAt);
    row.append(id, storage, fileCount, totalFileCount, created);
    return row;
  }));
}

$("#show-login").onclick = () => show(loginView);
$("#back-to-signup").onclick = () => show(signupView);

$("#signup-form").onsubmit = async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  $("#signup-error").textContent = "";
  try {
    await registerPasskey(undefined, values.acceptedTerms === "on");
    await startPasskeyLogin();
    await enterApp();
    toast("アカウントを作成しました");
  } catch (error) {
    $("#signup-error").textContent = error.message;
  }
};

$("#passkey-login").onclick = async () => {
  $("#login-error").textContent = "";
  try {
    await startPasskeyLogin();
    await enterApp();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
};

logoutButton.onclick = async () => {
  await api("/api/logout", { method: "POST" });
  show(signupView);
};

userIdButton.onclick = () => {
  accountActions.hidden = !accountActions.hidden;
};

$("#add-passkey").onclick = async () => {
  accountActions.hidden = true;
  try {
    const user = await api("/api/me");
    await registerPasskey(user.id);
    toast("この端末にパスキーを追加しました");
  } catch (error) {
    toast(error.message);
  }
};

$("#delete-account").onclick = async () => {
  accountActions.hidden = true;
  if (
    !confirm("アカウントを削除しますか？\nすべてのファイル、パスキー、ログイン情報が削除されます。")
  ) return;
  try {
    await api("/api/account", { method: "DELETE" });
    show(signupView);
    toast("アカウントを削除しました");
  } catch (error) {
    toast(error.message);
  }
};

function upload(file) {
  if (!file || activeUpload) return;
  const progress = $("#progress");
  progress.hidden = false;
  $("#upload-result").hidden = true;
  $("#dropzone").hidden = true;
  $("#progress-name").textContent = file.name;
  const request = new XMLHttpRequest();
  activeUpload = request;
  request.open("POST", "/api/files");
  request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
  request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
  request.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const value = Math.round(event.loaded / event.total * 100);
    $("#progress-value").textContent = `${value}%`;
    $("#progress-bar").style.width = `${value}%`;
  };
  request.onload = async () => {
    activeUpload = null;
    progress.hidden = true;
    $("#dropzone").hidden = false;
    if (request.status >= 200 && request.status < 300) {
      const result = JSON.parse(request.responseText);
      const link = new URL(result.url, location.origin).href;
      const shareLink = $("#share-link");
      shareLink.href = link;
      shareLink.textContent = link;
      $("#upload-result").hidden = false;
      toast("完了。共有リンクを表示しました");
      await loadFiles();
    } else {
      let message = "アップロードに失敗しました";
      try {
        message = JSON.parse(request.responseText).error || message;
      } catch { /* response is not JSON */ }
      toast(message);
    }
  };
  request.onerror = () => {
    activeUpload = null;
    toast("通信エラーが発生しました");
  };
  request.onabort = () => {
    activeUpload = null;
    progress.hidden = true;
    $("#dropzone").hidden = false;
  };
  request.send(file);
}

const dropzone = $("#dropzone");
dropzone.onclick = () => $("#file-input").click();
dropzone.onkeydown = (event) => {
  if (event.key === "Enter" || event.key === " ") $("#file-input").click();
};
dropzone.ondragover = (event) => {
  event.preventDefault();
  dropzone.classList.add("active");
};
dropzone.ondragleave = () => dropzone.classList.remove("active");
dropzone.ondrop = (event) => {
  event.preventDefault();
  dropzone.classList.remove("active");
  upload(event.dataTransfer.files[0]);
};
$("#file-input").onchange = (event) => upload(event.target.files[0]);
$("#cancel-upload").onclick = () => activeUpload?.abort();
$("#copy-link").onclick = async () => {
  const link = $("#share-link").href;
  if (await copyText(link)) toast("共有リンクをコピーしました");
  else toast("リンクを長押ししてコピーしてください");
};

try {
  await api("/api/me");
  await enterApp();
} catch {
  show(signupView);
}
