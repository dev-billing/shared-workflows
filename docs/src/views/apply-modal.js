import { h, mount, clear } from "../utils/dom.js";
import { getFileContent, putFile, getRepo } from "../api/repos.js";
import { ghFetch } from "../api/github.js";

// 모든 적용·갱신은 develop 브랜치를 우선 사용. 없으면 default_branch (main/master) fallback.
export async function resolveTargetBranch(owner, repoName, repoMeta) {
  // develop 존재 확인 — 404 면 fallback
  try {
    const branchInfo = await ghFetch(`/repos/${owner}/${repoName}/branches/develop`)
      .catch(() => null);
    if (branchInfo && branchInfo.name) return "develop";
  } catch (e) { /* fall through */ }
  if (repoMeta && repoMeta.default_branch) return repoMeta.default_branch;
  const meta = await getRepo(owner, repoName);
  return meta.default_branch;
}
import { ORG, SHARED_WORKFLOWS_REPO } from "../config.js";
import { readMeta, writeMeta } from "../api/meta-yml.js";
import { toast } from "../utils/toast.js";
import { buildEnvForm } from "../utils/env-form.js";
import { encodeB64 } from "../utils/b64.js";

// 적용 모달.
//   feature : FEATURES[i]
//   targetRepo: { name, owner: { login }, default_branch }
//   onDone : 성공 후 호출 (매트릭스 재조회)
export function openApplyModal(feature, targetRepo, onDone) {
  const backdrop = h("div", { class: "modal-backdrop" });

  const closeModal = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });

  const statusBox = h("div");
  const applyBtn = h("button", { class: "btn" }, "적용");
  const cancelBtn = h(
    "button",
    {
      class: "btn btn--ghost",
      style: { color: "#1f2328", border: "1px solid #d0d7de" },
      onclick: closeModal,
    },
    "닫기"
  );

  const fileList = h(
    "ul",
    { style: { paddingLeft: "20px", margin: "8px 0" } },
    ...feature.files.map((f) => h("li", null, h("code", null, f.target)))
  );

  // ─── extraSetup === "meta-yml" 인 경우 docs/_meta.yml 입력 폼 ───
  let envForm = null;
  let envFormEl = null;
  let needsMetaYml = feature.extraSetup === "meta-yml";

  if (needsMetaYml) {
    envForm = buildEnvForm({}, { serviceName: targetRepo.name });
    envFormEl = h(
      "div",
      { class: "quick-setup" },
      h(
        "div",
        { class: "quick-setup__head" },
        h("span", { class: "quick-setup__badge" }, "빠른 설정"),
        h("span", { class: "quick-setup__title" }, "기본 도메인 URL (docs/_meta.yml)")
      ),
      h(
        "p",
        { class: "quick-setup__desc" },
        "환경별 Base URL 만 등록합니다. 비워두고 적용한 뒤 ",
        h(
          "a",
          { href: `#/domains/${targetRepo.name}`, class: "quick-setup__link" },
          "도메인 관리"
        ),
        " 에서 채워도 됩니다."
      ),
      envForm.container,
      h("div", { style: { marginTop: "6px" } }, envForm.addBtn),
      h(
        "div",
        { class: "quick-setup__advanced" },
        "ℹ 게이트웨이 라우팅 / 패키지별 다중 도메인 등 고급 설정은 적용 후 ",
        h(
          "a",
          { href: `#/domains/${targetRepo.name}`, class: "quick-setup__link" },
          "도메인 관리"
        ),
        " 에서 진행하세요."
      )
    );

    // 기존 _meta.yml 이 있으면 미리 채워넣기
    readMeta(targetRepo.name)
      .then((r) => {
        if (r && r.meta && r.meta.environments && Object.keys(r.meta.environments).length) {
          envForm.reset(r.meta.environments);
        }
      })
      .catch(() => {});
  }

  applyBtn.addEventListener("click", async () => {
    applyBtn.disabled = true;
    applyBtn.textContent = "적용 중...";
    try {
      await applyFeature(feature, targetRepo, statusBox);

      if (needsMetaYml) {
        const environments = envForm.getValues();
        appendStatus(statusBox, `→ docs/_meta.yml 작성 중...`);
        const targetBranch = await resolveTargetBranch(
          targetRepo.owner.login,
          targetRepo.name,
          targetRepo
        );
        await writeMeta(targetRepo.name, {
          environments,
          useGateway: false,
          gateway: [],
          groups: [],
        }, {
          message: `chore: create docs/_meta.yml for ${targetRepo.name}`,
          branch: targetBranch,
        });
        appendStatus(statusBox, `✓ docs/_meta.yml 작성 완료`);
      }

      toast(`${feature.label} 적용 완료`, "success");
      closeModal();
      onDone && onDone();
    } catch (err) {
      toast(`적용 실패: ${err.message}`, "error", 5000);
      applyBtn.disabled = false;
      applyBtn.textContent = "재시도";
    }
  });

  mount(
    backdrop,
    h(
      "div",
      { class: "modal", onclick: (e) => e.stopPropagation() },
      h("div", { class: "modal__header" },
        h("h3", { class: "modal__title" }, `${feature.label} 적용`),
      ),
      h(
        "div",
        { class: "modal__body" },
        h(
          "p",
          null,
          h("strong", null, `${ORG}/${targetRepo.name}`),
          " 의 develop 브랜치 (없으면 default branch) 에 다음 파일을 추가합니다:"
        ),
        fileList,
        h(
          "p",
          { style: { fontSize: "12px", color: "#656d76", marginTop: "12px" } },
          "이미 존재하는 파일은 내용이 덮어쓰기됩니다."
        ),
        envFormEl,
        statusBox
      ),
      h("div", { class: "modal__actions" }, cancelBtn, applyBtn)
    )
  );

  document.body.appendChild(backdrop);
}

