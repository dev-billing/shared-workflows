# @ApiDocs 커버리지 점검

Spring Controller 변경이 포함된 PR 에서 빌링개발팀의 **REST API Docs 자동화 흐름** 정합성을 함께 점검한다.

## 점검 대상 패턴

다음 어느 케이스든 발견되면 **🟡 Should Fix** 로 지적한다.

### 1. 신규 endpoint 가 추가됐는데 `@ApiDocs` 가 없음

```java
// 신규 추가된 코드
+    @GetMapping("/foo")
+    public FooResponse getFoo(...) { ... }
```

→ 메서드 위에 `@ApiDocs(title = "...")` 또는 `@ApiDocs` 가 없으면 지적.

**메시지 예시**:
> 신규 endpoint `GET /foo` 에 `@ApiDocs` 가 누락되어 있습니다.
> 문서화 대상이면 메서드 위에 `@ApiDocs(title = "...")` 을 부착해주세요.
> 외부 노출 안 하는 endpoint 라면 그대로 둬도 됩니다.

### 2. `@ApiDocs` 메서드의 **외부 인터페이스** 가 변경됐는데 `docs/*.md` 미수정

"외부 인터페이스" 변경이란:
- `@*Mapping` 의 URL path 또는 HTTP method 변경
- `@PathVariable` 추가/삭제/이름변경/타입변경
- `@RequestParam` 추가/삭제/이름변경/필수여부/기본값 변경
- `@RequestHeader` 추가/삭제
- `@RequestBody` / `@ModelAttribute` 의 DTO 타입 변경
- return type 변경

내부 로직 (메서드 body) 만 바뀐 건 **무시**.

PR 의 변경 파일 목록에 해당 endpoint 의 `docs/{slug}.md` (또는 `docs/{method}-{slugified-url}.md`) 가 **포함되어 있지 않으면** 지적.

**메시지 예시**:
> `@ApiDocs` 메서드 `getStatistics` 의 시그니처가 변경되었습니다
> (RequestParam `includeDone` 추가). 대응되는 `docs/*.md` 파일이 PR 에
> 포함되어 있지 않습니다. 로컬에서 `/api-docs` 실행 후 변경 사항을
> 반영해주세요.

### 3. `@ApiDocs` 메서드가 참조하는 **DTO** 의 필드가 변경됨

`@RequestBody`, `@ModelAttribute`, return type 으로 사용된 DTO 클래스에서:
- 필드 추가/삭제/이름변경/타입변경

이 변경의 결과는 외부 API 응답·요청 본문 스키마에 직접 영향. 사용하는 `@ApiDocs` 메서드의 `docs/*.md` 도 함께 업데이트되어야 함.

**메시지 예시**:
> `TodoResponse` 에 `overdue` 필드가 추가되었습니다. 이 DTO 를 반환하는
> `@ApiDocs` 메서드 (`getStatistics`, `getById` 등) 의 `docs/*.md` 의
> Response Body 표·Example 도 함께 점검해주세요.

### 4. `@ApiDocs(title = "...")` 의 title 변경

title 이 바뀌면 파일명도 바뀌어야 (`{slugify(title)}.md`). PR 에 기존 파일 삭제 + 신규 파일 추가 (git rename) 가 모두 포함되어 있는지 확인.

**메시지 예시**:
> `@ApiDocs(title = ...)` 의 title 이 변경되었습니다. 기존 md 파일을
> 새 파일명으로 rename 했는지 확인해주세요. rename 안 하면 publish 시
> 새 Dooray 페이지가 만들어지고 이전 페이지가 고아가 됩니다.

### 5. `docs/*.md` 가 삭제됐는데 `@ApiDocs` 는 그대로 남아있음

PR 의 changed-files 목록에서 `docs/{slug}.md` 가 **삭제** 상태(additions=0, deletions>0)이고,
해당 slug 와 매칭되는 `@*Mapping` 메서드가 여전히 `@ApiDocs` 를 가지고 있는 경우 지적.

`@ApiDocs` 와 md 는 항상 쌍으로 움직여야 정합. 한쪽만 빠지면:
- `@ApiDocs` 그대로 + md 삭제 → develop 에 md 가 없으니 신규 sync 가 못 일어나고, registry 만 stale 해질 수 있음
- 관리 페이지의 [🗑 삭제] 버튼은 *registry + Dooray 페이지만* 삭제하므로,
  `@ApiDocs` 가 남아있는 한 누군가 다시 md 를 만들면 Dooray 페이지가 부활함

**메시지 예시**:
> `getStatistics` 의 `@ApiDocs` 가 그대로인데 `docs/todo-통계-조회.md` 가 PR 에서 삭제되었습니다.
> 의도가 무엇인가요?
> - **문서화 중단** 이면 메서드의 `@ApiDocs` 도 함께 제거해주세요.
> - **잘못 삭제** 한 것이면 md 를 복원하거나 로컬에서 `/api-docs` 를 다시 실행해주세요.

## docs/*.md 는 리뷰 대상 아님

`docs/*.md` 는 토큰 부담이 커서 claude-review 의 diff 에 포함하지 않는다.
대신 Java 변경 + PR changed-files 목록(파일 경로만)으로 위의 5가지 케이스를 점검:

- Java 시그니처는 보이지만 PR 의 changed-files 목록에 매칭되는 `docs/{slug}.md` 가
  안 보이면 → "md 가 빠졌습니다" hint
- PR 의 changed-files 목록에 `docs/*.md` 가 있는지 확인은 가능 (파일 경로만)
- md 의 내용 정합성 (Parameters 표가 시그니처와 같은지 등) 은 리뷰가 직접 검토 안 함

## 점검하지 않는 케이스

- 메서드 body 내부 로직 변경 (`if` 추가, stream 연산 변경 등)
- private/inner 메서드 변경
- 단순 import / 주석 / 포매팅 변경
- 테스트 코드 변경
- docs/*.md 의 본문 내용 (리뷰에 안 들어옴)

## 파일명 슬러그 규칙 (참고)

| 조건 | 파일명 |
|---|---|
| `@ApiDocs(title = "...")` | `{slugify(title)}.md` |
| `@ApiDocs` (title 없음) | `{method-lower}-{slugify(path)}.md` |

`slugify`: 공백→하이픈, `/`→하이픈, `{}` 제거, 영문 대문자→소문자, 한글은 그대로(NFC), 특수문자 제거.

## 톤

- 강압적이지 않게. "문서화 안 한다" 라는 정책적 결정도 가능함을 인정.
- 지적은 "필요해 보입니다" / "확인해주세요" 같은 권유형.
- 본 PR 의 코드 변경이 정말 외부에 영향 있는 변경이라고 판단될 때만 지적.
