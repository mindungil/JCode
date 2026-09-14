# V2.0.1 Workspace 수명주기와 접근 정책

이 문서는 JCode V2.0.1의 Workspace, 과제, Watcher, 권한 및 배포 전환 경계를
정의합니다. 계절학기는 이번 범위에서 제외합니다. 각 저장소의 단위 테스트보다 이
문서의 불변조건과 교차 서비스 계약을 우선합니다.

## 불변조건

1. 학생의 과제 디렉터리는 NFS에 미리 존재할 수 있지만, 과제 시작 전과 마감 후에는
   학생의 Pod에 마운트되지 않아야 합니다. URL을 알고 있거나 일반 JCode로 진입해도
   결과는 같아야 합니다.
2. 학생은 `kickoff <= now < deadline`이고 강의·가입·과제가 활성 상태일 때만 자신의
   과제를 읽고 쓸 수 있습니다. 마감 시각에는 기존 WebSocket도 종료합니다.
3. 해당 강의의 교수와 조교, 그리고 전역 관리자는 과제 기간과 관계없이 학생별
   Inspector로 접근할 수 있습니다. Inspector는 과제 하나만 읽기 전용으로 마운트하고
   외부 egress를 허용하지 않습니다.
4. 전역 역할은 플랫폼 권한, `user_courses.role`은 강의 관계 권한입니다. 강의 내부
   권한은 전역 `STUDENT` 여부로 무효화하지 않습니다. 강의 생성은 전역 교수·관리자만
   허용합니다.
5. DB의 READY는 실제 Deployment, Service, Ready Pod, policy revision 및 mount hash가
   모두 관측된 경우에만 기록합니다. 리소스가 없으면 절대로 READY로 승격하지 않습니다.
6. 메타데이터 수정은 Workspace Pod를 재시작하지 않습니다. 실제 마운트 집합 또는
   런타임 Pod spec이 바뀐 JCode만 재조정합니다.
7. 외부 작업은 재시도와 중복 전달을 전제로 합니다. 같은 idempotency key의 작업은
   동시에 한 번만 실행되고, 완료 결과는 다시 요청해도 동일해야 합니다.
8. 스타터 배포·복원·보관 같은 시스템 파일 변경은 Watcher에서 학생 활동으로
   집계하지 않습니다.
9. 실패 상태에는 사용자에게 노출할 안전한 reason code, 재시도 가능 여부와 운영자용
   request id가 있어야 합니다. 내부 예외와 인프라 주소는 UI에 노출하지 않습니다.

## 권한과 기간 행렬

| 행위자 | 시작 전 | 진행 중 | 마감 후 | 과제 보관 후 |
| --- | --- | --- | --- | --- |
| 학생, 자신의 일반 JCode | 과제 미마운트 | 읽기·쓰기 | 과제 미마운트 | 과제 미마운트 |
| 학생, 과제 링크 | 거부 | 읽기·쓰기 | 거부 및 기존 세션 종료 | 거부 |
| 교수·조교, 학생 Inspector | 읽기 전용 | 읽기 전용 | 과제 ACTIVE 동안 읽기 전용 | 거부 |
| 전역 관리자, 학생 Inspector | 읽기 전용 | 읽기 전용 | 과제 ACTIVE 동안 읽기 전용 | 거부 |

역할 변경은 기존 세션에도 적용합니다. 학생에서 교수·조교로 승격하거나 반대로
강등할 때 해당 강의의 Router profile과 route를 폐기하고 Redis manager set과 DB를
커밋 후 재조정합니다. 전역 관리자 강등도 기존 관리자 세션을 폐기합니다.

## 일정 변경 행렬

