// =============================================================
// 환경 설정 — 배포 시 이 파일만 수정하면 됩니다.
// =============================================================

// GitHub Enterprise Server API base URL.
// 예: "https://github.example.com/api/v3"
// public github 사용 시: "https://api.github.com"
export const API_BASE_URL = "https://api.github.com";

// 관리할 조직명
export const ORG = "dev-billing";

// shared-workflows 레포 (템플릿 파일 + registry 위치)
export const SHARED_WORKFLOWS_REPO = "shared-workflows";

// 관리 페이지에서 표시할 레포 목록 파일 (shared-workflows 레포 내 경로)
export const REPO_LIST_PATH = "docs/repo-list.json";

// =============================================================
// Feature 정의
//   - id: 내부 식별자
//   - label: 화면 표시명
//   - files: 서비스 레포에 복사할 파일 [{ source, target }]
//       source: shared-workflows 레포에서 읽을 경로
//       target: 서비스 레포에 쓸 경로
//   - manualWorkflows: 사용자가 수동으로 트리거할 수 있는 워크플로우 (서비스 레포에서)
// =============================================================
export const FEATURES = [
  {
    id: "claude-code-review",
    label: "Claude Code Review",
    files: [
      {
        source: ".github/workflows/templates/claude-pr-review.yml",
        target: ".github/workflows/claude-pr-review.yml",
      },
    ],
    manualWorkflows: [],
  },
  {
    id: "rest-api-docs",
    label: "REST API Docs",
    files: [
      {
        source: ".github/workflows/templates/api-doc-pr.yml",
        target: ".github/workflows/api-doc-pr.yml",
      },
      {
        // ApiDocs.java 어노테이션 자동 배포 (placeholder 치환)
        source: ".github/workflows/templates/ApiDocs.java.template",
        target: "src/main/java/{PACKAGE_PATH}/apidoc/ApiDocs.java",
        transform: "java-package",
      },
    ],
    manualWorkflows: [
      { file: "api-doc-pr.yml", label: "Publish (manual)" },
    ],
    // 신규 흐름:
    //  - 어노테이션 @ApiDocs: 이 적용 시 target repo 에 자동 배포 (placeholder 치환)
    //  - 문서: target repo 의 docs/*.md (로컬 /api-docs 명령으로 생성·수정)
    //  - 메타: target repo 의 docs/_meta.yml (적용 시 폼으로 입력받아 자동 생성)
    //  - publish: PR merge → docs/*.md → Dooray 페이지 동기화
    extraSetup: "meta-yml",
  },
  {
    id: "ai-context-sync",
    label: "AI Context Sync",
    files: [
      {
        source: ".github/workflows/templates/sync-ai-context.yml",
        target: ".github/workflows/sync-ai-context.yml",
      },
    ],
    manualWorkflows: [
      { file: "sync-ai-context.yml", label: "Sync" },
    ],
  },
];

// 레포 목록 정렬 기준: "updated" | "name" | "created"
export const REPO_SORT = "updated";

// =============================================================
// REST API Docs 워크플로우 dispatch 기본값
// =============================================================
// 워크플로우 YAML 을 읽고 실행할 브랜치 (워크플로우 파일이 항상 존재해야 함)
export const API_DOCS_WORKFLOW_REF = "main";

// Draft 생성 시 컨트롤러 "소스 코드"를 읽을 기본 브랜치
export const API_DOCS_CODE_BRANCH_DEFAULT = "main";

// =============================================================
// AI Context 동기화 (billing-context 레포 기준)
// =============================================================
export const CONTEXT_REPO = "billing-context";
export const CONTEXT_REPOS_JSON_PATH = "repos.json";
export const CONTEXT_STATE_DIR = "state";
export const CONTEXT_AI_DIR = "ai-context";
export const SYNC_WORKFLOW_FILE = "sync-ai-context.yml";
export const SYNC_WORKFLOW_REF = "main";

// ai-context 파일 분류
//   - REQUIRED : 모든 서비스에 항상 생성되어야 하는 필수 파일 (카운트 기준)
//   - OPTIONAL : 조건부 생성 — 서비스 특성에 따라 생성 안 될 수 있음
//                (관리페이지에서 누락인지 해당없음인지 구분 불가하므로 카운트에서 제외)
export const AI_CONTEXT_REQUIRED_FILES = [
  "domain-overview.md",
  "data-model.md",
];

export const AI_CONTEXT_OPTIONAL_FILES = [
  "api-spec.json",            // Controller 있는 경우
  "job-spec.json",            // Spring Batch 있는 경우
  "kafka-spec.json",          // Kafka/RabbitMQ 있는 경우
  "external-integration.md",  // 외부 API/Redis/S3 등 있는 경우
];

// 하위호환: 기존 임포터를 위해 합본도 export
export const AI_CONTEXT_EXPECTED_FILES = [
  ...AI_CONTEXT_REQUIRED_FILES,
  ...AI_CONTEXT_OPTIONAL_FILES,
];
