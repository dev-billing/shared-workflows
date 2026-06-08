import { h, mount, clear } from "../utils/dom.js";
import { loadMatrix } from "../api/applied.js";
import { readRegistry, entriesOf } from "../api/registry.js";
import { toast } from "../utils/toast.js";

// REST API Docs > Docs 관리 picker.
// rest-api-docs feature 가 적용된 repo 만 노출하고, 각 repo 의
// registry 에서 published 개수·마지막 동기화 시각을 미니메타로 보여준다.

const FEATURE_ID = "rest-api-docs";

export async function renderApiDocsPicker(root) {
  mount(
    root,
    h(
      "div",
      { class: "card" },
      h("h2", { class: "card__title" }, "Docs 관리"),
      h(
        "p",
        { class: "card__desc" },
        "REST API Docs 가 적용된 서비스 레포 목록입니다. 항목을 선택하면 해당 레포의 Published API 목록으로 이동합니다."
      ),
      h(
        "div",
        { id: "docs-picker-list", class: "empty" },
        h("span", { class: "spinner" }),
        " 로딩 중..."
      )
    )
  );
  const list = document.getElementById("docs-picker-list");

  let rows;
  try {
    rows = await loadMatrix();
  } catch (err) {
    toast(`레포 목록 로드 실패: ${err.message}`, "error", 5000);
    return;
  }

  // rest-api-docs 가 applied 또는 partial 인 repo 만 추림 (missing 은 노출 안 함)
  const candidates = rows.filter(
    (r) => !r.repo.archived && r.status[FEATURE_ID] && r.status[FEATURE_ID] !== "missing"
  );

  if (!candidates.length) {
    clear(list);
    list.className = "empty";
    list.textContent =
      "REST API Docs 가 적용된 레포가 없습니다. 레포 관리에서 먼저 기능을 적용해주세요.";
    return;
  }

  // 각 repo 의 registry 병렬 로드 (실패해도 row 는 표시)
  const metas = await Promise.all(
    candidates.map((row) =>
      readRegistry(row.repo.name)
        .then((reg) => {
          const published = entriesOf(reg).filter(
            ([, v]) => v && v.status === "published"
          );
          const lastSync = published
            .map(([, v]) => v.last_synced_at)
            .filter(Boolean)
            .sort()
            .pop();
          return { count: published.length, lastSync: lastSync || null };
        })
        .catch(() => ({ count: null, lastSync: null }))
    )
  );

  clear(list);
  list.className = "";

  const table = h(
    "table",
    { class: "matrix-table" },
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", { style: { width: "40%" } }, "레포"),
        h("th", { style: { width: "20%" } }, "적용 상태"),
        h("th", { style: { width: "15%" } }, "Published"),
        h("th", { style: { width: "25%" } }, "마지막 동기화"),
        h("th", { style: { width: "140px" } }, "")
      )
    ),
    h(
      "tbody",
      null,
      ...candidates.map((row, i) => renderRow(row, metas[i]))
    )
  );
  list.appendChild(table);
}

function renderRow(row, meta) {
  const status = row.status[FEATURE_ID];
  const statusLabel =
    status === "applied" ? "✅ 적용" : status === "partial" ? "🟡 부분" : status;
  return h(
    "tr",
    null,
    h(
      "td",
      null,
      h("a", { href: `#/api-docs/${row.repo.name}`, class: "repo-link" }, row.repo.name)
    ),
    h("td", null, statusLabel),
    h(
      "td",
      null,
      meta.count === null ? "—" : `${meta.count}개`
    ),
    h(
      "td",
      { style: { fontSize: "12px", color: "var(--text-muted)" } },
      meta.lastSync
        ? meta.lastSync.slice(0, 16).replace("T", " ")
        : "—"
    ),
    h(
      "td",
      { style: { whiteSpace: "nowrap" } },
      h(
        "a",
        {
          href: `#/api-docs/${row.repo.name}`,
          class: "btn btn--small",
          style: { whiteSpace: "nowrap" },
        },
        "관리 →"
      )
    )
  );
}