| 변경 | 학생 마운트 | 기존 세션 | 최종본 |
| --- | --- | --- | --- |
| 시작 시각을 미래로 이동 | 즉시 제거 | 즉시 종료 | 영향 없음 |
| 시작 시각을 현재 이전으로 이동 | 해당 학생 Pod에 추가 | 새 세션부터 허용 | 영향 없음 |
| 진행 중 마감 연장 | 마운트 유지 | 기존 세션 종료 후 재진입 시 새 만료 시각 적용 | 영향 없음 |
| 진행 중 마감 단축 | 시각 도달 시 제거 | 시각 도달 시 종료 | 한 세대만 생성 |
| 마감 시각을 과거로 변경 | 즉시 제거 | 즉시 종료 | 한 세대만 생성 |
| 마감된 과제 재개 | 최종본 완성 확인 후 복원 | 새 세션만 허용 | 세대 증가 후 보존 |
| 설명 변경 | 변경 없음 | 유지 | 변경 없음 |
| 표시 이름 변경 | descriptor만 배치 갱신 | 유지 | 변경 없음 |

스케줄러 지연 중에도 Redirect가 현재 시각을 직접 검사하므로 권한이 넓어져서는 안
됩니다. 스케줄러는 상태와 마운트 수렴을 담당하고 Router의 만료 시각은 정확한 마감
경계를 담당합니다. 새 가입자의 Workspace에는 `SCHEDULED` 또는 `OPEN` 과제만
준비합니다. 이미 `CLOSED`인 과제를 뒤늦게 가입한 학생에게 새로 생성하거나 최종본이
있는 것처럼 표시하지 않습니다.

## 호환 가능한 적용 순서

1. 병합된 DNS 기준선 이미지를 dev에 적용하고 `ndots:2`, 내부 서비스 짧은 주소, Workspace DNS CIDR을 확인합니다.
2. 같은 Generator·Backend digest를 production에 적용해 기준선을 고정합니다.
3. Starter·archive PVC를 먼저 준비합니다.
4. 기존 Router 세션과 Generator API를 수용하는 호환 릴리스를 먼저 배포하고,
   `/health/contract`에서 `workspaceContractVersion`을 확인합니다. 호환 릴리스가 없으면
   점검 시간을 선언하고 Router·Generator·Backend를 하나의 원자적 전환 단위로 취급합니다.
   새 Backend의 배치 호출은 `X-Workspace-Batch-Protocol: 1`로 명시합니다. 이 헤더가 없는
   구 Backend 요청에는 새 Generator도 부분 완료 응답을 보내지 않습니다. 반대로 새
   Backend는 구 Generator의 contract가 확인되지 않으면 외부 작업을 성공 처리하지 않습니다.
   구 Backend는 시작 전 과제를 마운트하던 계약이므로 이 단계에서는 신규 로그인과 기존
   Workspace 접근을 Ingress에서 잠시 차단합니다. 새 Backend 전환과 policy reconcile이
   끝나기 전에는 V2.0.1의 기간 기반 비노출을 보장한다고 판단하지 않습니다.
5. `legacy-workspace-egress`를 먼저 적용한 뒤 default-deny와 신규 session-kind별 정책을
   적용합니다. 신규 Generator가 기존 Workspace를 조정해 `jcode/session-kind`를 모두
   채운 것을 확인하고 `reconcile_workspace_dns.py --finalize-legacy`로 임시 정책을 제거합니다.
6. Backend를 배포해 Flyway migration을 수행합니다. migration은 스키마와 논리
   데이터만 변환하며 외부 작업을 자동 등록하지 않습니다.
7. Backend의 `k8s/assignment-path-backfill-job.yaml` 이미지를 같은 digest로 고정한 뒤 Job을 실행합니다. Production처럼 Namespace가 정리된 환경에서만 `missing-namespace=archive`를 명시합니다.
8. Job 완료 후 기존 과제의 `MIGRATE_ASSIGNMENT_PATH`와 `ARCHIVE_FINAL_SUBMISSION` operation이 모두 성공했는지 확인합니다.
9. operation 완료 후 Frontend를 배포합니다.
10. 신규 v3 profile 발급, 기존 세션 만료, 전 Workspace 레이블 및 NetworkPolicy
    적용을 확인한 후에만 구버전 호환 경로를 제거합니다.

