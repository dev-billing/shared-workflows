import { h, mount } from "../utils/dom.js";
import { readRegistry, entriesOf, parseApiKey } from "../api/registry.js";
import { dispatchWorkflow } from "../api/workflows.js";
import {
  ORG,
  API_DOCS_WORKFLOW_REF,
  DOORAY_WEB_BASE,
  DOORAY_WIKI_ID,
} from "../config.js";
import { toast } from "../utils/toast.js";

// repo 별 API Docs 상세 화면. 신규 흐름에서는:
//  - Draft 개념 없음 → Draft 목록·생성·삭제 제거
//  - Published 페이지만 표시
//  - Dooray 페이지 / GitHub md 직접 링크
//  - 수동 재동기화 1 버튼 (workflow_dispatch full_sync)

export async function renderApiDocs(root, repoName) {
  mount(
    root,
    h(
      "div",
      { class: "card" },
      h("a", { class: "back-link", href: "#/overview" }, "← 적용 현황"),
      h("h2", { class: "card__title" }, `${repoName} — API Docs`),
      h("p", { class: "card__desc" }, h("span", { class: "spinner" }), " 데이터 로딩 중...")
    )
  );

  let registry = {};
  try {
    registry = await readRegistry(repoName);
  } catch (err) {
    toast(`로드 실패: ${err.message}`, "error", 5000);
  }

  const published = entriesOf(registry).filter(([, v]) => v && v.status === "published");

  // 수동 재동기화 버튼 (workflow_dispatch full_sync=true)
  const syncBtn = h(
    "button",
    {
      class: "btn",
      onclick: async () => {
        if (!confirm(`${repoName} 의 docs/*.md 전체를 Dooray 와 다시 동기화할까요?`)) return;
        syncBtn.disabled = true;
        syncBtn.textContent = "트리거 중...";
        try {
          await dispatchWorkflow(repoName, "api-doc-pr.yml", API_DOCS_WORKFLOW_REF, {
            dry_run: false,
            full_sync: true,
          });
          toast("재동기화 트리거 완료. Actions 페이지에서 진행 상황 확인", "success");
        } catch (err) {
          toast(`실패: ${err.message}`, "error", 5000);
        } finally {
          syncBtn.disabled = false;
          syncBtn.textContent = "재동기화";
        }
      },
    },
    "재동기화"
  );

  const dryRunBtn = h(
    "button",
    {
      class: "btn btn--ghost",
      style: { color: "#1f2328", border: "1px solid #d0d7de" },
      onclick: async () => {
        dryRunBtn.disabled = true;
        dryRunBtn.textContent = "트리거 중...";
        try {
          await dispatchWorkflow(repoName, "api-doc-pr.yml", API_DOCS_WORKFLOW_REF, {
            dry_run: true,
            full_sync: true,
          });
          toast("Dry-run 트리거 완료. Actions 의 Summary 에서 결과 확인", "success");
        } catch (err) {
          toast(`실패: ${err.message}`, "error", 5000);
        } finally {
          dryRunBtn.disabled = false;
          dryRunBtn.textContent = "Dry-run";
        }
      },
    },
    "Dry-run"
  );

  const publishedListEl = published.length
    ? h(
        "table",
        { class: "matrix-table api-list-table" },
        h("thead", null,
          h("tr", null,
            h("th", null, "Method"),
            h("th", null, "Path"),
            h("th", null, "제목"),
            h("th", null, "링크"),
            h("th", null, "마지막 동기화")
          )
        ),
        h("tbody", null,
          ...published.map(([apiKey, meta]) => renderPublishedRow(apiKey, meta, repoName))
        )
      )
    : h("div", { class: "empty", style: { padding: "16px" } },
        "Published 페이지 없음. PR 머지 시 docs/*.md 가 자동으로 Dooray 에 동기화됩니다.");

  mount(
    root,
    h(
      "div",
      { class: "card" },
      h("a", { class: "back-link", href: "#/overview" }, "← 적용 현황"),
      h(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } },
        h("h2", { class: "card__title", style: { margin: 0 } }, `${repoName} — API Docs`),
        h(
          "div",
          { style: { display: "flex", gap: "8px" } },
          dryRunBtn,
          syncBtn,
          h("a", { class: "btn btn--small", href: `#/runs/${repoName}` }, "실행 현황")
        )
      ),
      h(
        "p",
        { class: "card__desc" },
        "이 화면은 PR 머지로 자동 발행된 페이지 목록입니다. ",
        h("strong", null, "수동 Draft 생성·Publish 는 제공하지 않습니다"),
        " (로컬 ", h("code", null, "/api-docs"), " 명령으로 md 를 생성·수정한 뒤 PR 로 올려주세요)."
      ),

      h("div", { class: "section-title" }, `Published (${published.length})`),
      publishedListEl
    )
  );
}

function renderPublishedRow(apiKey, meta, repoName) {
  const { method, path } = parseApiKey(apiKey);
  const dooray = meta.page_id
    ? `${DOORAY_WEB_BASE}/wiki/${DOORAY_WIKI_ID}/${meta.page_id}`
    : null;
  const github = meta.md_path
    ? `https://github.com/${ORG}/${repoName}/blob/develop/${meta.md_path}`
    : null;

  return h(
    "tr",
    null,
    h("td", null, h("span", { class: `api-method method-${method}` }, method)),
    h("td", null, h("code", { class: "api-path" }, path)),
    h("td", null, meta.title || "—"),
    h(
      "td",
      { style: { whiteSpace: "nowrap" } },
      dooray ? h("a", { href: dooray, target: "_blank", class: "btn btn--small" }, "📄 Dooray") : null,
      dooray && github ? " " : null,
      github ? h("a", { href: github, target: "_blank", class: "btn btn--small btn--ghost", style: { color: "#1f2328", border: "1px solid #d0d7de" } }, "📝 md") : null
    ),
    h(
      "td",
      { style: { fontSize: "11px", color: "var(--text-muted)" } },
      meta.last_synced_at ? meta.last_synced_at.slice(0, 16).replace("T", " ") : (meta.updated_at ? meta.updated_at.slice(0, 16).replace("T", " ") : "—")
    )
  );
}
