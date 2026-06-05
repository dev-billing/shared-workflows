import { h, mount, clear } from "../utils/dom.js";
import { toast } from "../utils/toast.js";
import {
  readMeta,
  writeMeta,
  invalidateMetaCache,
} from "../api/meta-yml.js";
import { parseGatewayYml } from "../api/service-config.js";
import { deleteFile, getFileContent, getRepo } from "../api/repos.js";
import { ORG } from "../config.js";
import { readRepoList } from "../api/repo-list.js";
import { loadMatrix } from "../api/applied.js";
import { applyFeatureToRepo } from "./apply-modal.js";
import { FEATURES } from "../config.js";
import { buildEnvForm } from "../utils/env-form.js";

const REST_API_DOCS_FEATURE_ID = "rest-api-docs";

export async function renderDomains(root, selected /* optional serviceName */) {
  const listEl = h("div", { class: "sidebar__list" });
  const detailEl = h("div", { class: "detail" });
  const addBtn = h(
    "button",
    { class: "btn btn--small", title: "서비스 추가", onclick: openAddServiceModal },
    "+"
  );
  const refreshBtn = h(
    "button",
    {
      class: "btn btn--small",
      title: "새로고침 (캐시 비우고 다시 로드)",
      onclick: () => {
        invalidateMetaCache();
        load(true);
      },
    },
    "↻"
  );

  let json = {};
  let repoList = null;             // null 이면 repo-list 미설정 (전체 표시)
  let matrixByName = {};           // { repoName: { status, repo } }
  let selectedName = selected || null;

  async function load(force = false) {
    clear(listEl);
    listEl.appendChild(
      h("div", { class: "empty", style: { padding: "16px" } },
        h("span", { class: "spinner" }), " 로딩 중...")
    );
    try {
      const [rl, matrix] = await Promise.all([
        readRepoList(),
        loadMatrix(force).catch(() => []),
      ]);
      repoList = rl.list || [];
      matrixByName = {};
      for (const row of matrix || []) {
        if (row && row.repo) matrixByName[row.repo.name] = row;
      }
      // 각 repo 의 docs/_meta.yml 을 병렬 fetch
      json = {};
      const fetches = repoList.map(async (repoName) => {
        try {
          const r = await readMeta(repoName);
          // meta 가 있고 적용 상태이면 등록 (없으면 기본값으로 비어있음)
          if (r.exists) {
            json[repoName] = r.meta;
          } else {
            // 워크플로우는 적용됐는데 _meta.yml 이 아직 없을 수 있음 — 빈 entry 로 들어가게 둠
            json[repoName] = r.meta; // empty meta
          }
        } catch (e) {
          // 404 등은 readMeta 가 이미 흡수. 그래도 안전망.
          json[repoName] = { environments: {}, useGateway: false, gateway: [], groups: [] };
        }
      });
      await Promise.all(fetches);
      renderSidebar();
      renderDetail();
    } catch (err) {
      clear(listEl);
      listEl.appendChild(h("div", { class: "empty" }, `오류: ${err.message}`));
    }
  }

  // 서비스별 상태 분류
  function classify(name) {
    const entry = json[name];
    const row = matrixByName[name];
    const restApiApplied = !!(row && row.status && row.status[REST_API_DOCS_FEATURE_ID] === "applied");
    const hasDomain =
      !!(entry && entry.environments && Object.keys(entry.environments).length) ||
      !!(entry && entry.groups && entry.groups.length);
    return { entry, row, restApiApplied, hasDomain };
  }

  // 사이드바에 표시할 서비스 목록 = repo-list (있으면) 우선
  // 미등록 레포도 노출 (badge: '미등록') → 클릭해서 새로 설정 가능
  function listServices() {
    const configured = Object.keys(json).filter((k) => !k.startsWith("_"));
    if (repoList && repoList.length) {
      const set = new Set(repoList);
      // repo-list 순서 유지 + (안전망) configured 중 repo-list 에 없는 것은 뒤에 표시
      const inList = repoList.slice().sort();
      const extra = configured.filter((n) => !set.has(n)).sort();
      return [...inList, ...extra];
    }
    return configured.sort();
  }

  function renderSidebar() {
    clear(listEl);
    const services = listServices();
    if (!services.length) {
      listEl.appendChild(h("div", { class: "empty" }, "등록된 서비스 없음"));
      return;
    }
    for (const name of services) {
      const { restApiApplied, hasDomain, entry } = classify(name);
      let badgeText, badgeCls, badgeTitle;
      if (!restApiApplied) {
        badgeText = "기능 미적용";
        badgeCls = "empty";
        badgeTitle = "rest-api-docs 워크플로우가 아직 적용되지 않음. 저장하면 자동 적용됩니다.";
      } else if (!hasDomain) {
        badgeText = "도메인 ✗";
        badgeCls = "partial";
        badgeTitle = "rest-api-docs 적용됨. 도메인 설정 필요.";
      } else if (entry && entry.useGateway) {
        badgeText = "GW";
        badgeCls = "full";
        badgeTitle = "게이트웨이 사용 + 도메인 등록 완료";
      } else {
        badgeText = "direct";
        badgeCls = "full";
        badgeTitle = "직접 노출 + 도메인 등록 완료";
      }
      const item = h(
        "a",
        {
          class: "sidebar__item" + (name === selectedName ? " is-active" : ""),
          href: `#/domains/${name}`,
        },
        h("span", { class: "name" }, name),
        h("span", { class: `badge ${badgeCls}`, title: badgeTitle }, badgeText)
      );
      listEl.appendChild(item);
    }
  }

  function renderDetail() {
    clear(detailEl);
    if (!selectedName) {
      detailEl.appendChild(
        h("div", { class: "card empty" }, "← 왼쪽에서 서비스를 선택하세요")
      );
      return;
    }
    const entry = json[selectedName] || { useGateway: false, environments: {} };
    detailEl.appendChild(renderServiceCard(selectedName, entry));
  }

  function renderServiceCard(name, entry) {
    const useGatewayCheck = h("input", {
      type: "checkbox",
      checked: !!entry.useGateway,
    });

    const envForm = buildEnvForm(entry.environments || {}, { serviceName: name });
    const groupsContainer = h("div");

    function renderGroups() {
      clear(groupsContainer);
      const isGateway = useGatewayCheck.checked;
      const groups = entry.groups || [];

      const sectionTitle = isGateway
        ? "Routes (게이트웨이 라우팅)"
        : "Groups (패키지별 다중 도메인)";
      const helpText = isGateway
        ? "게이트웨이 YML 의 각 route 를 등록합니다. 컨트롤러 path 의 internal prefix 가 매칭되면 external prefix 로 변환되어 문서에 노출됩니다."
        : "한 레포가 여러 도메인을 직접 노출하는 경우(게이트웨이 미사용) 패키지별로 다른 환경 URL 을 지정합니다. 매칭 안 되는 컨트롤러는 위의 서비스 environments 를 사용합니다.";

      groupsContainer.appendChild(
        h("div", { class: "section-title", style: { marginTop: "16px" } },
          sectionTitle,
          h("button", {
            class: "btn btn--small",
            style: { marginLeft: "auto" },
            onclick: () => openGroupEditor(null),
          }, isGateway ? "+ Route 추가" : "+ 그룹 추가")
        )
      );
      groupsContainer.appendChild(
        h("p", { class: "card__desc", style: { fontSize: "12px" } }, helpText)
      );

      if (!groups.length) {
        groupsContainer.appendChild(
          h("div", { class: "empty", style: { padding: "16px" } },
            isGateway
              ? "Route 없음. + Route 추가 를 누르세요. YML 붙여넣기로 한 번에 채울 수도 있어요."
              : "그룹 없음. + 그룹 추가 를 누르세요."
          )
        );
        return;
      }

      const headerRow = isGateway
        ? h("tr", null,
            h("th", null, "이름"),
            h("th", null, "internal"),
            h("th", null, "external"),
            h("th", { style: { width: "100px" } }, "")
          )
        : h("tr", null,
            h("th", null, "이름"),
            h("th", null, "패키지 prefix"),
            h("th", null, "환경 URL"),
            h("th", { style: { width: "100px" } }, "")
          );

      const renderRow = (g, idx) => isGateway
        ? h("tr", null,
            h("td", null, g.name || ""),
            h("td", null, h("code", null, g.internalUrlPrefix || "")),
            h("td", null, h("code", null, g.externalUrlPrefix || "")),
            h("td", null,
              h("button", { class: "btn btn--small", onclick: () => openGroupEditor(idx) }, "수정"),
              " ",
              h("button", { class: "btn btn--small btn--danger", onclick: () => removeGroup(idx) }, "×")
            )
          )
        : h("tr", null,
            h("td", null, g.name || ""),
            h("td", null, h("code", null, g.packagePrefix || "")),
            h("td", null,
              g.environments && Object.keys(g.environments).length
                ? h("div", { class: "env-cell" },
                    ...Object.entries(g.environments).map(([k, v]) =>
                      h("div", { class: "env-cell__row" },
                        h("span", { class: "env-cell__key" }, k),
                        h("span", { class: "env-cell__url" }, v)
                      )
                    )
                  )
                : h("span", { style: { color: "var(--text-muted)" } }, "(service 기본값 사용)")
            ),
            h("td", null,
              h("button", { class: "btn btn--small", onclick: () => openGroupEditor(idx) }, "수정"),
              " ",
              h("button", { class: "btn btn--small btn--danger", onclick: () => removeGroup(idx) }, "×")
            )
          );

      const tbl = h("table", { class: "matrix-table" },
        h("thead", null, headerRow),
        h("tbody", null, ...groups.map(renderRow))
      );
      groupsContainer.appendChild(tbl);
    }

    function openGroupEditor(editIdx) {
      const isGateway = useGatewayCheck.checked;
      const existing = editIdx == null ? {} : (entry.groups || [])[editIdx] || {};
      const nameIn = h("input", { type: "text", value: existing.name || "" });
      const cancelBtn = h("button", {
        class: "btn btn--ghost",
        style: { color: "#1f2328", border: "1px solid #d0d7de" },
      }, "취소");
      const okBtn = h("button", { class: "btn" }, editIdx == null ? "추가" : "저장");

      // 모달 본문은 useGateway 에 따라 다름
      let bodyEl, getValues;

      if (isGateway) {
        // ── useGateway=true: name + internal/external prefix + YML 파서 ──
        const ymlInput = h("textarea", {
          rows: 6,
          placeholder: `붙여넣기 예:\n- id: pay-api\n  predicates:\n    - Path=/pay/**\n  filters:\n    - RewritePath=/pay/(?<segment>/?.*), /external/\${segment}`,
          style: { width: "100%", fontFamily: "monospace", fontSize: "12px" },
        });
        const intIn = h("input", { type: "text", value: existing.internalUrlPrefix || "", placeholder: "/external" });
        const extIn = h("input", { type: "text", value: existing.externalUrlPrefix || "", placeholder: "/pay" });
        const parseBtn = h("button", {
          class: "btn btn--small",
          onclick: () => {
            const parsed = parseGatewayYml(ymlInput.value);
            if (!parsed) { toast("YML 에서 routing 정보를 찾지 못했습니다", "error"); return; }
            if (parsed.name && !nameIn.value) nameIn.value = parsed.name;
            if (parsed.externalUrlPrefix) extIn.value = parsed.externalUrlPrefix;
            if (parsed.internalUrlPrefix) intIn.value = parsed.internalUrlPrefix;
            toast("YML 파싱 완료", "success");
          },
        }, "YML 파싱해서 채우기");

        bodyEl = h("div", { class: "modal__body" },
          h("div", { class: "field" },
            h("label", null, "Gateway YML (선택 — 붙여넣고 파싱)"),
            ymlInput,
            h("div", { style: { textAlign: "right", marginTop: "4px" } }, parseBtn)
          ),
          h("hr"),
          h("div", { class: "field" }, h("label", null, "Route 이름"), nameIn),
          h("div", { class: "field" }, h("label", null, "internal URL prefix (코드의 컨트롤러 path)"), intIn),
          h("div", { class: "field" }, h("label", null, "external URL prefix (외부 호출 시 path)"), extIn),
        );
        getValues = () => {
          if (!nameIn.value.trim() || !intIn.value.trim() || !extIn.value.trim()) {
            toast("이름, internal, external 모두 필수", "error");
            return null;
          }
          return {
            name: nameIn.value.trim(),
            internalUrlPrefix: intIn.value.trim(),
            externalUrlPrefix: extIn.value.trim(),
          };
        };
      } else {
        // ── useGateway=false: name + packagePrefix + 자체 environments ──
        const pkgIn = h("input", { type: "text", value: existing.packagePrefix || "", placeholder: "com.bill.payment" });
        const groupEnvForm = buildEnvForm(existing.environments || {}, { serviceName: name });

        bodyEl = h("div", { class: "modal__body" },
          h("div", { class: "field" }, h("label", null, "그룹 이름"), nameIn),
          h("div", { class: "field" }, h("label", null, "패키지 prefix"), pkgIn),
          h("hr"),
          h("div", { class: "field" },
            h("label", null, "이 그룹의 환경별 URL (비우면 서비스 기본 environments 사용)"),
            groupEnvForm.container,
            h("div", { style: { marginTop: "6px" } }, groupEnvForm.addBtn)
          ),
        );
        getValues = () => {
          if (!nameIn.value.trim() || !pkgIn.value.trim()) {
            toast("이름과 패키지 prefix 는 필수", "error");
            return null;
          }
          const envs = groupEnvForm.getValues();
          const g = {
            name: nameIn.value.trim(),
            packagePrefix: pkgIn.value.trim(),
          };
          if (Object.keys(envs).length) g.environments = envs;
          return g;
        };
      }

      const backdrop = h("div", { class: "modal-backdrop" });
      const modal = h("div", { class: "modal", onclick: (e) => e.stopPropagation() },
        h("div", { class: "modal__header" },
          h("h3", { class: "modal__title" },
            editIdx == null
              ? (isGateway ? "Route 추가" : "그룹 추가")
              : (isGateway ? "Route 수정" : "그룹 수정")
          ),
        ),
        bodyEl,
        h("div", { class: "modal__actions" }, cancelBtn, okBtn)
      );

      cancelBtn.addEventListener("click", () => backdrop.remove());
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

      okBtn.addEventListener("click", () => {
        const newGroup = getValues();
        if (!newGroup) return;
        entry.groups = entry.groups || [];
        if (editIdx == null) entry.groups.push(newGroup);
        else entry.groups[editIdx] = newGroup;
        renderGroups();
        backdrop.remove();
      });

      mount(backdrop, modal);
      document.body.appendChild(backdrop);
    }

    function removeGroup(idx) {
      if (!confirm("이 그룹을 삭제할까요?")) return;
      entry.groups.splice(idx, 1);
      renderGroups();
    }

    // useGateway 모드 전환 시 기존 groups 는 데이터 형태가 호환 안 되므로 비움.
    // (useGateway=true 의 internal/external prefix 와 false 의 packagePrefix/env 는
    //  서로 다른 스키마)
    useGatewayCheck.addEventListener("change", () => {
      entry.groups = [];
      renderGroups();
    });

    const saveBtn = h("button", { class: "btn", onclick: async () => {
      const newEntry = {
        useGateway: useGatewayCheck.checked,
        environments: envForm.getValues(),
      };
      // groups 는 useGateway 와 무관하게 항상 보존 (모드 전환 시 비워지므로 충돌 없음)
      if (entry.groups && entry.groups.length) {
        newEntry.groups = entry.groups;
      }

      // 현재 rest-api-docs 적용 상태 / 변경 여부
      const cls = classify(name);
      const prevJson = JSON.stringify(json[name] || {});
      const nextJson = JSON.stringify(newEntry);
      const configChanged = prevJson !== nextJson;
      const willApplyFeature = !cls.restApiApplied;

      if (!configChanged && !willApplyFeature) {
        toast("변경사항 없음", "info");
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "저장 중...";
      try {
        // rest-api-docs 미적용이면 워크플로우 + ApiDocs.java 먼저 적용 (자동 활성화)
        if (willApplyFeature) {
          const feature = FEATURES.find((f) => f.id === REST_API_DOCS_FEATURE_ID);
          const repo = cls.row && cls.row.repo;
          if (feature && repo) {
            saveBtn.textContent = "워크플로우 적용 중...";
            await applyFeatureToRepo(feature, repo);
            toast(`${name} 에 REST API Docs 활성화 완료`, "success");
          } else {
            toast(
              `${name} 레포 정보를 찾지 못해 워크플로우 자동 적용을 건너뛰었습니다. [레포 관리] 에서 확인하세요.`,
              "error", 6000
            );
          }
        }
        if (configChanged) {
          await writeMeta(name, newEntry, {
            message: `chore: update docs/_meta.yml for ${name}`,
          });
          json[name] = newEntry;
        }
        if (configChanged) toast(`${name} 저장 완료`, "success");
        // 매트릭스 무효화 후 재로드 → 뱃지 갱신
        await load(true);
      } catch (err) {
        toast(`저장 실패: ${err.message}`, "error", 5000);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "저장";
      }
    } }, "저장");

    // rest-api-docs 미적용 안내 callout (저장 시 자동 활성화)
    const featureNotAppliedNotice = !classify(name).restApiApplied
      ? h(
          "div",
          { class: "callout callout--warning" },
          "⚠ 이 레포에 ",
          h("strong", null, "REST API Docs 워크플로우가 아직 적용되지 않았습니다"),
          ". 저장 버튼을 누르면 ",
          h("strong", null, "도메인 저장 + 워크플로우 자동 적용"),
          " 이 함께 수행됩니다."
        )
      : null;

    const deleteBtn = h("button", {
      class: "btn btn--danger",
      onclick: async () => {
        if (!confirm(`서비스 "${name}" 의 docs/_meta.yml 을 삭제할까요?`)) return;
        try {
          // target repo 의 docs/_meta.yml 파일 자체 삭제
          const meta = await readMeta(name);
          if (meta.exists && meta.sha) {
            // default branch 확보
            let branch;
            try {
              const repoMeta = await getRepo(ORG, name);
              branch = repoMeta.default_branch;
            } catch (e) { /* fallback to default */ }
            await deleteFile(ORG, name, "docs/_meta.yml", {
              message: `chore: remove docs/_meta.yml for ${name}`,
              sha: meta.sha,
              branch,
            });
            invalidateMetaCache(name);
          }
          delete json[name];
          selectedName = null;
          renderSidebar();
          renderDetail();
          toast(`${name} docs/_meta.yml 삭제 완료`, "success");
        } catch (err) {
          toast(`삭제 실패: ${err.message}`, "error", 5000);
        }
      },
    }, "삭제");

    renderGroups();

    return h("div", { class: "card" },
      h("div", {
        style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
      },
        h("h2", { class: "card__title", style: { margin: 0 } }, name),
        deleteBtn
      ),
      h("div", { class: "meta" },
        h("label", { style: { display: "flex", alignItems: "center", gap: "6px" } },
          useGatewayCheck, " useGateway (게이트웨이 통해 노출)"
        )
      ),
      featureNotAppliedNotice,
      h("div", { class: "section-title" }, "환경별 Base URL"),
      (() => {
        const desc = h("p", { class: "card__desc" });
        function updateDesc() {
          desc.textContent = useGatewayCheck.checked
            ? "게이트웨이 도메인을 입력하세요 (서비스 자체 도메인이 아니라 게이트웨이의 외부 도메인)."
            : "이 서비스의 도메인을 환경별로 입력하세요. 패키지별로 도메인이 다르면 아래 Groups 에 자체 environments 를 설정하세요 (이 값은 매칭 안 되는 컨트롤러의 fallback).";
        }
        updateDesc();
        useGatewayCheck.addEventListener("change", updateDesc);
        return desc;
      })(),
      envForm.container,
      h("div", { style: { marginTop: "8px" } }, envForm.addBtn),
      groupsContainer,
      h("div", { style: { textAlign: "right", marginTop: "16px" } }, saveBtn)
    );
  }

  function openAddServiceModal() {
    const nameInput = h("input", { type: "text", placeholder: "예) my-service" });
    const useGatewayCheck = h("input", { type: "checkbox" });
    const okBtn = h("button", { class: "btn" }, "추가");
    const cancelBtn = h("button", {
      class: "btn btn--ghost",
      style: { color: "#1f2328", border: "1px solid #d0d7de" },
    }, "취소");

    const backdrop = h("div", { class: "modal-backdrop" });
    const modal = h("div", { class: "modal", onclick: (e) => e.stopPropagation() },
      h("div", { class: "modal__header" },
        h("h3", { class: "modal__title" }, "서비스 추가"),
      ),
      h("div", { class: "modal__body" },
        h("div", { class: "field" },
          h("label", null, "서비스 이름 (= GitHub 레포명)"),
          nameInput
        ),
        h("div", { class: "field" },
          h("label", null, useGatewayCheck, " useGateway (게이트웨이 통해 노출)")
        ),
      ),
      h("div", { class: "modal__actions" }, cancelBtn, okBtn)
    );

    cancelBtn.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });

    okBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { toast("서비스 이름이 필요합니다", "error"); return; }
      if (json[name]) { toast("이미 존재하는 서비스", "error"); return; }
      const entry = {
        useGateway: useGatewayCheck.checked,
        environments: {},
      };
      try {
        await writeMeta(name, entry, {
          message: `chore: create docs/_meta.yml for ${name}`,
        });
        json[name] = entry;
        selectedName = name;
        backdrop.remove();
        location.hash = `#/domains/${name}`;
        renderSidebar();
        renderDetail();
        toast(`${name} 추가 완료`, "success");
      } catch (err) {
        toast(`추가 실패: ${err.message}`, "error", 5000);
      }
    });

    mount(backdrop, modal);
    document.body.appendChild(backdrop);
    nameInput.focus();
  }

  // ── render layout ──
  mount(root,
    h("div", { class: "split" },
      h("aside", { class: "sidebar" },
        h("div", { class: "sidebar__head" },
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
            h("strong", { style: { flex: 1 } }, "서비스 목록"),
            addBtn,
            refreshBtn
          )
        ),
        listEl
      ),
      detailEl
    )
  );

  await load();
}