Backfill Job은 활성 강의의 Namespace와 course-id 소유권을 Generator에서 확인합니다. 존재하는 활성 강의만 경로 전환 작업을 등록하고, 종료 강의 또는 명시적으로 archive를 선택한 누락 Namespace의 과제는 `ARCHIVED`로 전환합니다. 같은 Job을 다시 실행해도 operation은 중복 등록되지 않습니다.

환경 프로필 → 과제 식별자 → 스타터 원본 → 삭제·보관 순서는 바꾸지 않습니다.

## 소스와 클러스터의 경계

GitHub에는 상태 모델, API 계약, migration, Generator 파일 처리, Deployment·NetworkPolicy·CronJob 원본을 둡니다. Kubernetes에는 PVC 실제 규격, StorageClass, 이미지 digest, NFS 주소, 자원 프로필 JSON, Secret을 둡니다.

필수 PVC 이름은 다음과 같습니다.

- `jcode-vol-pvc`: 학생 Workspace
- `jcode-starter-pvc`: 과제 버전별 ZIP 원본
- `jcode-archive-pvc`: 최종 작업물과 탈퇴·삭제 보관본

세 PVC는 production Generator 2개가 함께 접근하므로 `ReadWriteMany`가 필요합니다. Starter·archive PVC는 UID/GID 1000이 읽고 쓸 수 있어야 하며, 서로 다른 PVC 사이의 이동은 임시 복사 완료 후 원본을 정리합니다. 원본과 보관본이 동시에 남은 비정상 상태에서는 자동 삭제하지 않고 작업을 실패시켜 수동 확인이 가능하게 합니다.

`WORKSPACE_RESOURCE_PROFILES_JSON`은 `STANDARD`, `HIGH_MEMORY`, `GPU` 각각의 requests와 limits를 포함해야 합니다. 실제 수치는 환경별 ConfigMap에서 관리합니다.

## 상태 전이

- 과제: `PROVISIONING → ACTIVE → DELETING → ARCHIVED`, 실패 시 `PROVISION_FAILED`
- 일정: `SCHEDULED → OPEN → CLOSED → ARCHIVED`
- 가입: `PROVISIONING → READY → DELETE_PENDING → ARCHIVED`, 실패 상태에서 재시도 가능
- JCode: `PROVISIONING → READY → DELETE_PENDING → ARCHIVED`, 실패 상태에서 재시도 가능

외부 작업은 DB 상태를 먼저 기록한 뒤 `workspace_operation`이 처리합니다. 모든 Generator 요청은 같은 요청을 다시 보내도 결과가 달라지지 않아야 합니다.

`MISSING`은 성공 상태가 아닙니다. 생성 대상이면 `PROVISIONING`으로 되돌려 생성 작업을
등록하고, 삭제 대상일 때만 정상적인 부재로 처리합니다. 최종본 보관이 특정 JCode의
수렴을 기다리다가 해당 JCode가 실패하면 최종 보관 작업도 재시도 가능한 실패로
전환합니다. UI에는 안전한 오류 문구와 재시도 동작만 제공하고 내부 JCode id와 인프라
예외는 운영 로그에서 request id로 추적합니다.

## 부하와 부분 실패

- 과제 단위 작업은 학생 수에 비례하므로 한 HTTP 요청에서 최대
  `WORKSPACE_OPERATION_BATCH_SIZE`명, `WORKSPACE_OPERATION_BATCH_SECONDS`까지만 처리합니다.
  Generator는 공유 NFS의 idempotency 원장과 학생별 잠금을 사용하고 Backend는
  `completed=false`를 재시도 실패가 아닌 진행 중 상태로 다룹니다.
