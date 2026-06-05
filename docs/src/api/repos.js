import { ghFetch } from "./github.js";
import { ORG, REPO_SORT } from "../config.js";

// views/repos.js 가 loadMatrix 직전에 주입하는 런타임 whitelist.
// undefined = 미설정(config 값 사용), null = 필터 없음, array = 필터
let _runtimeWhitelist = undefined;
export function setRuntimeWhitelist(list) { _runtimeWhitelist = list; }

async function fetchAllOrgRepos() {
  const out = [];
  let page = 1;
  while (true) {
    const data = await ghFetch(
      `/orgs/${ORG}/repos?type=all&per_page=100&page=${page}&sort=${REPO_SORT}`
    );
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 100) break;
    page += 1;
    if (page > 20) break;
  }
  return out;
}

// whitelist 필터 적용한 목록
export async function listOrgRepos() {
  const out = await fetchAllOrgRepos();
  if (_runtimeWhitelist) {
    const set = new Set(_runtimeWhitelist);
    return out.filter((r) => set.has(r.name));
  }
  return out;
}

// whitelist 없이 org 전체 목록 (모달용)
export async function listAllOrgRepos() {
  return fetchAllOrgRepos();
}

// 단일 레포의 .github/workflows 디렉토리 listing.
// 호출 1번으로 워크플로우 파일 존재 여부를 모두 확인 가능 (rate limit 절약).
export async function listWorkflowFiles(owner, repo) {
  const data = await ghFetch(
    `/repos/${owner}/${repo}/contents/.github/workflows`,
    { allow404: true }
  );
  if (!data) return new Set();
  if (!Array.isArray(data)) return new Set();
  return new Set(data.filter((f) => f.type === "file").map((f) => f.name));
}

// 파일 한 개의 raw content (base64)
export async function getFileContent(owner, repo, path, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  return await ghFetch(`/repos/${owner}/${repo}/contents/${path}${q}`, {
    allow404: true,
  });
}

// 파일 생성/수정
export async function putFile(owner, repo, path, { contentB64, message, sha, branch }) {
  const body = { message, content: contentB64 };
  if (sha) body.sha = sha;
  if (branch) body.branch = branch;
  return await ghFetch(`/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    body,
  });
}

// 레포 메타 (default_branch 등)
export async function getRepo(owner, repo) {
  return await ghFetch(`/repos/${owner}/${repo}`);
}

// 파일 삭제 (Contents API). sha 필수.
export async function deleteFile(owner, repo, path, { message, sha, branch }) {
  const body = { message, sha };
  if (branch) body.branch = branch;
  return await ghFetch(`/repos/${owner}/${repo}/contents/${path}`, {
    method: "DELETE",
    body,
  });
}
