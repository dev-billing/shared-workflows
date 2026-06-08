// target repo 의 docs/_meta.yml 직접 읽기·쓰기.
//
// 스키마:
//   environments:
//     alpha: https://...
//     real: https://...
//   useGateway: true|false
//   gateway:
//     - internalPrefix: /external
//       externalPrefix: /pay
//   groups:
//     - packagePrefix: com.x.y
//       environments:
//         alpha: https://...
//
// YAML 라이브러리 의존 없이 위 한정된 스키마만 다루는 미니 직렬화/역직렬화.

import { getFileContent, putFile } from "./repos.js";
import { ORG } from "../config.js";
import { decodeB64, encodeB64 } from "../utils/b64.js";

const PATH = "docs/_meta.yml";

// repo 별 인메모리 TTL 캐시
const TTL_MS = 30_000;
const _cache = new Map(); // repoName -> { meta, sha, ts }
const _inflight = new Map(); // repoName -> Promise

export function invalidateMetaCache(repoName) {
  if (repoName) {
    _cache.delete(repoName);
    _inflight.delete(repoName);
  } else {
    _cache.clear();
    _inflight.clear();
  }
}

// ── YAML 직렬화 (지정 스키마만) ──────────────────────────────────────────

function indent(level) {
  return "  ".repeat(level);
}

function escapeString(s) {
  if (s == null) return '""';
  const str = String(s);
  // 따옴표 없이도 안전한지 체크: 알파벳·숫자·-·_·:·/·.·공백·한글 정도면 OK
  if (/^[A-Za-z0-9가-힣\-_.:/]+$/.test(str) || /^[A-Za-z0-9가-힣\-_.:/ ]+$/.test(str)) {
    return str;
  }
  return '"' + str.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function serializeMeta(meta) {
  const out = [];
  if (meta.environments && Object.keys(meta.environments).length) {
    out.push("environments:");
    for (const [k, v] of Object.entries(meta.environments)) {
      out.push(`  ${k}: ${escapeString(v)}`);
    }
  }
  if (meta.useGateway !== undefined) {
    out.push(`useGateway: ${meta.useGateway ? "true" : "false"}`);
  }
  if (meta.gateway && meta.gateway.length) {
    out.push("gateway:");
    for (const g of meta.gateway) {
      out.push(`  - internalPrefix: ${escapeString(g.internalPrefix || "")}`);
      out.push(`    externalPrefix: ${escapeString(g.externalPrefix || "")}`);
      if (g.name) out.push(`    name: ${escapeString(g.name)}`);
    }
  }
  if (meta.groups && meta.groups.length) {
    out.push("groups:");
    for (const g of meta.groups) {
      const firstKey = g.packagePrefix ? "packagePrefix" : "internalUrlPrefix";
      const firstVal = g.packagePrefix || g.internalUrlPrefix || "";
      out.push(`  - ${firstKey}: ${escapeString(firstVal)}`);
      if (g.packagePrefix && g.internalUrlPrefix) {
        out.push(`    internalUrlPrefix: ${escapeString(g.internalUrlPrefix)}`);
      }
      if (g.externalUrlPrefix) {
        out.push(`    externalUrlPrefix: ${escapeString(g.externalUrlPrefix)}`);
      }
      if (g.name) out.push(`    name: ${escapeString(g.name)}`);
      if (g.environments && Object.keys(g.environments).length) {
        out.push("    environments:");
        for (const [k, v] of Object.entries(g.environments)) {
          out.push(`      ${k}: ${escapeString(v)}`);
        }
      }
    }
  }
  return out.join("\n") + "\n";
}

// ── YAML 역직렬화 (지정 스키마만, 한정 파서) ───────────────────────────

function unquote(s) {
  if (!s) return "";
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

function parseMeta(text) {
  const meta = { environments: {}, useGateway: false, gateway: [], groups: [] };
  if (!text) return meta;
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const stripped = raw.replace(/\s+$/, "");
    if (!stripped.trim() || stripped.trim().startsWith("#")) {
      i++; continue;
    }
    // 최상위 키 (들여쓰기 없는 라인)
    if (!stripped.startsWith(" ")) {
      const m = stripped.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1];
      const valInline = m[2];
      if (key === "useGateway") {
        meta.useGateway = /^true$/i.test(valInline.trim());
        i++; continue;
      }
      if (key === "environments") {
        i++;
        // 2-space 들여쓰기 라인을 모두 환경 항목으로 읽고, 들여쓰기 없는 라인이 나오면 종료
        while (i < lines.length) {
          const ln = lines[i];
          if (ln.trim() === "") { i++; continue; }
          if (!ln.startsWith("  ") || ln.startsWith("- ") || ln.startsWith("    ")) break;
          const im = ln.trim().match(/^([A-Za-z][\w]*)\s*:\s*(.*)$/);
          if (im) meta.environments[im[1]] = unquote(im[2]);
          i++;
        }
        continue;
      }
      if (key === "gateway") {
        i++;
        while (i < lines.length && lines[i].startsWith("  ")) {
          if (lines[i].trim() === "") { i++; continue; }
          if (lines[i].startsWith("  - ")) {
            const item = {};
            // 첫 줄
            const firstLine = lines[i].replace(/^\s*-\s*/, "").trim();
            const fm = firstLine.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
            if (fm) item[fm[1]] = unquote(fm[2]);
            i++;
            // 이어지는 4-space 들여쓰기 줄
            while (i < lines.length && lines[i].startsWith("    ") && !lines[i].startsWith("    - ")) {
              const ln = lines[i].trim();
              if (!ln) { i++; continue; }
              const cm = ln.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
              if (cm) item[cm[1]] = unquote(cm[2]);
              i++;
            }
            meta.gateway.push(item);
          } else {
            break;
          }
        }
        continue;
      }
      if (key === "groups") {
        i++;
        while (i < lines.length && lines[i].startsWith("  ")) {
          if (lines[i].trim() === "") { i++; continue; }
          if (lines[i].startsWith("  - ")) {
            const item = { environments: {} };
            const firstLine = lines[i].replace(/^\s*-\s*/, "").trim();
            const fm = firstLine.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
            if (fm) item[fm[1]] = unquote(fm[2]);
            i++;
            while (i < lines.length && lines[i].startsWith("    ") && !lines[i].startsWith("    - ")) {
              const ln = lines[i];
              const trimmed = ln.trim();
              if (!trimmed) { i++; continue; }
              // environments: 블록 진입 (다음 줄들이 6-space)
              if (/^environments\s*:\s*$/.test(trimmed)) {
                i++;
                while (i < lines.length && lines[i].startsWith("      ")) {
                  const em = lines[i].trim().match(/^([A-Za-z][\w]*)\s*:\s*(.*)$/);
                  if (em) item.environments[em[1]] = unquote(em[2]);
                  i++;
                }
                continue;
              }
              const cm = trimmed.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
              if (cm) item[cm[1]] = unquote(cm[2]);
              i++;
            }
            meta.groups.push(item);
          } else {
            break;
          }
        }
        continue;
      }
      i++;
    } else {
      i++;
    }
  }
  return meta;
}