// ── 모달 없이 단일 레포에 적용 (deploy view 일괄 적용용) ──
export async function applyFeatureToRepo(feature, targetRepo) {
  const defaultBranch = await resolveTargetBranch(
    targetRepo.owner.login,
    targetRepo.name,
    targetRepo
  );
  // ApiDocs.java 같은 placeholder 치환이 필요한 파일에 미리 root 패키지 검출
  const needsPackage = feature.files.some((f) => f.transform === "java-package");
  let rootPackage = null;
  let rootPackagePath = null;
  if (needsPackage) {
    const detected = await detectRootJavaPackage(targetRepo.owner.login, targetRepo.name, defaultBranch);
    rootPackage = detected.dotted;
    rootPackagePath = detected.slashed;
  }

  for (const file of feature.files) {
    let sourceContent;
    let targetPath = file.target;
    if (file.transform === "java-package") {
      if (!rootPackage) {
        // 패키지 미검출 시 스킵 + 경고
        console.warn(`[apply] ${feature.id}: root 패키지 검출 실패, ${file.target} 스킵`);
        continue;
      }
      const tpl = await getFileContent(ORG, SHARED_WORKFLOWS_REPO, file.source);
      if (!tpl) throw new Error(`템플릿 없음: ${file.source}`);
      sourceContent = atob(tpl.content.replace(/\n/g, ""))
        .replace(/\{\{PACKAGE\}\}/g, rootPackage + ".apidoc");
      targetPath = file.target.replace(/\{PACKAGE_PATH\}/g, rootPackagePath);
    } else {
      const source = await getFileContent(ORG, SHARED_WORKFLOWS_REPO, file.source);
      if (!source) throw new Error(`템플릿 없음: ${file.source}`);
      sourceContent = atob(source.content.replace(/\n/g, ""));
    }
    const existing = await getFileContent(
      targetRepo.owner.login,
      targetRepo.name,
      targetPath,
      defaultBranch
    );
    await putFile(targetRepo.owner.login, targetRepo.name, targetPath, {
      contentB64: encodeB64(sourceContent),
      message: `chore: apply ${feature.id} (${targetPath.split("/").pop()})`,
      sha: existing ? existing.sha : undefined,
      branch: defaultBranch,
    });
  }
}

