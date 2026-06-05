import { h, mount, clear } from "../utils/dom.js";
import { loadAllStatus, invalidateAiContextCache } from "../api/ai-context.js";
import { dispatchWorkflow } from "../api/workflows.js";
import {
  CONTEXT_REPO,
  SYNC_WORKFLOW_FILE,
  SYNC_WORKFLOW_REF,
  ORG,
} from "../config.js";
import { toast } from "../utils/toast.js";

const STATUS_META = {
  "up-to-date": { label: "🟢 최신", color: "var(--success)" },
  outdated: { label: "🟡 변경됨", color: "var(--warning)" },
  missing: { label: "⚪ 미생성", color: "var(--text-muted)" },
  error: { label: "❌ 오류", color: "var(--danger)" },
};

function fmtSha(sha) {
  return sha ? sha.slice(0, 7) : "—";
}

export async function renderAiContext(root) {
  const tableWrap = h("div", { class: "card" });
  const summary = h("div", { class: "overview-grid" });

  async function triggerSync(repoName, force = false) {
    try {
      await dispatchWorkflow(
        CONTEXT_REPO,
        SYNC_WORKFLOW_FILE,
        SYNC_WORKFLOW_REF,
        {
          "repo-name": repoName || "",
          force: String(Boolean(force)),
        }
      );
      const target = repoName ? `${repoName}` : "전체";
      toast(`동기화 실행 요청 완료 — ${target}${force ? " (force)" : ""}`, "success");
      // 동기화 직후엔 캐시가 의미 없으므로 무효화 후 잠시 후 재로드
      invalidateAiContextCache();
      setTimeout(() => load(true), 2000);
    } catch (err) {
      toast(`실패: ${err.message}`, "error", 5000);
    }
  }

  function renderSummary(rows) {
    clear(summary);
    const total = rows.length;
    const upToDate = rows.filter((r) => r.status === "up-to-date").length;
    const outdated = rows.filter((r) => r.status === "outdated").length;
    const missing = rows.filter((r) => r.status === "missing").length;
    const error = rows.filter((r) => r.status === "error").length;

    summary.appendChild(
      h(
        "div",
        { class: "overview-card" },
        h("h3", null, "📊 동기화 현황"),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label" }, "전체"),
          h("span", { class: "stat-value" }, total)
        ),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label" }, "🟢 최신"),
          h("span", { class: "stat-value", style: { color: "var(--success)" } }, upToDate)
        ),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label" }, "🟡 변경됨"),
          h("span", { class: "stat-value", style: { color: "var(--warning)" } }, outdated)
        ),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label" }, "⚪ 미생성"),
          h("span", { class: "stat-value", style: { color: "var(--text-muted)" } }, missing)
        ),
        error
          ? h(
              "div",
              { class: "stat" },
              h("span", { class: "stat-label" }, "❌ 오류"),
              h("span", { class: "stat-value", style: { color: "var(--danger)" } }, error)
            )
          : null
      )
    );

    summary.appendChild(
      h(
        "div",
        { class: "overview-card" },
        h("h3", null, "⚡ 일괄 작업"),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label" }, "변경된 항목 동기화"),
          h(
            "button",
            {
              class: "btn btn--small",
              disabled: outdated === 0,
              onclick: async () => {
                if (!confirm(`🟡 변경됨 상태인 ${outdated}개 서비스를 동기화합니다.`)) return;
                const targets = rows.filter((r) => r.status === "outdated").map((r) => r.repo);
                for (const repo of targets) {
                  await triggerSync(repo, false);
                }
              },
            },
            `${outdated}개 실행`
          )
        ),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label" }, "전체 강제 재생성"),
          h(
            "button",
            {
              class: "btn btn--small btn--danger",
              onclick: async () => {
                if (!confirm("⚠️ force=true 로 전체 서비스를 재생성합니다. 시간이 오래 걸립니다. 진행할까요?")) return;
                await triggerSync("", true);
              },
            },
            "force"
          )
        ),
        h(
          "div",
          { class: "stat" },
          h("span", { class: "stat-label" }, "변경 감지 전체 실행"),
          h(
            "button",
            {
              class: "btn btn--small",
              onclick: async () => {
                await triggerSync("", false);
              },
            },
            "all"
          )
        )
      )
    );
  }

  function renderTable(rows) {
    clear(tableWrap);
    tableWrap.appendChild(
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          },
        },
        h("h2", { class: "card__title", style: { margin: 0 } }, "AI Context 동기화 상태"),
        h(
          "div",
          { style: { display: "flex", gap: "8px" } },
          h(
            "a",
            {
              class: "btn btn--small btn--ghost",
              href: `https://github.com/${ORG}/${CONTEXT_REPO}/actions/workflows/${SYNC_WORKFLOW_FILE}`,
              target: "_blank",
              rel: "noreferrer",
            },
            "↗ Actions"
          ),
          h(
            "button",
            { class: "btn btn--small", onclick: () => load(true) },
            "↻ 새로고침"
          )
        )
      )
    );
    tableWrap.appendChild(
      h(
        "p",
        { class: "card__desc" },
        `${CONTEXT_REPO}/state/{repo}.sha 와 서비스 레포의 현재 브랜치 SHA 를 비교한 결과입니다.`
      )
    );

    const table = h(
      "table",
      { class: "matrix-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", null, "서비스"),
          h("th", null, "상태"),
          h("th", null, "마지막 동기화 SHA"),
          h("th", null, "현재 SHA"),
          h("th", null, "ai-context 파일"),
          h("th", null, "")
        )
      ),
      h(
        "tbody",
        null,
        rows.map((r) => {
          const meta = STATUS_META[r.status] || STATUS_META.error;
          const requiredHave = r.requiredPresent.length;
          const requiredExpect = r.requiredFiles.length;
          const optionalHave = r.optionalPresent.length;
          // 필수 진행률만 분수로 표시. 선택 파일은 있을 때 +N 으로 가시화만.
          const filesText =
            r.status === "missing"
              ? "—"
              : `${requiredHave}/${requiredExpect}` +
                (optionalHave > 0 ? ` (+${optionalHave})` : "");
          // 툴팁: 어떤 파일이 있는지 그룹별로 보여줌
          const filesTitle = [
            r.requiredPresent.length
              ? `[필수] ${r.requiredPresent.join(", ")}`
              : "[필수] (없음)",
            r.optionalPresent.length
              ? `[선택] ${r.optionalPresent.join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n");

          return h(
            "tr",
            null,
            h(
              "td",
              null,
              h(
                "a",
                {
                  href: `https://github.com/${ORG}/${CONTEXT_REPO}/tree/main/${r.repo}/ai-context`,
                  target: "_blank",
                  rel: "noreferrer",
                },
                r.repo
              ),
              h("span", { class: "muted", style: { marginLeft: "6px" } }, `@${r.branch}`)
            ),
            h("td", { style: { color: meta.color, fontWeight: 600 } }, meta.label),
            h(
              "td",
              null,
              r.stateSha
                ? h(
                    "a",
                    {
                      href: `https://github.com/${ORG}/${r.repo}/commit/${r.stateSha}`,
                      target: "_blank",
                      rel: "noreferrer",
                      class: "mono",
                    },
                    fmtSha(r.stateSha)
                  )
                : h("span", { class: "muted" }, "—")
            ),
            h(
              "td",
              null,
              r.branchSha
                ? h(
                    "a",
                    {
                      href: `https://github.com/${ORG}/${r.repo}/commit/${r.branchSha}`,
                      target: "_blank",
                      rel: "noreferrer",
                      class: "mono",
                    },
                    fmtSha(r.branchSha)
                  )
                : h("span", { class: "muted" }, "—")
            ),
            h("td", { title: filesTitle }, filesText),
            h(
              "td",
              null,
              h(
                "div",
                { style: { display: "flex", gap: "6px", justifyContent: "flex-end" } },
                h(
                  "button",
                  {
                    class: "btn btn--small",
                    onclick: () => triggerSync(r.repo, false),
                    title: "변경 감지로 동기화",
                  },
                  "동기화"
                ),
                h(
                  "button",
                  {
                    class: "btn btn--small btn--ghost",
                    onclick: () => {
                      if (confirm(`${r.repo} 를 force=true 로 강제 재생성합니다.`)) {
                        triggerSync(r.repo, true);
                      }
                    },
                    title: "force=true 로 강제 재생성",
                  },
                  "force"
                )
              )
            )
          );
        })
      )
    );
    tableWrap.appendChild(table);
  }

  async function load(force = false) {
    clear(summary);
    clear(tableWrap);
    tableWrap.appendChild(
      h("div", { class: "empty" }, h("span", { class: "spinner" }), " 로딩 중...")
    );
    try {
      const { rows } = await loadAllStatus(force);
      renderSummary(rows);
      renderTable(rows);
    } catch (err) {
      clear(tableWrap);
      tableWrap.appendChild(h("div", { class: "empty" }, `오류: ${err.message}`));
      toast(err.message, "error", 5000);
    }
  }

  mount(root, summary, tableWrap);
  await load();
}
