#!/usr/bin/env python3
"""
billing-context AI Context 동기화 스크립트.
각 서비스 레포의 변경을 감지하고 Claude로 ai-context를 생성/업데이트한다.
Claude는 JSON으로 파일 내용을 출력하고, 이 스크립트가 직접 파일을 저장한다.
"""

import os
import re
import sys
import json
import subprocess
from pathlib import Path


def run_claude(prompt: str, timeout: int = 1200) -> tuple[int, str]:
    """Claude -p로 프롬프트를 실행하고 (종료코드, stdout) 반환."""
    result = subprocess.run(
        ["claude", "-p", "--dangerously-skip-permissions", prompt],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        print(f"    stderr: {result.stderr.strip()[:500]}")
    return result.returncode, result.stdout


def write_context_files(output: str, context_dir: Path) -> tuple[list[str], bool]:
    """Claude 출력(JSON)을 파싱해서 파일로 저장.
    반환: (저장된 파일 목록, 파싱 성공 여부).
    빈 배열([])이 정상적으로 파싱되면 ([], True) — "변경 없음".
    파싱 자체가 실패하면 ([], False) — 에러로 취급해야 함.
    """
    try:
        json_match = re.search(r'\[.*\]', output, re.DOTALL)
        raw = json_match.group() if json_match else output.strip()
        files_data = json.loads(raw)

        context_dir.mkdir(parents=True, exist_ok=True)
        written = []
        for item in files_data:
            file_path = context_dir / item["file"]
            file_path.write_text(item["content"], encoding="utf-8")
            written.append(item["file"])
        return written, True
    except (json.JSONDecodeError, KeyError) as e:
        print(f"    JSON 파싱 실패: {e}")
        print(f"    출력 앞부분:\n{output[:500]}")
        return [], False


OUTPUT_FORMAT = """
반드시 아래 JSON 배열 형식으로만 출력해. JSON 외 다른 텍스트는 절대 포함하지 마.
[
  {"file": "파일명.md", "content": "파일 전체 내용"},
  {"file": "파일명.json", "content": "파일 전체 내용"}
]
"""

GENERATE_INSTRUCTIONS = """
소스코드를 분석해서 아래 파일들을 생성해. 해당 유형이 아니면 생략해도 돼:
- domain-overview.md : 서비스 역할, 기술스택, 아키텍처 패턴, 패키지 구조, 핵심 비즈니스 규칙
- data-model.md      : 엔티티 관계, 필드 정의, Enum
- api-spec.json      : REST API 엔드포인트 명세 (Controller 있는 경우)
- job-spec.json      : Batch Job 명세 (Spring Batch 있는 경우)
- kafka-spec.json    : Kafka/RabbitMQ 발행/구독 명세 (메시지 브로커 있는 경우)
- external-integration.md : 외부 API 호출, FeignClient, Redis/S3 등 인프라 연동
"""

UPDATE_INSTRUCTIONS = """
기존 ai-context와 변경된 파일을 비교해서, 변경이 필요한 파일만 업데이트해.
변경 없는 파일은 포함하지 마.
"""


def get_latest_sha(full_repo: str, branch: str) -> str:
    gh_host = os.environ.get("GITHUB_SERVER_URL", "").replace("https://", "").strip("/") or "github.com"
    result = subprocess.run(
        ["gh", "api", f"repos/{full_repo}/commits/{branch}", "--jq", ".sha"],
        capture_output=True,
        text=True,
        env={**os.environ, "GH_HOST": gh_host},
    )
    if result.returncode != 0:
        print(f"    gh api 실패 (rc={result.returncode}): {result.stderr.strip()}")
    return result.stdout.strip() if result.returncode == 0 else ""


def clone_repo(full_repo: str, branch: str, target_dir: str) -> bool:
    gh_token = os.environ.get("GH_TOKEN", "")
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/").replace("https://", "")
    url = f"https://x-access-token:{gh_token}@{server}/{full_repo}.git"
    result = subprocess.run(
        ["git", "clone", "--depth=5", f"--branch={branch}", url, target_dir],
    )
    return result.returncode == 0


def get_changed_files(source_dir: str) -> str:
    result = subprocess.run(
        ["git", "-C", source_dir, "diff", "HEAD~1", "--name-only"],
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def sync_repo(repo_name: str, org: str, branch: str, force: bool) -> bool:
    full_repo = f"{org}/{repo_name}"

    latest_sha = get_latest_sha(full_repo, branch)
    if not latest_sha:
        print(f"  ⚠️  {repo_name}: SHA 조회 실패 — 스킵")
        return False

    state_file = Path(f"state/{repo_name}.sha")
    stored_sha = state_file.read_text().strip() if state_file.exists() else ""

    if latest_sha == stored_sha and not force:
        print(f"  ↩️  변경 없음 — 스킵")
        return False

    short_old = stored_sha[:7] if stored_sha else "없음"
    short_new = latest_sha[:7]
    print(f"  🔄 변경 감지 ({short_old}... → {short_new}...)")

    source_dir = f"_source/{repo_name}"
    subprocess.run(["rm", "-rf", source_dir])
    if not clone_repo(full_repo, branch, source_dir):
        print(f"  ❌ {repo_name}: 클론 실패 — 스킵")
        return False

    context_dir = Path(f"{repo_name}/ai-context")
    context_exists = context_dir.exists() and any(context_dir.iterdir())

    # 전체 재생성 조건:
    #   - force=true (사용자 명시)
    #   - ai-context 디렉토리 없음 (최초 생성)
    #   - state SHA 파일 없음 (이전 동기화 이력 자체가 없음 → 부분 diff 기준점이 없음)
    full_regen = force or not context_exists or not stored_sha
    if full_regen:
        reason = "force" if force else ("context 없음" if not context_exists else "SHA 파일 없음")
        print(f"  🆕 전체 생성 실행 ({reason})")
        prompt = f"""{GENERATE_INSTRUCTIONS}

소스코드: {source_dir}/

{OUTPUT_FORMAT}"""
    else:
        print(f"  📝 부분 업데이트 실행")
        changed_files = get_changed_files(source_dir)
        prompt = f"""{UPDATE_INSTRUCTIONS}

소스코드: {source_dir}/
기존 ai-context: {context_dir}/
변경된 파일:
{changed_files}

{OUTPUT_FORMAT}"""

    rc, output = run_claude(prompt)
    if rc != 0:
        print(f"  ❌ Claude 실행 실패 (종료 코드: {rc}) — SHA 저장 안 함")
        return False

    written, parse_ok = write_context_files(output, context_dir)
    if not parse_ok:
        print(f"  ❌ JSON 파싱 실패 — SHA 저장 안 함")
        return False

    # 파싱은 성공했고 written이 비어있으면 "변경 없음" — SHA만 갱신해서 다음 sync에 재실행되지 않도록.
    state_file.parent.mkdir(exist_ok=True)
    state_file.write_text(latest_sha)

    if written:
        print(f"  📄 저장된 파일: {', '.join(written)}")
        print(f"  ✅ {repo_name} 완료 — 파일 갱신")
        return True
    else:
        print(f"  ℹ️  변경 필요 없음 — SHA만 {short_new}로 갱신")
        return False


def update_root_context(repos: list[dict]) -> None:
    print("\n🌐 루트 ai-context 갱신 중...")

    service_contexts = []
    for repo in repos:
        name = repo["name"]
        context_dir = Path(f"{name}/ai-context")
        if context_dir.exists():
            files = list(context_dir.glob("*"))
            if files:
                service_contexts.append(f"- {name}/ai-context/ : {', '.join(f.name for f in files)}")

    if not service_contexts:
        print("  ⚠️  서비스 ai-context 없음 — 루트 갱신 스킵")
        return

    services_list = "\n".join(service_contexts)
    prompt = f"""아래 서비스들의 ai-context를 읽어서 루트 ai-context 파일들을 생성해.

서비스 목록:
{services_list}

생성할 파일:
- service-map.md         : 전체 서비스 목록, 역할, ai-context 경로
- dependency-graph.md    : 서비스 간 호출/이벤트 의존관계
- interface-contracts.json : 서비스 간 공유 API·이벤트 인터페이스
- routing-guide.md       : 업무 유형별 → 관련 서비스 매핑 가이드

{OUTPUT_FORMAT}"""

    rc, output = run_claude(prompt)
    if rc != 0:
        print(f"  ❌ 루트 context Claude 실패")
        return

    written, parse_ok = write_context_files(output, Path(".claude/ai-context"))
    if not parse_ok:
        print("  ❌ 루트 context JSON 파싱 실패")
        return
    if written:
        print(f"  📄 루트 저장: {', '.join(written)}")
    else:
        print("  ℹ️  루트 context 변경 필요 없음")
    print("  ✅ 루트 ai-context 완료")


def main():
    with open("repos.json") as f:
        config = json.load(f)

    org = config["org"]
    target_repo = os.environ.get("INPUT_REPO", "").strip()
    force = os.environ.get("INPUT_FORCE", "false").lower() == "true"

    repos = config["repos"]
    if target_repo:
        repos = [r for r in repos if r["name"] == target_repo]

    if not repos:
        print("❌ 처리할 레포가 없습니다 (repos.json 확인 또는 repo-name 입력값 확인)")
        sys.exit(1)

    changed_count = 0
    for repo in repos:
        name = repo["name"]
        branch = repo.get("branch", "develop")
        print(f"\n════════════════════════════════════")
        print(f"🔍 {name} 확인 중...")

        if sync_repo(name, org, branch, force):
            changed_count += 1

    if changed_count > 0:
        update_root_context(config["repos"])

    github_output = os.environ.get("GITHUB_OUTPUT", "")
    if github_output:
        with open(github_output, "a") as f:
            f.write(f"changed_count={changed_count}\n")

    print(f"\n✅ 완료 — 업데이트된 레포: {changed_count}개")


if __name__ == "__main__":
    main()