// ── 외부 인터페이스 ──────────────────────────────────────────────────

// repo 의 docs/_meta.yml 을 읽어 { meta, sha, exists } 반환.
// 파일이 없으면 exists=false, meta 는 기본값.
export async function readMeta(repoName) {
  const cached = _cache.get(repoName);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    return { meta: cached.meta, sha: cached.sha, exists: cached.exists };
  }
  if (_inflight.has(repoName)) return _inflight.get(repoName);

  const promise = (async () => {
    try {
      const data = await getFileContent(ORG, repoName, PATH);
      if (!data || !data.content) {
        const empty = { environments: {}, useGateway: false, gateway: [], groups: [] };
        _cache.set(repoName, { meta: empty, sha: null, exists: false, ts: Date.now() });
        return { meta: empty, sha: null, exists: false };
      }
      const text = decodeB64(data.content);
      const meta = parseMeta(text);
      _cache.set(repoName, { meta, sha: data.sha, exists: true, ts: Date.now() });
      return { meta, sha: data.sha, exists: true };
    } catch (e) {
      // 404 등 — 미적용으로 간주
      const empty = { environments: {}, useGateway: false, gateway: [], groups: [] };
      _cache.set(repoName, { meta: empty, sha: null, exists: false, ts: Date.now() });
      return { meta: empty, sha: null, exists: false };
    } finally {
      _inflight.delete(repoName);
    }
  })();
  _inflight.set(repoName, promise);
  return promise;
}

// repo 의 docs/_meta.yml 을 갱신·생성.
export async function writeMeta(repoName, meta, { branch, message } = {}) {
  const existing = await readMeta(repoName);
  const content = serializeMeta(meta);
  await putFile(ORG, repoName, PATH, {
    contentB64: encodeB64(content),
    message: message || `chore: update docs/_meta.yml for ${repoName}`,
    sha: existing.sha || undefined,
    branch,
  });
  _cache.set(repoName, {
    meta,
    sha: existing.sha,  // 다음 read 가 refetch 하여 새 sha 받음
    exists: true,
    ts: 0,  // 즉시 무효화
  });
}

// 위 unit 함수 외에 직접 serialize/parse 필요할 때.
export { parseMeta, serializeMeta };

// Spring Cloud Gateway 라우트 YML 한 블록을 파싱해 group 후보 dict 반환.
// 입력 예:
//   - id: pay-api
//     uri: lb://bill-pay-api
//     predicates:
//       - Path=/pay/**
//     filters:
//       - RewritePath=/pay/(?<segment>/?.*), /external/${segment}
// 결과: { name, externalUrlPrefix, internalUrlPrefix }
export function parseGatewayYml(text) {
  if (!text) return null;
  const result = { name: "", externalUrlPrefix: "", internalUrlPrefix: "" };

  const idMatch = text.match(/(?:^|\n)\s*-?\s*id:\s*([\w.-]+)/);
  if (idMatch) result.name = idMatch[1].trim();

  const pathMatch = text.match(/Path\s*=\s*([^\s,'"\]]+)/);
  if (pathMatch) {
    result.externalUrlPrefix = pathMatch[1].replace(/\/\*+$/, "").replace(/\*+$/, "").replace(/\/+$/, "");
  }

  const rewriteMatch = text.match(/RewritePath\s*=\s*[^,]+,\s*([^\s'"\]]+)/);
  if (rewriteMatch) {
    let dest = rewriteMatch[1];
    dest = dest.replace(/\$\{[^}]+\}/g, "");
    dest = dest.replace(/\/$/, "");
    result.internalUrlPrefix = dest;
  }

  if (!result.externalUrlPrefix && !result.internalUrlPrefix) return null;
  return result;
}
