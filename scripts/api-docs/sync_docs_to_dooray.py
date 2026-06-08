#!/usr/bin/env python3
"""
sync_docs_to_dooray.py

신규 REST API Docs 흐름의 publish 단계.
target repo 의 docs/*.md 파일을 Dooray 위키의 published 페이지로 동기화한다.

이전 flow (Dooray Draft → Published) 와 다르게 source 가 repo 의 md 파일이며,
각 md 의 본문이 그대로 위키 페이지 본문이 된다.

흐름:
1. {target_repo}/docs/*.md 스캔 (_meta.yml 제외)
2. 각 md 의 '## API Info' 표에서 Path/Method 추출 → registry 키 구성
3. 기존 Dooray 페이지가 있으면 update, 없으면 create
4. registry (shared-workflows 의 api-docs-registry.json) 갱신
5. registry 변경분 자동 commit & push

환경 변수:
  DOORAY_API_KEY     Dooray API 토큰
  REPO_NAME          target 서비스 저장소 이름 (org/repo)
  TARGET_REPO_PATH   target repo 체크아웃 경로 (워크플로우에서 주입)
  DOORAY_BASE_URL    (선택) 기본 https://api.dooray.com
  DRY_RUN            (선택) "true" 면 Dooray 호출 없이 미리보기만
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from lib.api_utils import (
    normalize_api_key, now_kst_display, now_kst_iso,
    read_registry, write_registry, set_output, write_summary,
    registry_path_for, registry_rel_for,
    get_repo_page_id, set_repo_page_id,
    parse_domain_table,
)
from lib.dooray import (
    create_page, get_child_pages, update_page, delete_page,
    get_or_create_child_page,
)
from lib.git_utils import git_commit_and_push
from lib.config import (
    DOORAY_WIKI_ID, DOORAY_PROJECT_ID,
    DOORAY_INTERNAL_PARENT_PAGE_ID, DOORAY_EXTERNAL_PARENT_PAGE_ID,
    DOORAY_DEFAULT_PARENT_PAGE_ID,
)


# ── md 파싱 ─────────────────────────────────────────────────────────────────

_API_INFO_BLOCK_RE = re.compile(
    r"^## API Info\s*$([\s\S]*?)(?=^##\s|\Z)",
    re.MULTILINE,
)


def parse_api_info(content: str) -> tuple:
    """md 본문의 '## API Info' 표에서 (method, path) 추출.

    표 형식 (어느 행 순서든 OK):
        | 항목 | 값 |
        | --- | --- |
        | Path | /external/api/... |
        | Method | `GET` |
        | Content-Type | application/json |

    실패 시 (None, None) 반환.
    """
    m = _API_INFO_BLOCK_RE.search(content)
    if not m:
        return None, None
    block = m.group(1)
    path = method = None
    for line in block.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip().strip("`") for c in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        key, val = cells[0], cells[1]
        if key.lower() == "path":
            path = val
        elif key.lower() == "method":
            method = val
    return method, path


_SCOPE_COMMENT_RE = re.compile(r"<!--\s*scope\s*:\s*(external|internal|private)\s*-->", re.IGNORECASE)


def parse_scope_hint(content: str) -> str:
    """md 상단의 <!-- scope: ... --> 주석에서 명시된 scope 추출. 없으면 None."""
    if not content:
        return None
    m = _SCOPE_COMMENT_RE.search(content)
    if m:
        return m.group(1).lower()
    return None


def derive_url_hint(path: str) -> str:
    """URL path 의 segment 로 사외/사내/내부 분류 추론.

    @ApiDocs(scope=...) 가 md 에 명시되어 있지 않을 때만 사용 (fallback).
    """
    if not path:
        return "private"
    p = path.lower()
    if p.startswith(("/api/", "/open/", "/public/", "/external/")):
        return "external"
    if p.startswith(("/internal/", "/admin/", "/inter/", "/system/")):
        return "internal"
    if p.startswith(("/private/", "/batch/", "/actuator/")):
        return "private"
    # `/api/` 경로지만 versioning 인 경우 등 추가 분기
    if re.match(r"^/v\d+(\.\d+)?/", p):
        return "external"
    return "internal"


def scope_parent_page(url_hint: str) -> str:
    """scope (external/internal/private) 의 최상위 부모 페이지 id."""
    if url_hint == "external":
        return DOORAY_EXTERNAL_PARENT_PAGE_ID or DOORAY_DEFAULT_PARENT_PAGE_ID
    if url_hint == "internal":
        return DOORAY_INTERNAL_PARENT_PAGE_ID or DOORAY_DEFAULT_PARENT_PAGE_ID
    return DOORAY_DEFAULT_PARENT_PAGE_ID


# (scope, repo_short) → service-level 부모 page_id 캐시 (1 run 내 재사용)
_SERVICE_PARENT_CACHE = {}


def resolve_service_parent(api_key: str, wiki_id: str, url_hint: str,
                            repo_short: str, base_url: str) -> str:
    """scope 부모 아래에 서비스 이름(repo_short) 페이지를 찾거나 만들고 그 id 를 반환.

    구조:
        사외 (scope parent)
        └─ todo-service     ← 이 페이지를 service-level 부모로 사용
           ├─ Todo 단건 조회
           └─ ...
    """
    scope_parent = scope_parent_page(url_hint)
    cache_key = (url_hint, repo_short)
    if cache_key in _SERVICE_PARENT_CACHE:
        return _SERVICE_PARENT_CACHE[cache_key]
    service_parent = get_or_create_child_page(
        api_key, wiki_id, scope_parent, repo_short, base_url,
    )
    _SERVICE_PARENT_CACHE[cache_key] = service_parent
    return service_parent


def derive_title(content: str, filename: str) -> str:
    """md 의 H1 이 있으면 우선, 없으면 ## Description 의 첫 bullet, 최후엔 파일명."""
    m = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
    if m:
        return m.group(1).strip()
    # ## Description 의 첫 줄 fallback
    m = re.search(r"^##\s+Description\s*\n+\*\s*(.+)$", content, re.MULTILINE)
    if m:
        return m.group(1).strip()[:60]
    return os.path.splitext(os.path.basename(filename))[0]


