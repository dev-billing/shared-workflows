import { h, mount } from "../utils/dom.js";

// 사이드바 nav 정의 — 카테고리별 그룹
const groups = [
  {
    title: "📦 레포지토리",
    items: [
      {
        label: "레포 관리",
        href: "#/repos",
        matches: (h) => h.startsWith("#/repos"),
      },
    ],
  },
  {
    title: "📄 REST API Docs",
    items: [
      {
        label: "도메인 관리",
        href: "#/domains",
        matches: (h) => h.startsWith("#/domains"),
      },
      {
        label: "Docs 관리",
        href: "#/api-docs",
        matches: (h) => h.startsWith("#/api-docs"),
      },
    ],
  },
  {
    title: "🔌 MCP",
    items: [
      {
        label: "AI Context",
        href: "#/ai-context",
        matches: (h) => h.startsWith("#/ai-context"),
      },
    ],
  },
];

export function renderNavSidebar(el, currentHash) {
  mount(
    el,
    groups.map((g) =>
      h(
        "div",
        { class: "nav-group" },
        h("div", { class: "nav-group__title" }, g.title),
        h(
          "div",
          { class: "nav-group__items" },
          g.items.map((it) =>
            h(
              "a",
              {
                class: "nav-item" + (it.matches(currentHash) ? " is-active" : ""),
                href: it.href,
              },
              it.label
            )
          )
        )
      )
    )
  );
}
