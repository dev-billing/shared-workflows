import { listOrgRepos, listWorkflowFiles, setRuntimeWhitelist } from "./repos.js";
import { pLimitMap } from "./github.js";
import { readRepoList, invalidateRepoListCache } from "./repo-list.js";
import { FEATURES } from "../config.js";
import { getState, setState } from "../state.js";

const CACHE_TTL_MS = 60_000;

// 한 레포의 워크플로우 파일 set으로부터 feature 상태 계산
// returns { [featureId]: "applied" | "partial" | "missing" }
//
// .github/workflows/ 안의 파일만 검사 대상으로 본다 — 워크플로우 외의 파일
// (예: ApiDocs.java, _meta.yml) 은 적용 시 워크플로우와 함께 배포되므로
// 워크플로우 존재 = feature 적용으로 간주.
export function computeStatus(workflowFiles) {
  const status = {};
  for (const feat of FEATURES) {
    const wfTargets = feat.files
      .filter((f) => f.target.startsWith(".github/workflows/"))
      .map((f) => f.target.split("/").pop());
    if (wfTargets.length === 0) {
      // 워크플로우 파일이 정의되지 않은 feature → 검사할 게 없음 → 항상 missing 으로 안전 처리
      status[feat.id] = "missing";
      continue;
    }
    const present = wfTargets.filter((n) => workflowFiles.has(n)).length;
    if (present === 0) status[feat.id] = "missing";
    else if (present === wfTargets.length) status[feat.id] = "applied";
    else status[feat.id] = "partial";
  }
  return status;
}

// 전체 매트릭스 로딩 (캐시 사용)
//   force=true 면 캐시 무시하고 새로 조회
//
// 호출 시 항상 docs/repo-list.json 을 읽어 런타임 whitelist 갱신 → 어떤 뷰에서
// 부르든 동일한 repo-list 기준의 결과가 보장된다.
export async function loadMatrix(force = false) {
  const cache = getState().matrixCache;
  if (!force && cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.rows;
  }
  // force=true 일 때는 repo-list 캐시도 같이 비워서 진짜 fresh 한 결과를 보장
  if (force) invalidateRepoListCache();
  try {
    const r = await readRepoList();
    setRuntimeWhitelist(r.list);
  } catch {
    // 실패 시 whitelist 미설정 상태 유지 (기존 동작)
  }
  const repos = await listOrgRepos();
  const wfSets = await pLimitMap(repos, 6, (r) =>
    listWorkflowFiles(r.owner.login, r.name).catch(() => new Set())
  );
  const rows = repos.map((repo, i) => ({
    repo,
    workflowFiles: wfSets[i],
    status: computeStatus(wfSets[i]),
  }));
  setState({ matrixCache: { ts: Date.now(), rows } });
  return rows;
}

// 적용 통계: { [featureId]: { applied: [...], partial: [...], missing: [...] } }
export function summarizeByFeature(rows) {
  const summary = {};
  for (const feat of FEATURES) {
    summary[feat.id] = { applied: [], partial: [], missing: [] };
  }
  for (const row of rows) {
    for (const feat of FEATURES) {
      summary[feat.id][row.status[feat.id]].push(row.repo);
    }
  }
  return summary;
}

// 한 레포의 적용 요약: "2/3" 같은 문자열
export function appliedCount(row) {
  let n = 0;
  for (const feat of FEATURES) {
    if (row.status[feat.id] === "applied") n++;
  }
  return { applied: n, total: FEATURES.length };
}