# ── 메인 흐름 ───────────────────────────────────────────────────────────────

def get_changed_docs_files(repo_name: str, pr_number: str) -> list:
    """gh CLI 로 PR 의 변경 파일 목록을 받아 docs/*.md (excluding _meta.yml) 만 추림.

    삭제된 파일은 별도 list 로 분리 — 현재는 sync 에서 처리 안 함 (warn).
    리턴: (changed_or_added_paths, deleted_paths) 두 리스트 (target_repo 기준 상대 경로)
    """
    import subprocess
    try:
        out = subprocess.check_output(
            ["gh", "pr", "view", pr_number, "--repo", repo_name,
             "--json", "files", "--jq", ".files[] | [.path, .additions, .deletions] | @tsv"],
            text=True,
        )
    except Exception as e:
        print(f"[WARN] PR 변경 파일 조회 실패: {e} — 전체 스캔으로 fallback", file=sys.stderr)
        return None, None
    changed = []
    deleted = []
    for line in out.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        path = parts[0]
        adds = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        dels = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
        if not path.startswith("docs/") or not path.endswith(".md"):
            continue
        if os.path.basename(path).startswith("_"):
            continue
        # 추가/삭제 라인 모두 있고 additions==0 이면 삭제로 간주 (heuristic)
        if adds == 0 and dels > 0:
            deleted.append(path)
        else:
            changed.append(path)
    return changed, deleted