// target repo 의 src/main/java 하위에서 root 패키지 검출.
// 가장 깊은 공통 디렉토리 prefix → 점 표기로 변환. 검출 실패 시 null.
async function detectRootJavaPackage(owner, repoName, branch) {
  try {
    let path = "src/main/java";
    const segments = [];
    for (let depth = 0; depth < 10; depth++) {
      const entries = await ghFetch(
        `/repos/${owner}/${repoName}/contents/${path}?ref=${branch}`
      ).catch(() => null);
      if (!Array.isArray(entries)) break;
      const dirs = entries.filter((e) => e.type === "dir");
      if (dirs.length !== 1) break; // 분기 → 여기서 멈춤
      segments.push(dirs[0].name);
      path = `${path}/${dirs[0].name}`;
    }
    if (!segments.length) return { dotted: null, slashed: null };
    return {
      dotted: segments.join("."),
      slashed: segments.join("/"),
    };
  } catch (e) {
    return { dotted: null, slashed: null };
  }
}

function appendStatus(box, msg) {
  const pre = box.querySelector("pre");
  if (pre) {
    pre.textContent = (pre.textContent || "") + "\n" + msg;
    pre.scrollTop = pre.scrollHeight;
  } else {
    const newPre = h(
      "pre",
      {
        style: {
          background: "#f6f8fa",
          padding: "8px 12px",
          borderRadius: "6px",
          fontSize: "12px",
          margin: "12px 0 0",
          maxHeight: "200px",
          overflow: "auto",
        },
      },
      msg
    );
    box.appendChild(newPre);
  }
}

async function applyFeature(feature, targetRepo, statusBox) {
  const defaultBranch = await resolveTargetBranch(
    targetRepo.owner.login,
    targetRepo.name,
    targetRepo
  );
  appendStatus(statusBox, `→ 대상 브랜치: ${defaultBranch}`);

  // placeholder 치환이 필요한 파일이 있으면 root 패키지 먼저 검출
  const needsPackage = feature.files.some((f) => f.transform === "java-package");
  let rootPackage = null;
  let rootPackagePath = null;
  if (needsPackage) {
    appendStatus(statusBox, `→ root 패키지 검출 중...`);
    const detected = await detectRootJavaPackage(targetRepo.owner.login, targetRepo.name, defaultBranch);
    rootPackage = detected.dotted;
    rootPackagePath = detected.slashed;
    if (!rootPackage) {
      appendStatus(statusBox, `⚠ root 패키지 검출 실패 — ApiDocs.java 자동 배포 스킵 (수동으로 추가하세요)`);
    } else {
      appendStatus(statusBox, `✓ root 패키지: ${rootPackage}`);
    }
  }

  for (const file of feature.files) {
    let sourceContent;
    let targetPath = file.target;
    appendStatus(statusBox, `→ ${file.source} 읽는 중...`);

    if (file.transform === "java-package") {
      if (!rootPackage) continue;
      const tpl = await getFileContent(ORG, SHARED_WORKFLOWS_REPO, file.source);
      if (!tpl) throw new Error(`템플릿 없음: ${file.source}`);
      sourceContent = atob(tpl.content.replace(/\n/g, ""))
        .replace(/\{\{PACKAGE\}\}/g, rootPackage + ".apidoc");
      targetPath = file.target.replace(/\{PACKAGE_PATH\}/g, rootPackagePath);
    } else {
      const source = await getFileContent(ORG, SHARED_WORKFLOWS_REPO, file.source);
      if (!source) throw new Error(`템플릿 없음: ${file.source}`);
      sourceContent = atob(source.content.replace(/\n/g, ""));
    }

    const existing = await getFileContent(
      targetRepo.owner.login,
      targetRepo.name,
      targetPath,
      defaultBranch
    );

    appendStatus(statusBox, `✓ 읽음. ${targetPath} 커밋 중...`);
    await putFile(targetRepo.owner.login, targetRepo.name, targetPath, {
      contentB64: encodeB64(sourceContent),
      message: `chore: apply ${feature.id} (${targetPath.split("/").pop()})`,
      sha: existing ? existing.sha : undefined,
      branch: defaultBranch,
    });
    appendStatus(statusBox, `✓ ${targetPath}`);
  }
  appendStatus(statusBox, "파일 적용 완료");
}