- `REPLACE_ALL`은 기존 디렉터리를 먼저 지우지 않습니다. 새 디렉터리를 완성하고 소유권과
  검증을 마친 뒤 원자적으로 교환합니다.
- PostgreSQL을 수업 역할의 원본으로 사용합니다. 관리자 승격 캐시는 DB 커밋 후
  게시하고, 강등은 기존 profile과 캐시를 먼저 폐기하는 fail-closed 순서를 사용합니다.
  Redis 캐시는 30초 주기의 DB 기반 동기화로 최종 수렴합니다. Workspace route 폐기는
  정책 revision 변경과 함께 보수적으로 먼저 수행하므로 부분 실패가 과권한으로
  이어지지 않습니다.
- Watcher 수집기는 Workspace 루트의 `.jcode-system-mutations`에 기록된 스타터·경로
  이관·복원·보관·탈퇴 marker를 기준선 변경으로 처리하고 학생 이벤트를 만들지 않습니다.
- Watcher 조회 API도 서비스 간 인증을 요구합니다. 학생에게 제공하는 집계에는 다른
  학생의 실제 학번이나 이메일을 포함하지 않습니다.
- 수집 spool의 내구성은 노드 수명보다 길어야 합니다. hostPath를 유지할 경우 Pod를 같은
  노드에 고정하고 노드 폐기 전 drain 검사를 강제하며, 무손실이 요구되면 PVC 또는 외부
  durable queue로 전환합니다.

## 스타터와 보관 정책

스타터 ZIP은 학생 폴더에 바로 저장하지 않습니다. `assignments/{assignmentId}/starter/v{version}.zip`에 원본을 보관하고 SHA-256을 DB에 기록합니다.

- `PRESERVE_EXISTING`: 기존 학생 파일을 유지하고 없는 파일만 추가
- `REPLACE_ALL`: 과제 폴더를 지우고 해당 버전으로 교체

마감 시 과제 폴더의 세대별 불변 사본을 final archive에 만든 뒤 학생 Pod의 마운트를
제거해 기존 IDE의 쓰기를 차단합니다. 실제 Workspace 경로는 남아 있어도 선택적 subPath
마운트 밖이므로 학생에게 보이거나 접근되지 않습니다. 재개방은 final archive가 확인된
과제만 다시 마운트합니다. 삭제와 탈퇴 보관본에는 보관 만료 정보가 기록되고 CronJob이
만료된 경로만 정리합니다.

## 배포 확인

- 세 환경 프로필 생성과 Pod spec 확인
- 기존 과제 경로의 파일 유지 및 `assignment-{id}` 전환
- 선가입·후가입 학생의 동일 스타터 버전 확인
- 과제명 변경 후 Workspace 유지
- Generator 실패 후 재시도와 상태 복구
- 마감, 재개방, 과제 보관, 탈퇴·강제탈퇴
- 설명 변경 시 Pod UID 유지, 실제 마운트 변경 시 대상 Pod만 교체
- 기존 v2 profile과 신규 v3 profile의 호환 전환 또는 선언된 점검 시간 확인
- Deployment 유실 시 거짓 READY가 아닌 자동 재생성 확인
- Redis·PostgreSQL·Generator 각각의 부분 실패 후 최종 수렴 확인
- 스타터 배포 전후 Watcher 활동량 불변 확인
- 학생·조교·교수·관리자 조합과 전역 역할 변경 후 기존 세션 폐기 확인
- 수백 명 동시 Redirect와 과제 전환 시 operation backlog, DB pool, Generator 처리율 확인
- dev에서 확인한 Generator·Backend·Frontend digest를 production에 그대로 적용

실제 PVC 용량, StorageClass, NFS endpoint, Secret과 환경별 digest는 이 저장소에 고정하지 않습니다. 배포 담당자는 위 검증을 전용 smoke 강의에서 수행하고 release manifest에 결과를 남겨야 합니다.