def main():
    dooray_api_key = os.environ.get("DOORAY_API_KEY", "")
    base_url = os.environ.get("DOORAY_BASE_URL", "https://api.dooray.com")
    repo_name = os.environ.get("REPO_NAME", "")
    repo_short = repo_name.split("/")[-1] if repo_name else ""
    target_repo_path = os.environ.get("TARGET_REPO_PATH", "")
    dry_run = os.environ.get("DRY_RUN", "").lower() == "true"
    pr_number = os.environ.get("PR_NUMBER", "")
    full_sync = os.environ.get("FULL_SYNC", "").lower() == "true"
    single_md_path = os.environ.get("SINGLE_MD_PATH", "").strip()
    delete_only = os.environ.get("DELETE_ONLY", "").lower() == "true"

    if not repo_short:
        print("[ERROR] REPO_NAME 환경변수가 없습니다", file=sys.stderr)
        sys.exit(1)
    if not target_repo_path:
        print("[ERROR] TARGET_REPO_PATH 환경변수가 없습니다", file=sys.stderr)
        sys.exit(1)
    if not dooray_api_key and not dry_run:
        print("[ERROR] DOORAY_API_KEY 가 없습니다", file=sys.stderr)
        sys.exit(1)

    # ── DELETE_ONLY 모드 ──────────────────────────────────────────────
    # registry + Dooray 페이지만 삭제. md 파일은 건드리지 않는다 (target repo).
    # 관리 페이지의 행 단위 [🗑 삭제] 버튼이 사용.
    if delete_only:
        if not single_md_path:
            print("[ERROR] DELETE_ONLY=true 인데 SINGLE_MD_PATH 가 비어있습니다", file=sys.stderr)
            sys.exit(1)
        if not single_md_path.startswith("docs/"):
            single_md_path = f"docs/{single_md_path}"
        registry_path = registry_path_for(repo_short)
        registry = read_registry(registry_path)
        # md_path 로 registry 항목 찾기
        target_key = None
        for k, v in registry.items():
            if (v or {}).get("md_path") == single_md_path:
                target_key = k
                break
        if not target_key:
            print(f"[ERROR] registry 에서 md_path={single_md_path} 를 찾지 못했습니다", file=sys.stderr)
            sys.exit(1)
        entry = registry[target_key]
        page_id = entry.get("page_id")
        title = entry.get("title") or single_md_path

        if dry_run:
            print(f"[DRY-RUN] DELETE registry[{target_key}] + Dooray page_id={page_id} ({title})")
        else:
            if page_id:
                try:
                    delete_page(dooray_api_key, DOORAY_WIKI_ID, page_id, base_url)
                    print(f"[INFO] DELETE Dooray page_id={page_id}")
                except Exception as e:
                    print(f"[WARN] Dooray 페이지 삭제 실패 (이미 삭제되었을 수 있음): {e}", file=sys.stderr)
            del registry[target_key]
            write_registry(registry_path, registry)
            git_commit_and_push(
                "shared-config",
                [registry_rel_for(repo_short)],
                f"chore: delete api doc registry entry - {repo_short} {target_key} [skip ci]",
            )

        write_summary([
            f"# REST API Docs DELETE — {repo_short}",
            "",
            f"- md_path: {single_md_path}",
            f"- api_key: {target_key}",
            f"- page_id: {page_id}",
            f"- title: {title}",
            f"- dry_run: {dry_run}",
            f"- 처리 시각: {now_kst_display()}",
            "",
            "> md 파일은 그대로 유지되며, 다음 full_sync 또는 PR 머지 때 다시 생성될 수 있습니다.",
            "> 영구 삭제를 원하면 PR 로 docs/*.md 도 함께 제거하세요.",
        ])
        return

    docs_dir = os.path.join(target_repo_path, "docs")
    if not os.path.isdir(docs_dir):
        print(f"[INFO] {docs_dir} 디렉토리 없음 — 처리할 md 가 없습니다")
        return

    # 변경된 docs/*.md 만 처리할지, 단일 파일만 처리할지, 전체 처리할지 결정
    md_files = None
    deleted_files = []
    if single_md_path:
        # 정규화 — "docs/foo.md" 또는 "foo.md" 둘 다 허용
        if not single_md_path.startswith("docs/"):
            single_md_path = f"docs/{single_md_path}"
        full = os.path.join(target_repo_path, single_md_path)
        if not os.path.isfile(full):
            print(f"[ERROR] {single_md_path} 파일이 target repo 에 없습니다", file=sys.stderr)
            sys.exit(1)
        md_files = [full]
        print(f"[INFO] 단일 파일 모드: {single_md_path}")
    elif pr_number and not full_sync:
        changed_paths, deleted_paths = get_changed_docs_files(repo_name, pr_number)
        if changed_paths is not None:
            md_files = [os.path.join(target_repo_path, p) for p in changed_paths]
            deleted_files = deleted_paths or []
            print(f"[INFO] PR #{pr_number} 의 변경된 docs/*.md: {len(md_files)}개, 삭제: {len(deleted_files)}개")
            if deleted_files:
                print(f"[WARN] 삭제된 md 가 있지만 자동 Dooray 페이지 처리는 아직 미지원: {deleted_files}", file=sys.stderr)

    if md_files is None:
        # fallback — 전체 스캔
        md_files = sorted(
            os.path.join(docs_dir, f) for f in os.listdir(docs_dir)
            if f.endswith(".md") and not f.startswith("_")
        )
        print(f"[INFO] 전체 스캔 모드: {len(md_files)}개")

    if not md_files:
        print("[INFO] 처리할 docs/*.md 파일이 없습니다")
        return

    registry_path = registry_path_for(repo_short)
    registry = read_registry(registry_path)

    created = []
    updated = []
    skipped = []
    errors = []

    for md_path in md_files:
        try:
            with open(md_path, "r", encoding="utf-8") as f:
                content = f.read()

            method, path = parse_api_info(content)
            if not method or not path:
                skipped.append((md_path, "API Info 표에서 Method/Path 추출 실패"))
                continue

            api_key = normalize_api_key(method, path)
            # scope 우선순위: md 의 <!-- scope: ... --> 주석 (사용자 명시) → URL prefix 추론
            url_hint = parse_scope_hint(content) or derive_url_hint(path)
            title = derive_title(content, md_path)
            # 구조: scope 부모 → 서비스명(repo_short) → API 페이지
            if dry_run:
                parent_id = f"<service:{url_hint}/{repo_short}>"
            else:
                parent_id = resolve_service_parent(
                    dooray_api_key, DOORAY_WIKI_ID, url_hint, repo_short, base_url,
                )

            # 기존 등록된 페이지가 있나?
            entry = registry.get(api_key) or {}
            page_id = entry.get("page_id")

            # 본문에 H1 이 없으면 자동 주입 (Dooray 페이지 제목과 별개로 본문 상단 시각화)
            body = content
            scope_label = {"external": "사외", "internal": "사내", "private": "내부"}.get(url_hint, "내부")
            if not re.match(r"^#\s+", content):
                body = f"# [{scope_label}] {title}\n\n{content}"

            if dry_run:
                action = "UPDATE" if page_id else "CREATE"
                print(f"[DRY-RUN] {action} {api_key} → parent={parent_id} title={title!r}")
                if page_id:
                    updated.append((api_key, page_id, title))
                else:
                    created.append((api_key, None, title))
                continue

            full_title = f"[{scope_label}] {title}"
            if page_id:
                update_page(dooray_api_key, DOORAY_WIKI_ID, page_id, full_title, body, base_url)
                print(f"[INFO] UPDATE {api_key} (page_id={page_id})")
                updated.append((api_key, page_id, title))
            else:
                new_id = create_page(
                    dooray_api_key, DOORAY_WIKI_ID, parent_id, full_title, body, base_url,
                )
                print(f"[INFO] CREATE {api_key} → page_id={new_id}")
                created.append((api_key, new_id, title))
                page_id = new_id

            registry[api_key] = {
                **entry,
                "status": "published",
                "title": title,
                "url_hint": url_hint,
                "page_id": page_id,
                "md_path": os.path.relpath(md_path, target_repo_path),
                "last_synced_at": now_kst_iso(),
                "updated_at": now_kst_iso(),
            }
        except Exception as e:
            errors.append((md_path, str(e)))
            print(f"[ERROR] {md_path}: {e}", file=sys.stderr)

    if not dry_run:
        write_registry(registry_path, registry)
        # registry 파일은 shared-workflows checkout 디렉토리("shared-config") 안에 있음.
        # git_commit_and_push 는 (repo_dir, files[리포 상대 경로], message) 시그니처.
        git_commit_and_push(
            "shared-config",
            [registry_rel_for(repo_short)],
            f"chore: sync api docs to dooray - {repo_short} [skip ci]",
        )

    # 요약
    summary = [
        f"# REST API Docs sync — {repo_short}",
        "",
        f"- 생성: {len(created)}",
        f"- 갱신: {len(updated)}",
        f"- 스킵: {len(skipped)}",
        f"- 오류: {len(errors)}",
        f"- 처리 시각: {now_kst_display()}",
    ]
    if created:
        summary.append("\n## 생성된 페이지")
        for api_key, page_id, title in created:
            summary.append(f"- {api_key} → {page_id} ({title})")
    if updated:
        summary.append("\n## 갱신된 페이지")
        for api_key, page_id, title in updated:
            summary.append(f"- {api_key} → {page_id} ({title})")
    if skipped:
        summary.append("\n## 스킵")
        for md, reason in skipped:
            summary.append(f"- {md}: {reason}")
    if errors:
        summary.append("\n## 오류")
        for md, msg in errors:
            summary.append(f"- {md}: {msg}")
    write_summary(summary)


if __name__ == "__main__":
    main()
