import { loadAuth, getState, subscribe, clearAuth } from "./state.js";
import { renderLogin } from "./views/login.js";
import { renderRepos } from "./views/repos.js";
import { renderOverview } from "./views/overview.js";
import { renderDeploy } from "./views/deploy.js";
import { renderNavSidebar } from "./views/nav-sidebar.js";
import { mount, h } from "./utils/dom.js";

const root = document.getElementById("app");
const userInfo = document.getElementById("user-info");
const rateInfo = document.getElementById("rate-limit");
const logoutBtn = document.getElementById("logout-btn");
const navSidebar = document.getElementById("nav-sidebar");

logoutBtn.addEventListener("click", () => {
  clearAuth();
  location.hash = "#/login";
});

subscribe((state) => {
  if (state.user) {
    userInfo.textContent = `@${state.user.login}`;
    logoutBtn.style.display = "";
    navSidebar.style.display = "";
  } else {
    userInfo.textContent = "";
    logoutBtn.style.display = "none";
    navSidebar.style.display = "none";
  }
  if (state.rateLimit) {
    rateInfo.textContent = `API ${state.rateLimit.remaining}/${state.rateLimit.limit}`;
  }
});

async function navigate() {
  const hash = location.hash || "#/login";
  const { pat } = getState();

  if (!pat) {
    if (hash !== "#/login") {
      location.hash = "#/login";
      return;
    }
    renderLogin(root);
    return;
  }

  if (hash === "#/login") {
    location.hash = "#/repos";
    return;
  }

  renderNavSidebar(navSidebar, hash);

  // 레포 관리 (default landing)
  if (hash === "#/repos") return renderRepos(root);
  const repoMatch = hash.match(/^#\/repos\/([^/]+)$/);
  if (repoMatch) return renderRepos(root, decodeURIComponent(repoMatch[1]));

  // (구) 적용 현황 — 사이드바에서 빠졌지만 URL 직접 입력 시는 동작 유지
  if (hash === "#/overview") return renderOverview(root);

  // (구) 기능 배포 — 사이드바에서 빠졌지만 URL 직접 입력 시는 동작 유지
  if (hash === "#/deploy") return renderDeploy(root);
  const deployMatch = hash.match(/^#\/deploy\/([^/]+)$/);
  if (deployMatch) return renderDeploy(root, decodeURIComponent(deployMatch[1]));

  // REST API Docs > 도메인 관리
  if (hash === "#/domains" || hash.startsWith("#/domains/")) {
    const { renderDomains } = await import("./views/domains.js");
    const m = hash.match(/^#\/domains\/([^/]+)$/);
    return renderDomains(root, m ? decodeURIComponent(m[1]) : null);
  }

  // REST API Docs > Docs 관리 (picker)
  if (hash === "#/api-docs") {
    const { renderApiDocsPicker } = await import("./views/api-docs-picker.js");
    return renderApiDocsPicker(root);
  }
  const apiDocsMatch = hash.match(/^#\/api-docs\/([^/]+)$/);
  if (apiDocsMatch) {
    const { renderApiDocs } = await import("./views/api-docs.js");
    return renderApiDocs(root, decodeURIComponent(apiDocsMatch[1]));
  }

  // MCP > AI Context
  if (hash === "#/ai-context") {
    const { renderAiContext } = await import("./views/ai-context.js");
    return renderAiContext(root);
  }

  // 디테일 화면
  const runsMatch = hash.match(/^#\/runs\/([^/]+)$/);
  if (runsMatch) {
    const { renderRuns } = await import("./views/runs.js");
    return renderRuns(root, decodeURIComponent(runsMatch[1]));
  }

  // 기본 (또는 구 라우트)
  if (hash === "#/matrix" || hash === "#/") {
    location.hash = "#/repos";
    return;
  }

  mount(root, h("div", { class: "card empty" }, `알 수 없는 경로: ${hash}`));
}

window.addEventListener("hashchange", navigate);
window.addEventListener("DOMContentLoaded", () => {
  loadAuth();
  navigate();
});
if (document.readyState !== "loading") {
  loadAuth();
  navigate();
}
